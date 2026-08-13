import { db } from './db'
import { sessionMetaMap } from './instance-sessions'
import { readOpenCodeSession } from './opencode-sessions'
import {
  decodeProjectKey,
  ensureTranscriptIndex,
  eventToTailEventsForSource,
  isCommandWrapperText,
  listTranscriptFiles,
  listTranscriptFilesAfterMiss,
  type TranscriptFile,
  unwrapTaggedText,
} from './transcript'
import type {
  ArchivedScope,
  DispatchedScope,
  QueueStatus,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
} from './types'

function toEpoch(ts: unknown): number | null {
  if (typeof ts !== 'string') return null
  const n = Date.parse(ts)
  return Number.isNaN(n) ? null : n
}

function oneLine(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

interface ScannedMeta {
  title: string
  cwd: string
  git_branch: string | null
  message_count: number
  created_at: number | null
  last_activity_at: number
  last_role: 'user' | 'assistant' | null
  last_text_preview: string | null
  /** Turns that are neither CLI bookkeeping nor command plumbing — see transcript.hasSubstance.
   *  Zero means the transcript only ever held scaffolding, so there is nothing to list. */
  substantive_turns: number
}

// One entry per transcript. Keeping mtime in the value (instead of in the Map key) makes an active
// transcript replace its old parse rather than leaking one cache entry on every appended turn.
const metaCache = new Map<string, { mtimeMs: number; meta: ScannedMeta }>()

// L2 behind that map: the same parse, persisted (see the session_scan_cache comment in db.ts). The
// in-memory map alone meant every daemon restart re-parsed the whole visible list before answering.
interface ScanCacheRow extends ScannedMeta {
  mtime_ms: number
  size_bytes: number
}
const selectScan = db.query<ScanCacheRow, [string]>(
  'select mtime_ms, size_bytes, title, cwd, git_branch, message_count, created_at, ' +
    'last_activity_at, last_role, last_text_preview, substantive_turns ' +
    'from session_scan_cache where cache_key = ?',
)
const upsertScan = db.query(
  'insert into session_scan_cache (cache_key, path, mtime_ms, size_bytes, title, cwd, git_branch, ' +
    'message_count, created_at, last_activity_at, last_role, last_text_preview, ' +
    'substantive_turns, scanned_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'on conflict(cache_key) do update set path = excluded.path, mtime_ms = excluded.mtime_ms, ' +
    'size_bytes = excluded.size_bytes, title = excluded.title, cwd = excluded.cwd, ' +
    'git_branch = excluded.git_branch, message_count = excluded.message_count, ' +
    'created_at = excluded.created_at, last_activity_at = excluded.last_activity_at, ' +
    'last_role = excluded.last_role, last_text_preview = excluded.last_text_preview, ' +
    'substantive_turns = excluded.substantive_turns, scanned_at = excluded.scanned_at',
)

function cacheKey(tf: TranscriptFile): string {
  // OpenCode sessions all point at one database path, and two rows can share a millisecond update
  // timestamp. Provider + id are therefore part of the cache identity, not just path + mtime.
  return `${tf.source}:${tf.session_id}:${tf.path}`
}

/** Persisted parse for this exact file revision, or null. Size joins mtime in the check because a
 *  rewrite that preserves mtime still changes length, and reading a stale title is worse than a
 *  re-parse. */
function readScanCache(tf: TranscriptFile, key: string): ScannedMeta | null {
  const row = selectScan.get(key)
  if (!row || row.mtime_ms !== tf.mtime_ms || row.size_bytes !== tf.size_bytes) return null
  return {
    title: row.title,
    cwd: row.cwd,
    git_branch: row.git_branch,
    message_count: row.message_count,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    last_role: row.last_role,
    last_text_preview: row.last_text_preview,
    substantive_turns: row.substantive_turns,
  }
}

function rememberScan(tf: TranscriptFile, key: string, meta: ScannedMeta): ScannedMeta {
  metaCache.set(key, { mtimeMs: tf.mtime_ms, meta })
  try {
    upsertScan.run(
      key,
      tf.path,
      tf.mtime_ms,
      tf.size_bytes,
      meta.title,
      meta.cwd,
      meta.git_branch,
      meta.message_count,
      meta.created_at,
      meta.last_activity_at,
      meta.last_role,
      meta.last_text_preview,
      meta.substantive_turns,
      Date.now(),
    )
  } catch {
    // A cache write must never fail a list. Worst case this row is re-parsed next time.
  }
  return meta
}

// Scans currently running, so the same file revision is never parsed twice at once. Three things
// overlap in practice — the boot warm-up, the UI's 12-second poll, and whatever the user just
// clicked — and without this they each opened their own copy of the same 12 MB transcript.
// Measured: the first request after a restart took 9.3 s racing the warm-up, and 0.4 s once the two
// shared their work.
const inFlight = new Map<string, Promise<ScannedMeta>>()

function scanMeta(tf: TranscriptFile): Promise<ScannedMeta> {
  const key = cacheKey(tf)
  const cached = metaCache.get(key)
  if (cached?.mtimeMs === tf.mtime_ms) return Promise.resolve(cached.meta)
  const persisted = readScanCache(tf, key)
  if (persisted) {
    metaCache.set(key, { mtimeMs: tf.mtime_ms, meta: persisted })
    return Promise.resolve(persisted)
  }
  // Keyed by file revision, so a transcript that gains a turn mid-flight starts a fresh scan rather
  // than joining the one that is already reading the previous revision.
  const revision = `${key}@${tf.mtime_ms}:${tf.size_bytes}`
  const running = inFlight.get(revision)
  if (running) return running
  const started = parseMeta(tf, key).finally(() => inFlight.delete(revision))
  inFlight.set(revision, started)
  return started
}

async function parseMeta(tf: TranscriptFile, key: string): Promise<ScannedMeta> {
  if (tf.source === 'opencode') {
    const content = readOpenCodeSession(tf.session_id)
    const textEvents = (content?.events ?? []).filter((event) => event.kind === 'text')
    const first = textEvents[0]
    const last = textEvents.at(-1)
    const meta: ScannedMeta = {
      title: oneLine(tf.title || first?.text || tf.session_id, 120),
      cwd: tf.cwd || '',
      git_branch: null,
      message_count: content?.messageCount ?? 0,
      created_at: tf.created_at ?? null,
      last_activity_at: tf.mtime_ms,
      last_role: last?.role ?? null,
      last_text_preview: last ? oneLine(last.text) : null,
      substantive_turns: textEvents.length,
    }
    return rememberScan(tf, key, meta)
  }

  // read up to the last 12 MB — covers effectively every real transcript
  const file = Bun.file(tf.path)
  const start = Math.max(0, file.size - 12 * 1024 * 1024)
  const text = start > 0 ? await file.slice(start).text() : await file.text()

  let customTitle = ''
  let aiTitle = ''
  let lastPrompt = ''
  let firstUser = ''
  let cwd = ''
  let gitBranch: string | null = null
  let messageCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let lastRole: 'user' | 'assistant' | null = null
  let lastPreview: string | null = null
  let substantive = 0

  // Walked by index rather than `text.split('\n')`: on a 12 MB transcript that split materialises
  // ~100k line strings and holds every one of them alive for the whole loop, roughly doubling the
  // peak for a file we only ever look at one line at a time.
  for (let pos = 0; pos < text.length; ) {
    let nl = text.indexOf('\n', pos)
    if (nl === -1) nl = text.length
    const line = text.slice(pos, nl)
    pos = nl + 1
    const l = line.trim()
    if (!l) continue
    let ev: any
    try {
      ev = JSON.parse(l)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'custom-title':
        if (typeof ev.customTitle === 'string') customTitle = ev.customTitle
        continue
      case 'ai-title':
        if (typeof ev.aiTitle === 'string') aiTitle = ev.aiTitle
        continue
      case 'last-prompt':
        // Same rule as firstUser below: a slash command's `<command-name>` echo lands here too,
        // and it describes the plumbing rather than the work.
        if (typeof ev.lastPrompt === 'string' && !isCommandWrapperText(ev.lastPrompt))
          lastPrompt = ev.lastPrompt
        continue
    }
    if (typeof ev.cwd === 'string' && !cwd) cwd = ev.cwd
    if (typeof ev.payload?.cwd === 'string' && !cwd) cwd = ev.payload.cwd
    if (typeof ev.gitBranch === 'string' && ev.gitBranch) gitBranch = ev.gitBranch

    const role = ev.message?.role ?? ev.type
    const tes = eventToTailEventsForSource(tf.source, ev)
    const isClaudeMessage = role === 'user' || role === 'assistant'
    const isCodexMessage =
      tf.source === 'codex' &&
      ev.type === 'response_item' &&
      ev.payload?.type === 'message' &&
      (ev.payload?.role === 'user' || ev.payload?.role === 'assistant')
    if (isClaudeMessage || isCodexMessage) {
      if (isCodexMessage && tes.length === 0) continue
      messageCount++
      const t = toEpoch(ev.timestamp)
      if (t !== null) {
        if (firstTs === null) firstTs = t
        lastTs = t
      }
      // eventToTailEvents is the ONE place that knows what is real: it drops thinking blocks and
      // the CLI's own resume bookkeeping (isMeta / <synthetic> self-talk). Reading
      // `ev.message.content` straight off the event bypassed all of that, which is exactly how the
      // `isMeta` local-command caveat became the title of 103 of the newest 200 sessions.
      const real = tes.filter((e) => e.text && !isCommandWrapperText(e.text))
      if (real.length > 0) substantive++
      const visibleRole = isCodexMessage ? ev.payload.role : role
      if (!firstUser && visibleRole === 'user') {
        firstUser = real.find((e) => e.kind === 'text')?.text ?? ''
      }
      const textEv = [...tes].reverse().find((e) => e.kind === 'text')
      if (textEv) {
        lastRole = textEv.role
        lastPreview = oneLine(textEv.text)
      } else if (tes.length > 0) {
        lastRole = role
        lastPreview = lastPreview ?? oneLine(tes[tes.length - 1].text)
      }
    }
  }

  // unwrapTaggedText only touches the two derived-from-a-turn sources: an explicit custom/AI title
  // is already a label and must never be second-guessed.
  const derived = unwrapTaggedText(lastPrompt || firstUser || '')
  const title = oneLine(customTitle || aiTitle || tf.title || derived || tf.session_id, 120)
  const meta: ScannedMeta = {
    title,
    cwd: cwd || decodeProjectKey(tf.project),
    git_branch: gitBranch,
    message_count: messageCount,
    created_at: firstTs,
    last_activity_at: lastTs ?? tf.mtime_ms,
    last_role: lastRole,
    last_text_preview: lastPreview,
    substantive_turns: substantive,
  }
  return rememberScan(tf, key, meta)
}

/**
 * How many transcripts may be in flight at once inside one list.
 *
 * This used to be `Promise.all(batch.map(...))` over the whole batch, i.e. up to 200 files opened
 * together — and since each one holds up to a 12 MB tail plus its parsed lines, the peak was the
 * SUM of all 200. Measured on a real store: one cold /api/sessions call took the daemon from 101 MB
 * to 3.1 GB resident. The reads are disk-bound, so a dozen at a time is no slower in wall clock; it
 * just stops the list from being a memory bomb.
 */
export const SCAN_CONCURRENCY = 12

/** Promise.all with a ceiling on how many run at once. Results stay in input order.
 *  Exported only so the regression test can prove the ceiling is real — nothing else imports it. */
export async function mapPooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

/** Map of session_id -> most-relevant queue status (running/queued win over terminal). */
function queueStatusMap(): Map<string, QueueStatus> {
  const rows = db
    .query<{ session_id: string; status: QueueStatus }, []>(
      'select session_id, status from queue_items order by created_at asc',
    )
    .all()
  const rank: Record<QueueStatus, number> = {
    running: 7,
    queued: 6,
    rate_limited: 5,
    // Just under rate_limited: both mean "stopped at a wall, not finished", but a spent quota is the
    // more useful thing to surface when a session carries both.
    overloaded: 4,
    failed: 3,
    completed: 2,
    canceled: 1,
  }
  const map = new Map<string, QueueStatus>()
  for (const r of rows) {
    const prev = map.get(r.session_id)
    if (!prev || rank[r.status] >= rank[prev]) map.set(r.session_id, r.status)
  }
  return map
}

/** Map of session_id -> the user's own "done" mark (session_marks table). */
function doneMarkMap(): Map<string, boolean> {
  const rows = db
    .query<{ session_id: string; done: number }, []>('select session_id, done from session_marks')
    .all()
  const map = new Map<string, boolean>()
  for (const r of rows) map.set(r.session_id, !!r.done)
  return map
}

/**
 * List the newest transcripts, optionally scoped to one instance BEFORE the cap:
 * `instance` = an instance dir name, "default" (non-isolated install), or "other"
 * (unmapped, i.e. plain CLI). Filtering first matters — with thousands of transcripts
 * in the shared store, a quiet instance's sessions would never crack the newest-200.
 *
 * `archived` gets the same before-the-cap treatment as `instance`, and for the same
 * reason: a window full of archived rows would otherwise starve the newest-N of live ones,
 * and 'only' would surface almost nothing if the cap ran first.
 * Archived is Claude Desktop's own read-only flag; it never depends on `done`, which is a
 * mark only and must never filter a session out of this list.
 *
 * `sinceMs` is the same idea one step further: an epoch cutoff on last activity, applied to the
 * cheap mtime index before anything is parsed. Null means no cutoff.
 *
 * Transcripts with no substantive turn are dropped unconditionally (no scope opts back into them).
 * They are not short sessions, they are CLI scaffolding — a `/usage` probe writes a caveat, a
 * `<command-name>` line and nothing else. On this machine that was 127 of the newest 300, all ~3 KB
 * and all titled with the same caveat banner. Since that verdict needs a parse, the scan runs in
 * batches and keeps pulling until it has `limit` real sessions, rather than capping first and
 * returning a short list full of holes.
 */
export async function listSessions(
  limit = 200,
  instance?: string,
  archived: ArchivedScope = 'hide',
  sinceMs: number | null = null,
  source: SessionSourceScope = 'all',
  dispatched: DispatchedScope = 'all',
): Promise<SessionSummary[]> {
  const mmap = sessionMetaMap()
  // Read up here rather than beside dmap below, because the `dispatched` scope filters on it and
  // that has to happen before the newest-N cap.
  const qmap = queueStatusMap()
  // Async on purpose: this handler is already async, and on a cold cache the sync builder blocks
  // the whole daemon for the length of a full store sweep. ensureTranscriptIndex also coalesces
  // with the boot warm-up, so the first request after launch joins that build instead of racing it.
  let files = await ensureTranscriptIndex()
  if (source !== 'all') files = files.filter((file) => file.source === source)
  if (instance) {
    files = files.filter((f) =>
      instance === 'other'
        ? f.source === 'claude' && !mmap.has(f.session_id)
        : f.source === 'claude' && mmap.get(f.session_id)?.instance === instance,
    )
  }
  if (archived !== 'include') {
    const want = archived === 'only'
    files = files.filter((f) => (f.archived || !!mmap.get(f.session_id)?.archived) === want)
  }
  if (sinceMs !== null) files = files.filter((f) => f.mtime_ms >= sinceMs)
  // Before the cap, for the same reason `instance` and `archived` are: a handful of queued runs
  // among thousands of hand-driven transcripts would never crack the newest-200, so a filter applied
  // afterwards would answer "you have never queued anything" on a machine that queues nightly.
  if (dispatched !== 'all') {
    const want = dispatched === 'queued'
    files = files.filter((f) => (f.source === 'claude' && qmap.has(f.session_id)) === want)
  }
  files = files.sort((a, b) => b.mtime_ms - a.mtime_ms)
  const dmap = doneMarkMap()

  const toSummary = async (tf: TranscriptFile): Promise<SessionSummary | null> => {
    const m = await scanMeta(tf)
    if (m.substantive_turns === 0) return null
    // The mtime pass above is a cheap SUPERSET (writing a turn always touches the file, so mtime is
    // never older than the last activity). It is not exact, though: a transcript can be touched
    // without gaining a timestamped turn, which put rows reading "2d ago" inside a "Last 24 hours"
    // window. Re-check against the timestamp the row actually DISPLAYS, now that it is parsed.
    if (sinceMs !== null && m.last_activity_at < sinceMs) return null
    return {
      session_id: tf.session_id,
      source: tf.source,
      tool: toolIdOf(tf),
      title: m.title,
      cwd: m.cwd,
      project: tf.project,
      git_branch: m.git_branch,
      message_count: m.message_count,
      created_at: m.created_at,
      last_activity_at: m.last_activity_at,
      last_role: m.last_role,
      last_text_preview: m.last_text_preview,
      size_bytes: tf.size_bytes,
      transcript_path: tf.path,
      queue_status: tf.source === 'claude' ? (qmap.get(tf.session_id) ?? null) : null,
      instance: tf.source === 'claude' ? (mmap.get(tf.session_id)?.instance ?? null) : null,
      archived: tf.archived || (mmap.get(tf.session_id)?.archived ?? false),
      done: dmap.get(sessionMarkKey(tf.source, tf.session_id)) ?? false,
      dispatched: tf.source === 'claude' && qmap.has(tf.session_id),
    }
  }

  // Batched so a run of stubs costs extra parses only when it actually occurs: a store with no
  // scaffolding in it parses exactly `limit` files, the same as before.
  const out: SessionSummary[] = []
  for (let cursor = 0; cursor < files.length && out.length < limit; ) {
    const batch = files.slice(cursor, cursor + (limit - out.length))
    cursor += batch.length
    const scanned = await mapPooled(batch, SCAN_CONCURRENCY, toSummary)
    for (const s of scanned) if (s) out.push(s)
  }
  out.sort((a, b) => b.last_activity_at - a.last_activity_at)
  return out
}

/**
 * Which product wrote a session, as an agent-catalog.ts id.
 *
 * `source` names the FORMAT and several products share one — OpenClaude writes Claude Code's JSONL,
 * TraeX writes Codex's rollouts, Kilo writes OpenCode's SQLite. Falling back to the store that owns
 * the format keeps every pre-existing row answering exactly what it did before: a `claude` session
 * with no tool recorded IS Claude Code.
 */
function toolIdOf(tf: TranscriptFile): string {
  if (tf.tool) return tf.tool
  return tf.source === 'claude' ? 'claude-code' : tf.source
}

export function sessionMarkKey(source: SessionSource, sessionId: string): string {
  return source === 'claude' ? sessionId : `${source}:${sessionId}`
}

/**
 * Fill session_scan_cache for the newest transcripts in the background, and drop rows for files
 * that no longer exist.
 *
 * The cache makes a restart warm, but only for transcripts it already saw — the very first list
 * after an install (or after a heavy day of new sessions) is still the expensive one, and it is
 * expensive at exactly the moment the user is staring at an empty list. Doing it here moves that
 * cost off the request: the daemon starts serving immediately, and this runs alongside so the list
 * is usually already warm by the time anyone opens the UI. Nothing awaits it and nothing fails if
 * it doesn't finish.
 */
export async function warmSessionScanCache(newest = 400): Promise<void> {
  // The ASYNC builder, not listTranscriptFiles(): this runs immediately after Bun.serve, so a
  // blocking sweep here would leave the port bound but unanswerable for the length of the scan —
  // the browser's first GET would queue behind it. See buildTranscriptIndexAsync.
  const files = await ensureTranscriptIndex(true)

  // Prune first, so a store that churns transcripts doesn't accumulate rows forever. Cheaper than it
  // looks: one indexed read of the key column against an in-memory set of the paths we just globbed.
  try {
    const live = new Set(files.map((f) => f.path))
    const dead = db
      .query<{ cache_key: string; path: string }, []>(
        'select cache_key, path from session_scan_cache',
      )
      .all()
      .filter((r) => !live.has(r.path))
    if (dead.length) {
      const del = db.query('delete from session_scan_cache where cache_key = ?')
      db.transaction(() => {
        for (const r of dead) del.run(r.cache_key)
      })()
    }
  } catch {
    // Best-effort housekeeping; a failed prune must never stop the warm-up below.
  }

  const batch = [...files].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, newest)
  // Half the request-path width: this is speculative work, and a request that arrives mid-warm-up
  // should be able to overtake it. It never duplicates that request's work — scanMeta's in-flight
  // map means the two share whichever file they both want.
  await mapPooled(batch, Math.max(1, Math.floor(SCAN_CONCURRENCY / 2)), async (tf) => {
    try {
      await scanMeta(tf)
    } catch {
      // An unreadable transcript just stays uncached; the list handles it the same way it always did.
    }
  })
}

export async function getSession(
  sessionId: string,
  source?: SessionSource,
): Promise<SessionSummary | null> {
  // Same stale-snapshot caveat as findTranscript: only a MISS can be wrong, so re-sweep before
  // reporting one.
  const match = (files: ReturnType<typeof listTranscriptFiles>) =>
    files.find((f) => f.session_id === sessionId && (!source || f.source === source))
  const tf = match(listTranscriptFiles()) ?? match(listTranscriptFilesAfterMiss())
  if (!tf) return null
  const m = await scanMeta(tf)
  const qmap = queueStatusMap()
  const dmap = doneMarkMap()
  const meta = sessionMetaMap().get(tf.session_id)
  return {
    session_id: tf.session_id,
    source: tf.source,
    tool: toolIdOf(tf),
    title: m.title,
    cwd: m.cwd,
    project: tf.project,
    git_branch: m.git_branch,
    message_count: m.message_count,
    created_at: m.created_at,
    last_activity_at: m.last_activity_at,
    last_role: m.last_role,
    last_text_preview: m.last_text_preview,
    size_bytes: tf.size_bytes,
    transcript_path: tf.path,
    queue_status: tf.source === 'claude' ? (qmap.get(tf.session_id) ?? null) : null,
    instance: tf.source === 'claude' ? (meta?.instance ?? null) : null,
    archived: tf.archived || (meta?.archived ?? false),
    done: dmap.get(sessionMarkKey(tf.source, sessionId)) ?? false,
    dispatched: tf.source === 'claude' && qmap.has(tf.session_id),
  }
}
