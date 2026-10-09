import { join } from 'node:path'
import { markSessionGone } from './analytics'
import { climayteEffortBySession, climayteTasksBySession } from './climayte-effort'
import { chatsFromElsewhere, type ElsewhereChat } from './core/desktop-chat-sync'
import { allInstanceNumbers, instanceRef } from './core/instance-numbers'
import { mapPool } from './core/map-pool'
import { defaultClaudeUserDataDir, instancesRoot } from './core/paths'
import { db } from './db'
import { readDshSession } from './dsh-sessions'
import { readForeignSession } from './foreign-sessions'
import { readHermesSession } from './hermes-sessions'
import { hswarmRunsBySessionPrefix, readHSwarmSession } from './hswarm-sessions'
import {
  originInstances,
  resolveInstanceByOrigin,
  retiredSessionIds,
  type SessionMeta,
  sessionMetaMap,
} from './instance-sessions'
import { readOpenCodeSession } from './opencode-sessions'
import { createLimitStopTracker, type LimitStop, type SessionLimitStop } from './rate-limit-signal'
import { classifyEnding, endingEventText, type SessionEnding } from './session-ending'
import { makeLocator, storeKeyOf } from './session-locator'
import {
  parseArchivedScope,
  parseDispatchedScope,
  parseInstanceScope,
  parseRateLimitScope,
  parseSourceScope,
  type RateLimitState,
  type ScopeInput,
} from './session-scopes'
import {
  decodeProjectKey,
  describeTaggedText,
  ensureTranscriptIndex,
  eventToTailEventsForSource,
  findTranscriptAsync,
  instanceScopeMatches,
  isCommandWrapperText,
  listTranscriptFiles,
  type TranscriptFile,
} from './transcript'
import type {
  ProjectSummary,
  QueueStatus,
  SessionSource,
  SessionSummary,
  TailEvent,
  TitleSource,
} from './types'
import { parseResetTime } from './usage'

/**
 * Bump whenever parseMeta learns to extract something new.
 *
 * A cached scan is trusted on mtime+size alone, so without this stamp every row written by an
 * older scanner would answer a newly added field with NULL forever — and for `limit_stop` a NULL
 * is not "unknown", it reads as "this session never hit a usage wall". That is a silent wrong
 * answer, which is worse than a slow one: bumping this turns those rows into ordinary cache misses
 * and they re-parse once, exactly like a transcript that changed on disk.
 *
 * 1 → the original scan. 2 → adds limit_stop (usage-wall detection) and title provenance.
 * 3 → adds thread_key, the first message's uuid, which identifies the CONVERSATION.
 * 4 → adds ended_because, why the transcript stopped.
 * 5 → adds model and effort, the newest assistant turn's model and the recorded effort level.
 * 6 → effort also reads the `effort` / `perTurnEffort` Claude stamps on every assistant event; rows
 *     cached at 5 answered NULL for transcripts that do carry it.
 */
const SCAN_VERSION = 6

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
  /** The provider's own report that this conversation hit a QUOTA wall, or null. See
   *  createLimitStopTracker in rate-limit-signal.ts — the judgment is shared with the auto-resume
   *  monitor rather than re-implemented here. */
  limit_stop: LimitStop | null
  /** Which of the four title sources won, and (for an envelope) the tag that supplied the name. */
  title_source: TitleSource
  title_tag: string | null
  /** The uuid of the first message in this transcript. Two transcripts that open with the same
   *  message are the same conversation — see SessionSummary.copy_count. Null when the file has no
   *  message uuid at all (the store does not write them, or the transcript is empty). */
  thread_key: string | null
  /** What ended this transcript. See session-ending.ts. Null for the stores whose records carry no
   *  such markers, and for a transcript with nothing meaningful in it. */
  ended_because: SessionEnding | null
  /** The model of the newest assistant turn as the transcript records it, or null. */
  model: string | null
  /** The thinking/effort level when the transcript records one, else null. */
  effort: string | null
}

// One entry per transcript. Keeping mtime in the value (instead of in the Map key) makes an active
// transcript replace its old parse rather than leaking one cache entry on every appended turn.
// Size rides along with mtime (audit AH-36): the persisted L2 and the in-flight key already treat
// a revision as mtime+size, and this map alone did not - so an append that landed inside the same
// timestamp tick (coarse filesystems, a same-millisecond rewrite) kept serving the parse of the
// shorter file until something else happened to bump the mtime.
const metaCache = new Map<string, { mtimeMs: number; sizeBytes: number; meta: ScannedMeta }>()

// L2 behind that map: the same parse, persisted (see the session_scan_cache comment in db.ts). The
// in-memory map alone meant every daemon restart re-parsed the whole visible list before answering.
//
// The persisted shape is FLAT where ScannedMeta is nested: sqlite has no object column, so
// `limit_stop` is stored as its three parts and reassembled on read.
interface ScanCacheRow
  extends Omit<
    ScannedMeta,
    | 'limit_stop'
    | 'title_source'
    | 'title_tag'
    | 'thread_key'
    | 'ended_because'
    | 'model'
    | 'effort'
  > {
  mtime_ms: number
  size_bytes: number
  limit_notice: string | null
  limit_pending: number | null
  limit_at: number | null
  title_source: string | null
  title_tag: string | null
  thread_key: string | null
  ended_because: string | null
  model: string | null
  effort: string | null
  scan_version: number | null
}
const selectScan = db.query<ScanCacheRow, [string]>(
  'select mtime_ms, size_bytes, title, cwd, git_branch, message_count, created_at, ' +
    'last_activity_at, last_role, last_text_preview, substantive_turns, ' +
    'limit_notice, limit_pending, limit_at, title_source, title_tag, thread_key, ' +
    'ended_because, model, effort, scan_version ' +
    'from session_scan_cache where cache_key = ?',
)
const upsertScan = db.query(
  'insert into session_scan_cache (cache_key, path, mtime_ms, size_bytes, title, cwd, git_branch, ' +
    'message_count, created_at, last_activity_at, last_role, last_text_preview, ' +
    'substantive_turns, limit_notice, limit_pending, limit_at, title_source, title_tag, ' +
    'thread_key, ended_because, model, effort, scan_version, scanned_at) ' +
    'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'on conflict(cache_key) do update set path = excluded.path, mtime_ms = excluded.mtime_ms, ' +
    'size_bytes = excluded.size_bytes, title = excluded.title, cwd = excluded.cwd, ' +
    'git_branch = excluded.git_branch, message_count = excluded.message_count, ' +
    'created_at = excluded.created_at, last_activity_at = excluded.last_activity_at, ' +
    'last_role = excluded.last_role, last_text_preview = excluded.last_text_preview, ' +
    'substantive_turns = excluded.substantive_turns, limit_notice = excluded.limit_notice, ' +
    'limit_pending = excluded.limit_pending, limit_at = excluded.limit_at, ' +
    'title_source = excluded.title_source, title_tag = excluded.title_tag, ' +
    'thread_key = excluded.thread_key, ended_because = excluded.ended_because, ' +
    'model = excluded.model, effort = excluded.effort, scan_version = excluded.scan_version, scanned_at = excluded.scanned_at',
)

/**
 * Every session the cache ALREADY knows stopped at a usage wall, as cache keys.
 *
 * This is what makes the "stopped by a usage limit" scope affordable. The verdict needs a parse, so
 * it cannot join the cheap mtime-index filters that run before the newest-N cap — but a parse that
 * already happened is a sqlite row, and after the boot warm-up that is nearly the whole store. So
 * the scope pre-filters to (known-limited ∪ never-scanned) and lets the ordinary parse settle the
 * unscanned remainder, instead of re-reading a thousand transcripts to find nine.
 */
const selectLimitedKeys = db.query<{ cache_key: string }, [number]>(
  'select cache_key from session_scan_cache where limit_notice is not null and scan_version >= ?',
)
const selectScannedKeys = db.query<{ cache_key: string }, [number]>(
  'select cache_key from session_scan_cache where scan_version >= ?',
)

/**
 * cache key -> the conversation it belongs to, for every transcript already scanned.
 *
 * Read as one query rather than per row because the answer is needed BEFORE the newest-N cap: a
 * conversation's other copies are ordinary rows that may or may not be inside the current window,
 * and a count taken over the page alone would tell a row it is the only copy whenever its twin
 * happened to fall outside. Rows not yet scanned simply have no key and are left ungrouped, which
 * reads as "one copy" — the same answer they gave before this existed.
 */
const selectThreadKeys = db.query<{ cache_key: string; thread_key: string }, [number]>(
  'select cache_key, thread_key from session_scan_cache ' +
    'where thread_key is not null and scan_version >= ?',
)

function cacheKey(tf: TranscriptFile): string {
  // OpenCode sessions all point at one database path, and two rows can share a millisecond update
  // timestamp. Provider + id are therefore part of the cache identity, not just path + mtime.
  return `${tf.source}:${tf.session_id}:${tf.path}`
}

/** Persisted parse for this exact file revision, or null. Size joins mtime in the check because a
 *  rewrite that preserves mtime still changes length, and reading a stale title is worse than a
 *  re-parse. */
function readScanCache(tf: TranscriptFile, key: string, allowStale = false): ScannedMeta | null {
  const row = selectScan.get(key)
  if (!row) return null
  if (!allowStale && (row.mtime_ms !== tf.mtime_ms || row.size_bytes !== tf.size_bytes)) return null
  // A row this scanner is older than cannot answer the fields it never learned to fill, and its
  // NULLs would read as real answers rather than as absences. Treat it as a miss — see SCAN_VERSION.
  if ((row.scan_version ?? 1) < SCAN_VERSION) return null
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
    limit_stop: row.limit_notice
      ? { notice: row.limit_notice, pending: !!row.limit_pending, at: row.limit_at ?? null }
      : null,
    title_source: (row.title_source as TitleSource | null) ?? 'message',
    title_tag: row.title_tag ?? null,
    thread_key: row.thread_key ?? null,
    ended_because: (row.ended_because as SessionEnding | null) ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
  }
}

function rememberScan(tf: TranscriptFile, key: string, meta: ScannedMeta): ScannedMeta {
  titles?.set(key, { title: meta.title, cwd: meta.cwd })
  metaCache.set(key, { mtimeMs: tf.mtime_ms, sizeBytes: tf.size_bytes, meta })
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
      meta.limit_stop?.notice ?? null,
      meta.limit_stop ? (meta.limit_stop.pending ? 1 : 0) : null,
      meta.limit_stop?.at ?? null,
      meta.title_source,
      meta.title_tag,
      meta.thread_key,
      meta.ended_because,
      meta.model,
      meta.effort,
      SCAN_VERSION,
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
const inFlight = new Map<string, Promise<ScannedMeta | null>>()

/** This exact file revision's parse if memory or the scan table already holds it, else null. Never
 *  reads the transcript. */
function peekMeta(tf: TranscriptFile): ScannedMeta | null {
  const key = cacheKey(tf)
  const cached = metaCache.get(key)
  if (cached && cached.mtimeMs === tf.mtime_ms && cached.sizeBytes === tf.size_bytes)
    return cached.meta
  const persisted = readScanCache(tf, key)
  if (persisted)
    metaCache.set(key, { mtimeMs: tf.mtime_ms, sizeBytes: tf.size_bytes, meta: persisted })
  return persisted
}

/** What a row shows for a transcript that has not been parsed yet: the last parse of an earlier
 *  revision when there is one, else only what the index knows. Title is the index's own (the
 *  first prompt, where its store records one) or the file name; model, status, counts and the
 *  rest stay blank until the transcript is parsed. Never cached, so the real parse replaces it. */
function provisionalMeta(tf: TranscriptFile): ScannedMeta {
  const earlier = metaCache.get(cacheKey(tf))?.meta ?? readScanCache(tf, cacheKey(tf), true)
  if (earlier) return earlier
  const fileStem = /\.jsonl?$/i.test(tf.path)
    ? (tf.path.split(/[\\/]/).pop() ?? '').replace(/\.jsonl?$/i, '')
    : tf.session_id
  return {
    title: oneLine(tf.title || fileStem || tf.session_id, 120),
    cwd: tf.cwd || decodeProjectKey(tf.project),
    git_branch: null,
    message_count: 0,
    created_at: tf.created_at ?? null,
    last_activity_at: tf.mtime_ms,
    last_role: null,
    last_text_preview: null,
    // Unknown, not zero: zero would drop the row as a stub before anyone has looked.
    substantive_turns: 1,
    limit_stop: null,
    title_source: tf.title ? 'store' : 'id',
    title_tag: null,
    thread_key: null,
    ended_because: null,
    model: null,
    effort: null,
  }
}

/** Null when the transcript vanished mid-scan; see parseMeta. Callers must omit the row rather
 *  than treat it as an empty session, and the type is what forces them to.
 *
 *  Exported only so the regression test can point it at a path that no longer exists and prove the
 *  miss is survivable. Nothing else imports it. */
export function scanMeta(tf: TranscriptFile): Promise<ScannedMeta | null> {
  const key = cacheKey(tf)
  const known = peekMeta(tf)
  if (known) return Promise.resolve(known)
  // Keyed by file revision, so a transcript that gains a turn mid-flight starts a fresh scan rather
  // than joining the one that is already reading the previous revision.
  const revision = `${key}@${tf.mtime_ms}:${tf.size_bytes}`
  const running = inFlight.get(revision)
  if (running) return running
  const started = parseMeta(tf, key).finally(() => inFlight.delete(revision))
  inFlight.set(revision, started)
  return started
}

/** Same precedence as `title` in parseMeta, kept in step with it: whichever term won, names
 *  itself. Pulled out as a flat lookup rather than a nested ternary — same four-way precedence,
 *  same 'envelope' vs 'message' split for a turn-derived label, zero nesting either way. */
function resolveTitleSource(
  customTitle: string,
  aiTitle: string,
  storeTitle: string | undefined,
  turn: { label: string; envelope: boolean },
): TitleSource {
  if (customTitle) return 'custom'
  if (aiTitle) return 'ai'
  if (storeTitle) return 'store'
  if (turn.label) return turn.envelope ? 'envelope' : 'message'
  return 'id'
}

// OpenCode, Hermes, DeepSeek Harness and foreign transcripts all carry their own title, cwd and
// timestamps on the index row, because their stores record them as fields rather than leaving them
// to be inferred from the conversation. Split out of parseMeta as a self-contained seam: this branch
// never touches the line-by-line Claude/Codex parse below it.
//
// DSH is here despite writing one FILE per session (not a shared store) for the same reason the
// other three are: its metadata is a field, not something to infer. What it shares with them is the
// shape of the answer, not the shape of the store.
function parseSharedStoreMeta(tf: TranscriptFile, key: string): ScannedMeta {
  let content: { events: TailEvent[]; messageCount: number }
  if (tf.source === 'foreign') {
    const events = readForeignSession(tf.tool ?? '', tf.path)
    content = { events, messageCount: events.length }
  } else if (tf.source === 'dsh') {
    // tf.path is the session's own zstd log; there is no id lookup to do.
    content = readDshSession(tf.path) ?? { events: [], messageCount: 0 }
  } else if (tf.source === 'zswarm') {
    // tf.path is the job's own job.json; same reason as dsh above, no id lookup to do.
    content = readHSwarmSession(tf.path) ?? { events: [], messageCount: 0 }
  } else if (tf.source === 'hermes') {
    // tf.path, not a default: a Hermes profile is its own database, and this is the field that
    // says which one this row came from.
    content = readHermesSession(tf.session_id, tf.path) ?? { events: [], messageCount: 0 }
  } else {
    // tf.path, not the default database, for the same reason as the Hermes line above: an
    // OpenCode-compatible product (Kilo, MiMo Code, IcodeMate) is its own store (audit AH-34).
    content = readOpenCodeSession(tf.session_id, tf.path) ?? { events: [], messageCount: 0 }
  }
  const textEvents = (content?.events ?? []).filter((event) => event.kind === 'text')
  const first = textEvents[0]
  const last = textEvents.at(-1)
  // These stores hand us a title as a FIELD, so there is no envelope to unwrap and no ambiguity
  // about provenance: it is the provider's own label, or the first thing said, or the id.
  const titleSource: TitleSource = tf.title ? 'store' : first?.text ? 'message' : 'id'
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
    // None of these stores records a usage wall in a form this detector is willing to trust. An
    // absence is the truth; a false badge here would be worse than a missing one.
    limit_stop: null,
    title_source: titleSource,
    title_tag: null,
    // These stores keep one row per conversation, so a transcript never has a second copy and
    // its own id is a perfectly good conversation identity.
    thread_key: tf.session_id,
    // None of these stores records how a session stopped in a form worth trusting.
    ended_because: null,
    model: null,
    effort: null,
  }
  return rememberScan(tf, key, meta)
}

/*
 * Null when the transcript is gone by the time we read it, which is a NORMAL race rather than a
 * fault. `pruneUsageProbeTranscripts()` deletes the `/usage` probe's own transcripts on a timer, so
 * this daemon routinely removes files its own scanner is mid-way through enumerating; a user
 * clearing a project does the same by hand.
 *
 * It used to throw, and that was fatal. The rejection reached index.ts's last-resort handler, which
 * exits the process by design, so one deleted probe file killed the whole daemon. Measured
 * 2026-08-27: it died at 07:53:28 on exactly this, stayed dead for 33 minutes because the tray
 * watchdog meant to revive it was not running either, and the fleet went unwatched the entire time.
 * The warm-up at the bottom of this file already caught it ("an unreadable transcript just stays
 * uncached"); the list path and getSession did not, and the list path is the one that crashed.
 *
 * A miss is never cached, so a file that reappears is parsed normally on the next pass.
 */
/** Everything one JSONL record can update while scanning a transcript for parseMeta. Bundled so
 *  the per-line logic can move to its own function instead of closing over fourteen loose locals. */
interface MetaAccumulator {
  customTitle: string
  aiTitle: string
  lastPrompt: string
  firstUser: string
  cwd: string
  gitBranch: string | null
  messageCount: number
  firstTs: number | null
  lastTs: number | null
  lastRole: 'user' | 'assistant' | null
  lastPreview: string | null
  substantive: number
  threadKey: string | null
  ending: SessionEnding | null
  model: string | null
  effort: string | null
}

// One JSONL record's worth of parseMeta's scan. Pulled out so this branching scores against
// this function instead of parseMeta's — see this file's parseForeignOrOpenCodeMeta neighbour
// for the same "one function per source" split already used here.
function applyMetaLine(
  acc: MetaAccumulator,
  tf: TranscriptFile,
  ev: any,
  limits: ReturnType<typeof createLimitStopTracker> | null,
): void {
  switch (ev.type) {
    case 'custom-title':
      if (typeof ev.customTitle === 'string') acc.customTitle = ev.customTitle
      return
    case 'ai-title':
      if (typeof ev.aiTitle === 'string') acc.aiTitle = ev.aiTitle
      return
    case 'last-prompt':
      // Same rule as firstUser below: a slash command's `<command-name>` echo lands here too,
      // and it describes the plumbing rather than the work.
      if (typeof ev.lastPrompt === 'string' && !isCommandWrapperText(ev.lastPrompt))
        acc.lastPrompt = ev.lastPrompt
      return
  }
  if (typeof ev.cwd === 'string' && !acc.cwd) acc.cwd = ev.cwd
  if (typeof ev.payload?.cwd === 'string' && !acc.cwd) acc.cwd = ev.payload.cwd
  if (typeof ev.gitBranch === 'string' && ev.gitBranch) acc.gitBranch = ev.gitBranch
  // Before the display filtering below, and deliberately: the wall notice is a `<synthetic>`
  // assistant record and a terminal `result` is not a message at all, so anything that reads only
  // what the UI would show is blind to exactly the records this needs.
  limits?.observe(ev, toEpoch(ev.timestamp))
  if (!acc.threadKey && typeof ev.uuid === 'string' && ev.uuid) acc.threadKey = ev.uuid
  if (tf.source === 'claude') acc.ending = classifyEnding(ev, endingEventText(ev)) ?? acc.ending

  applyRunSettings(acc, ev)
  applyMetaMessage(acc, tf, ev)
}

// The model and effort the transcript records: Claude stamps the model on each assistant message
// (`<synthetic>` is the CLI's own notice, not a model) and the effort it ran that turn at as a
// top-level `effort` (or `perTurnEffort`, which the CLI writes alone on some turns); Codex writes
// both on every turn_context. A subagent's own turns are skipped: they run at their own effort.
function applyRunSettings(acc: MetaAccumulator, ev: any): void {
  const assistant = ev.message?.role === 'assistant'
  const m = assistant ? ev.message.model : ev.payload?.model
  if (typeof m === 'string' && m && m !== '<synthetic>') acc.model = m
  const stamped = assistant && !ev.isSidechain ? (ev.effort ?? ev.perTurnEffort) : undefined
  const e = ev.effortLevel ?? ev.payload?.effort ?? stamped
  if (typeof e === 'string' && e) acc.effort = e
}

// The message-shaped half of applyMetaLine: message count, first/last timestamps, and the
// title/preview candidates a Claude or Codex user/assistant turn contributes. Pulled out so
// this branching scores against this small function instead of applyMetaLine's.
function applyMetaMessage(acc: MetaAccumulator, tf: TranscriptFile, ev: any): void {
  const role = ev.message?.role ?? ev.type
  const tes = eventToTailEventsForSource(tf.source, ev)
  const isClaudeMessage = role === 'user' || role === 'assistant'
  const isCodexMessage =
    tf.source === 'codex' &&
    ev.type === 'response_item' &&
    ev.payload?.type === 'message' &&
    (ev.payload?.role === 'user' || ev.payload?.role === 'assistant')
  if (!(isClaudeMessage || isCodexMessage)) return
  if (isCodexMessage && tes.length === 0) return
  acc.messageCount++
  const t = toEpoch(ev.timestamp)
  if (t !== null) {
    if (acc.firstTs === null) acc.firstTs = t
    acc.lastTs = t
  }
  // eventToTailEvents is the ONE place that knows what is real: it drops thinking blocks and
  // the CLI's own resume bookkeeping (isMeta / <synthetic> self-talk). Reading
  // `ev.message.content` straight off the event bypassed all of that, which is exactly how the
  // `isMeta` local-command caveat became the title of 103 of the newest 200 sessions.
  const real = tes.filter((e) => e.text && !isCommandWrapperText(e.text))
  if (real.length > 0) acc.substantive++
  const visibleRole = isCodexMessage ? ev.payload.role : role
  if (!acc.firstUser && visibleRole === 'user') {
    acc.firstUser = real.find((e) => e.kind === 'text')?.text ?? ''
  }
  const textEv = [...tes].reverse().find((e) => e.kind === 'text')
  if (textEv) {
    acc.lastRole = textEv.role
    acc.lastPreview = oneLine(textEv.text)
  } else if (tes.length > 0) {
    acc.lastRole = role
    acc.lastPreview = acc.lastPreview ?? oneLine(tes[tes.length - 1].text)
  }
}

async function parseMeta(tf: TranscriptFile, key: string): Promise<ScannedMeta | null> {
  if (
    tf.source === 'opencode' ||
    tf.source === 'foreign' ||
    tf.source === 'hermes' ||
    tf.source === 'dsh' ||
    tf.source === 'zswarm'
  ) {
    return parseSharedStoreMeta(tf, key)
  }

  return oneParseAtATime(key, async () => {
    const state = await foldAppended(tf, key)
    return state ? rememberScan(tf, key, metaFromState(tf, state)) : null
  })
}

// ── Reading only what a transcript gained ──────────────────────────────────────────────────────
// A live chat's transcript only ever grows, and every size change sent the whole file (up to its
// last 12 MB) back through JSON.parse: the UI's 12 s poll, the 5-minute title sweep and the
// daemon's own timers each paid it to learn about the last few lines. Measured 2026-09-28: 186 MB
// read a minute and a quarter of a core, all day. Every field the scan keeps is a left fold over
// the file's records (applyMetaLine, the limit tracker), so the fold's state at byte N plus the
// records after N is exactly what a full re-read computes. This keeps that state per transcript
// and reads only the bytes appended since.
//
// A rewrite is not an append. The bytes just before where the last read stopped are kept, and a
// resumed read starts that many bytes early to compare them; any difference, or a file that
// shrank, drops the state and parses from scratch. One difference from a fresh parse, on purpose:
// a transcript past the 12 MB window keeps folding from where its first parse started instead of
// sliding the window, so its first-message fields stay the ones that parse saw. A daemon restart
// re-anchors it.
const READ_WINDOW_BYTES = 12 * 1024 * 1024
const RESUME_CHECK_BYTES = 64
// ~1,200 transcripts on a busy machine; past this the oldest-touched states are dropped and those
// transcripts parse from scratch on their next change.
const MAX_PARSE_STATES = 4000
// How long one slice of a transcript fold may run before the event loop gets a turn.
const FOLD_SLICE_MS = 8
/** Bytes decoded to text at once (then cut at the next newline). */
const DECODE_SLICE_BYTES = 512 * 1024

interface ParseState {
  /** Bytes before this offset are folded into acc and limits. */
  consumed: number
  /** The (up to) RESUME_CHECK_BYTES ending at `consumed`, to tell an append from a rewrite. */
  check: Uint8Array
  acc: MetaAccumulator
  limits: ReturnType<typeof createLimitStopTracker> | null
}
const parseStates = new Map<string, ParseState>()
const parseChains = new Map<string, Promise<unknown>>()
const utf8 = new TextDecoder()

/** Parses of one transcript run one after another: two revisions in flight at once (scanMeta
 *  dedupes a revision, not a file) must never fold the same bytes into one accumulator. */
function oneParseAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = parseChains.get(key) ?? Promise.resolve()
  const mine = before.then(run, run)
  const settled = mine.then(
    () => undefined,
    () => undefined,
  )
  parseChains.set(key, settled)
  void settled.then(() => {
    if (parseChains.get(key) === settled) parseChains.delete(key)
  })
  return mine
}

function newAccumulator(): MetaAccumulator {
  return {
    customTitle: '',
    aiTitle: '',
    lastPrompt: '',
    firstUser: '',
    cwd: '',
    gitBranch: null,
    messageCount: 0,
    firstTs: null,
    lastTs: null,
    lastRole: null,
    lastPreview: null,
    substantive: 0,
    threadKey: null,
    ending: null,
    model: null,
    effort: null,
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** A fold state and the bytes it folds next, which start at file offset `base`. */
interface FoldRead {
  state: ParseState
  base: number
  bytes: Uint8Array
}

/** The saved state with the bytes from just before where it stopped when the file only grew,
 *  else a fresh state over the 12 MB window. Throws when the file cannot be read. */
async function readForFold(tf: TranscriptFile, key: string): Promise<FoldRead> {
  const file = Bun.file(tf.path)
  const prev = parseStates.get(key)
  if (prev && file.size >= prev.consumed) {
    const base = prev.consumed - prev.check.length
    const bytes = new Uint8Array(await file.slice(base).arrayBuffer())
    if (
      bytes.length >= prev.check.length &&
      sameBytes(bytes.subarray(0, prev.check.length), prev.check)
    ) {
      return { state: prev, base, bytes }
    }
  }
  const base = Math.max(0, file.size - READ_WINDOW_BYTES)
  const bytes = new Uint8Array(await (base > 0 ? file.slice(base) : file).arrayBuffer())
  const state: ParseState = {
    consumed: base,
    check: new Uint8Array(0),
    acc: newAccumulator(),
    /**
     * "Did this conversation stop at a usage wall?", answered on the way past.
     *
     * The fold already JSON.parse-es every record of the transcript, so the verdict costs one
     * extra function call per line and no extra I/O — which is the whole reason the sessions
     * list can offer a "stopped by a usage limit" filter at all. rate-limit-discovery.ts
     * answers the same question from a 256 KB tail for the auto-resume monitor; both call the
     * SAME tracker so the badge and the monitor can never disagree.
     *
     * Claude only. The tracker's evidence gate keys on `isApiErrorMessage` / `<synthetic>`,
     * which are Claude Code's own markers, so a Codex rollout would simply never trip it — but
     * say so out loud rather than relying on that, because a detector that silently no-ops on
     * a provider looks exactly like a provider that never hits limits.
     */
    limits: tf.source === 'claude' ? createLimitStopTracker() : null,
  }
  return { state, base, bytes }
}

/** Folds bytes[from..lastNl], decoded a slice at a time, each ending on a newline: decoding a
 *  12 MB window whole is a block of its own (80-100 ms), and a newline byte never sits inside a
 *  UTF-8 sequence. */
async function foldSlices(
  state: ParseState,
  tf: TranscriptFile,
  bytes: Uint8Array,
  from: number,
  lastNl: number,
): Promise<void> {
  for (let at = from; at <= lastNl; ) {
    let stop = at + DECODE_SLICE_BYTES
    if (stop > lastNl) stop = lastNl + 1
    else {
      const nlAt = bytes.indexOf(0x0a, stop)
      stop = nlAt === -1 || nlAt > lastNl ? lastNl + 1 : nlAt + 1
    }
    await foldLines(state, tf, utf8.decode(bytes.subarray(at, stop)))
    at = stop
  }
}

/** Folds a last line with no newline yet if it parses; true when it did or was blank, false while
 *  it is still being written. */
function foldTail(state: ParseState, tf: TranscriptFile, rest: Uint8Array): boolean {
  const tail = utf8.decode(rest).trim()
  if (!tail) return true
  let ev: any
  try {
    ev = JSON.parse(tail)
  } catch {
    return false
  }
  applyMetaLine(state.acc, tf, ev, state.limits)
  return true
}

/** The transcript's fold state, brought up to its current end: resumed from the last read when
 *  the file only grew, rebuilt from the 12 MB window otherwise. Null when it cannot be read. */
async function foldAppended(tf: TranscriptFile, key: string): Promise<ParseState | null> {
  let read: FoldRead
  try {
    read = await readForFold(tf, key)
  } catch {
    parseStates.delete(key)
    return null
  }
  const { state, base, bytes } = read

  // Only whole lines are folded (a newline byte never sits inside a UTF-8 sequence, so splitting
  // on it is safe). A last line with no newline yet is folded only once it parses: a record is an
  // object, so a half-written one never does, and it is read again next time.
  const from = state.consumed - base
  const lastNl = bytes.lastIndexOf(0x0a)
  let end = from
  if (lastNl >= from) {
    await foldSlices(state, tf, bytes, from, lastNl)
    end = lastNl + 1
  }
  if (end < bytes.length && foldTail(state, tf, bytes.subarray(end))) end = bytes.length
  state.consumed = base + end
  state.check = bytes.slice(Math.max(0, end - RESUME_CHECK_BYTES), end)
  parseStates.delete(key) // re-inserted last: the Map's order is the eviction order
  parseStates.set(key, state)
  if (parseStates.size > MAX_PARSE_STATES) parseStates.delete(parseStates.keys().next().value!)
  return state
}

/** Fold every line of `text` into the state. acc.threadKey is the uuid of the transcript's FIRST
 *  message — the conversation's identity, not the file's. Interrupt a chat and resume it and the
 *  CLI opens a new transcript, replays the history and carries on, so one conversation ends up as
 *  two or three files with different session ids and the same opening message; that first uuid is
 *  the cheapest exact way to recognise them as each other. acc.ending: why this transcript stopped
 *  — the last meaningful record wins, because that is the one that ended it. See
 *  session-ending.ts for what the answers mean. */
async function foldLines(state: ParseState, tf: TranscriptFile, text: string): Promise<void> {
  // A 12 MB transcript is ~100k JSON.parse calls; folded in one go they hold the daemon for as long
  // as it takes, so the loop hands the thread back every FOLD_SLICE_MS and the daemon's other
  // requests are answered between slices.
  let sliceStart = performance.now()
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
    applyMetaLine(state.acc, tf, ev, state.limits)
    if (performance.now() - sliceStart > FOLD_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      sliceStart = performance.now()
    }
  }
}

function metaFromState(tf: TranscriptFile, { acc, limits }: ParseState): ScannedMeta {
  // describeTaggedText (formerly unwrapTaggedText) only touches the two derived-from-a-turn
  // sources: an explicit custom/AI title is already a label and must never be second-guessed.
  const turn = describeTaggedText(acc.lastPrompt || acc.firstUser || '')
  const title = oneLine(
    acc.customTitle || acc.aiTitle || tf.title || turn.label || tf.session_id,
    120,
  )
  // Same precedence as the line above, kept in step with it: whichever term won, names itself.
  // This is what lets a row explain a title nobody recognises instead of just displaying it.
  const titleSource: TitleSource = resolveTitleSource(acc.customTitle, acc.aiTitle, tf.title, turn)
  const meta: ScannedMeta = {
    title,
    cwd: acc.cwd || decodeProjectKey(tf.project),
    git_branch: acc.gitBranch,
    message_count: acc.messageCount,
    created_at: acc.firstTs,
    last_activity_at: acc.lastTs ?? tf.mtime_ms,
    last_role: acc.lastRole,
    last_text_preview: acc.lastPreview,
    substantive_turns: acc.substantive,
    limit_stop: limits?.verdict() ?? null,
    title_source: titleSource,
    title_tag: titleSource === 'envelope' ? turn.tag : null,
    thread_key: acc.threadKey,
    ended_because: acc.ending,
    model: acc.model,
    effort: acc.effort,
  }
  return meta
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

/** Map of session_id -> most-relevant queue status (running/queued win over terminal). */
function queueStatusMap(): Map<string, QueueStatus> {
  const rows = db
    .query<{ session_id: string; status: QueueStatus }, []>(
      'select session_id, status from queue_items order by created_at asc',
    )
    .all()
  const rank: Record<QueueStatus, number> = {
    running: 8,
    queued: 7,
    rate_limited: 6,
    // Just under rate_limited: both mean "stopped at a wall, not finished", but a spent quota is the
    // more useful thing to surface when a session carries both.
    overloaded: 5,
    // Ranks with failed, not completed: nobody has confirmed this run actually did anything, so it
    // needs the same attention a real failure would.
    unverified: 4,
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

/*
 * Drop the rows that are somebody else's subagent.
 *
 * A subagent is an implementation detail of the turn that spawned it, not a conversation the user
 * held — the same verdict Claude and Codex already reach in server/src/transcript.ts, reached one
 * layer later for OpenCode because there the subagent is a row in the same table rather than a
 * nested file. Without this, a machine that fans out reads as one that never stops starting new
 * chats: a six-way review filled the sidebar with seven near-identical rows, one real and six
 * `(@investigator subagent)`.
 *
 * It filters the LIST, never the index. The child rows stay indexed so analytics keeps charging
 * their tokens and so opening or exporting one by id still resolves — see TranscriptFile.parentId.
 *
 * A child whose parent is NOT in the index stays a row, on the same rule promoteOrphans applies to
 * Claude's nested transcripts: nothing may be silently unowned — either it belongs to a session or
 * it IS one. That is what keeps a subagent visible when its parent was deleted or pruned, rather
 * than leaving it in the store with nothing anywhere pointing at it. Membership is keyed by source
 * as well as id, so a bare id colliding across two stores cannot hide a session from a list.
 *
 * SO IT WALKS THE CHAIN RATHER THAN ASKING ONE QUESTION. "Does my parent exist" is the right test
 * only for a tree, and nothing in a SQLite column guarantees one. A row claiming itself as its own
 * parent, or two rows claiming each other, would each see a parent that exists and every one of them
 * would drop — the sessions would not merely be nested, they would be GONE from the list, which is
 * the one outcome this function may never produce. A chain that does not end at a real top-level
 * session is not ownership, so the row is kept and the user sees it.
 */
/*
 * One conversation, one row, however many transcripts a compaction split it into.
 *
 * Claude Code does not keep writing to a session it has compacted: it opens a new file with a new
 * session id, replays a summary, and carries on. Three files titled the same thing, 823 / 1071 /
 * 3179 messages, sharing 881 message uuids between them, are ONE chat that ran out of context twice
 * — and every one of them was showing up as its own row.
 *
 * The row that survives is the LAST one in the chain, because that is where the conversation
 * actually is now: clicking it should open what you were doing, not the truncated original. The
 * superseded transcripts stay in the index, exactly as subagents do, so nothing that counts spend
 * loses sight of them.
 */
/**
 * The desktop's OWN word on which transcripts are one conversation, laid over the index as
 * `supersededBy` links for collapseContinuations to fold.
 *
 * The detector behind `supersededBy` (session-continuations.ts) reads a transcript's first records
 * for the compaction marker. The desktop app rolls a chat differently: it opens the new transcript
 * by REPLAYING the retained history into it and writes the marker only after that, so the marker
 * sits hundreds of records deep and the detector never sees it. Measured 2026-09-03 on one chat
 * ("RusTor"): three transcripts, the marker at record 1,501 of the newest, three rows on screen
 * under two titles - the owner's "compacted chats become multiple entries".
 *
 * The app does record every id it retired (`priorCliSessionIds`, see retiredSessionIds), and that
 * record is the authority - it is what the sidebar reads to show ONE chat. Only gaps are filled: a
 * link the detector already proved from the transcript itself stands, a link to a transcript's own
 * id is ignored, and a store without a single rolled chat gets its array back untouched, so the
 * common case pays nothing.
 */
export function withDesktopContinuations(
  files: TranscriptFile[],
  retired: Map<string, string>,
): TranscriptFile[] {
  if (retired.size === 0) return files
  let changed = false
  const out = files.map((f) => {
    if (f.source !== 'claude' || f.supersededBy) return f
    const by = retired.get(f.session_id)
    if (!by || by === f.session_id) return f
    changed = true
    return { ...f, supersededBy: by }
  })
  return changed ? out : files
}

export function collapseContinuations(files: TranscriptFile[]): {
  rows: TranscriptFile[]
  /**
   * Surviving session id -> the ids it absorbed.
   *
   * Load-bearing, not bookkeeping. Everything else about a session is keyed on its session id —
   * which instance it belongs to, whether a queue run dispatched it, whether it is archived — and a
   * compaction moves the conversation to an id NONE of those tables has ever heard of. A queue row
   * records the id it dispatched and never changes it, so after a mid-run compaction the queue knows
   * only the predecessor while the list shows only the successor. Filter on either alone and an
   * actively running conversation disappears from the "queued" view entirely.
   */
  absorbed: Map<string, string[]>
} {
  if (!files.some((f) => f.supersededBy)) return { rows: files, absorbed: new Map() }
  const byId = new Map(files.filter((f) => f.source === 'claude').map((f) => [f.session_id, f]))
  const absorbed = new Map<string, string[]>()
  const rows = files.filter((file) => {
    if (!file.supersededBy) return true
    // Walk to the end of the chain rather than one hop: a conversation compacted twice is A -> B ->
    // C, and hiding A only because B exists would still leave two rows.
    const seen = new Set<string>([file.session_id])
    let next = byId.get(file.supersededBy)
    while (next) {
      // A cycle cannot be resolved into a newest member, so keep the row rather than drop every
      // member of the loop and lose the conversation entirely.
      if (seen.has(next.session_id)) return true
      seen.add(next.session_id)
      if (!next.supersededBy) {
        // Credited to the END of the chain, which is the row that will be on screen, so a two-hop
        // conversation still hands its whole history's ids to the one row representing it.
        const list = absorbed.get(next.session_id)
        if (list) list.push(file.session_id)
        else absorbed.set(next.session_id, [file.session_id])
        return false
      }
      next = byId.get(next.supersededBy)
    }
    // The successor is not in the index (deleted, or pruned by an earlier filter). This transcript is
    // the only surviving evidence of the conversation, so it stays.
    return true
  })
  return { rows, absorbed }
}

export function collapseSubagents(files: TranscriptFile[]): {
  rows: TranscriptFile[]
  /** `source:session_id` of a surviving row -> how many subagents it owns, through the whole chain. */
  counts: Map<string, number>
} {
  // A store that records no parentage at all is every store but OpenCode, so leave early rather than
  // build an index of every session on the machine for nothing.
  if (!files.some((f) => f.parentId)) return { rows: files, counts: new Map() }
  // Keyed by the locator's STORE identity (session-locator.ts's storeKeyOf), not just tool: a
  // parent/child pair is always read out of the same physical store's own tables, so storeKey is
  // exactly the disambiguator a bare tool misses whenever the store is database-backed. Tool alone
  // stops two OpenCode-format PRODUCTS (Kilo, MiMo Code) from colliding, but not two catalog entries
  // of the SAME product/tool backed by different databases, nor two Hermes profiles (both
  // `tool: 'hermes'`, different `state.db` paths) — either pair could otherwise claim ownership of
  // each other's row (audit AH-35 follow-up; storeKeyOf already reduces to the tool id for
  // file-backed formats, so this is a strict extension of the previous key for those).
  const key = (tf: Pick<TranscriptFile, 'source' | 'tool' | 'path'>, id: string) =>
    `${storeKeyOf({ source: tf.source, tool: tf.tool, path: tf.path, session_id: id })}:${id}`
  const byId = new Map(files.map((f) => [key(f, f.session_id), f]))

  /** The top-level session this row belongs to, or null when it is one itself — or owned by nothing
   *  real, which is the same answer as far as this list is concerned. */
  const ownerOf = (file: TranscriptFile): TranscriptFile | null => {
    const seen = new Set<string>([key(file, file.session_id)])
    let parent = file.parentId ? byId.get(key(file, file.parentId)) : undefined
    while (parent) {
      // Already on this path: the parentage is a cycle and owns nothing. Keep the row.
      if (seen.has(key(parent, parent.session_id))) return null
      // Reached a session nobody spawned. Everything below it really is a subagent.
      if (!parent.parentId) return parent
      seen.add(key(parent, parent.session_id))
      parent = byId.get(key(parent, parent.parentId))
    }
    // The chain ran off the end of the index: the owner was deleted or pruned. Keep the row.
    return null
  }

  const rows: TranscriptFile[] = []
  const counts = new Map<string, number>()
  for (const f of files) {
    const owner = f.parentId ? ownerOf(f) : null
    if (!owner) {
      rows.push(f)
      continue
    }
    // Credited to the ROOT rather than to the immediate parent, so a chain two deep still counts on
    // the row the user can actually see. Counted by source:storeKey:id, the same store-aware shape
    // as the lookup key above (not bare source:id — two owners in different stores sharing a session
    // id would otherwise collide on one counts entry and each report the OTHER's total; audit AH-35
    // follow-up). Callers (toSummary/getSession below) build the identical key to look this up.
    const k = `${owner.source}:${storeKeyOf(owner)}:${owner.session_id}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return { rows, counts }
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
 * A subagent that another session spawned is not a row here at all; see withoutOwnedSubagents.
 *
 * Transcripts with no substantive turn are dropped unconditionally (no scope opts back into them).
 * They are not short sessions, they are CLI scaffolding — a `/usage` probe writes a caveat, a
 * `<command-name>` line and nothing else. On this machine that was 127 of the newest 300, all ~3 KB
 * and all titled with the same caveat banner. Since that verdict needs a parse, the scan runs in
 * batches and keeps pulling until it has `limit` real sessions, rather than capping first and
 * returning a short list full of holes.
 */
export interface ListSessionsOptions {
  /** How many REAL rows to return. Stubs dropped after the parse do not count against it. */
  limit?: number
  /** How many real rows to skip first — the paging cursor. See the note at the batching loop for
   *  why this cannot be applied to the index instead. */
  offset?: number
  /**
   * One instance's sessions. A Claude Desktop dir name, "default" (non-isolated install), or
   * "other" (plain CLI) — plus, since Codex rows carry their own account, a Codex instance's name,
   * its `codex:<id>` ref, or its permanent number (`7` / `#7`). See instanceScopeMatches.
   */
  instance?: string | readonly string[]
  /** Every scope below takes one value, a list of them, or the legacy single spellings; see
   *  session-scopes.ts. A list is a UNION, and an empty list ('none') matches nothing. */
  archived?: ScopeInput
  /** Epoch cutoff on last activity, or null for no cutoff. */
  sinceMs?: number | null
  /** Upper epoch bound on last activity, for a caller asking about a past window rather than a
   *  trailing one. Null means "up to now". */
  untilMs?: number | null
  source?: ScopeInput
  /**
   * Keep only rows whose title, folder or id contains the text, or holds its letters in order (the
   * sidebar's fuzzy rule, minus the scoring). Decided over EVERY session in scope BEFORE the cap, so
   * the `limit` rows returned are the best matches rather than the newest rows that happen to match.
   * That needs each candidate's title, i.e. a (cached) transcript scan for all of them, so only a
   * caller that is actually searching should set it.
   */
  title?: string
  dispatched?: ScopeInput
  rateLimited?: ScopeInput
  /** The sidebar's contract: instance, dispatched and rate-limited are facts about CLAUDE sessions,
   *  so they narrow Claude rows and let every other source pass through. Off (the default) keeps the
   *  older exclusive reading for programmatic callers: scoped to an account, only that account. */
  scopesNarrowClaudeOnly?: boolean
  /** Case-insensitive substring of the working directory or the provider's project key. */
  project?: string
}

/** Whether `f` belongs to `instance`. Split out of listSessions because it is one of several
 *  filter predicates run over the whole index before the newest-N cap; see the call site. */
function transcriptMatchesInstance(
  f: TranscriptFile,
  instance: string,
  idsOf: (f: TranscriptFile) => string[],
  mmap: Map<string, SessionMeta>,
  byOrigin: Set<string>,
): boolean {
  // A store that splits per ACCOUNT says so on the row itself, so no parse and no Desktop
  // lookup is involved: Codex rows are settled here and never fall through to the Claude
  // resolution below, which would answer "not this instance" for every one of them.
  if (f.instance) return instance !== 'other' && instanceScopeMatches(f, instance)
  if (f.source !== 'claude') return false
  // Another PC's chat belongs to none of this PC's accounts.
  if (f.remote) return instance === 'other'
  const known = idsOf(f)
    .map((id) => mmap.get(id))
    .find(Boolean)
  // Unknown to Desktop: only the origin join can still place it, and only into an instance that
  // join can name. Scoped to anything else (a Codex account above all), keeping it would parse the
  // whole Claude store to return nothing — measured 68 s for 0 rows over 2,511 transcripts.
  if (!known) return instance === 'other' || byOrigin.has(instance)
  return instance === 'other' ? false : known.instance === instance
}

/** Whether `f` (or a transcript it absorbed) is marked archived. */
function transcriptArchivedFlag(
  f: TranscriptFile,
  idsOf: (f: TranscriptFile) => string[],
  mmap: Map<string, SessionMeta>,
): boolean {
  // Another PC's chat is archived when that PC archived it, whatever a copy here says.
  if (f.remote) return chatsFromElsewhere().get(f.session_id)?.archived ?? false
  return f.archived || idsOf(f).some((id) => !!mmap.get(id)?.archived)
}

/** Whether `f` (or a transcript it absorbed) has a queue row. */
function transcriptDispatchedFlag(
  f: TranscriptFile,
  idsOf: (f: TranscriptFile) => string[],
  qmap: Map<string, QueueStatus>,
): boolean {
  return f.source === 'claude' && idsOf(f).some((id) => qmap.has(id))
}

/** Case-insensitive substring match of `needle` against every project-ish field `f` carries. */
function transcriptMatchesProject(f: TranscriptFile, needle: string): boolean {
  return (
    (f.cwd ?? '').toLowerCase().includes(needle) ||
    decodeProjectKey(f.project).toLowerCase().includes(needle) ||
    f.project.toLowerCase().includes(needle)
  )
}

/** A stop as a row shows it: the notice's reset ("resets 11:40pm (America/Chicago)") as an instant,
 *  read against the moment of the stop, so a time-only reset is the next such time after the stop
 *  rather than after now (which, once it passed, would read as tomorrow). */
export function withResetsAt(stop: LimitStop | null): SessionLimitStop | null {
  if (!stop) return null
  const at = stop.notice.search(/\bresets\b/i)
  return {
    ...stop,
    resets_at:
      stop.at !== null && at >= 0 ? parseResetTime(stop.notice.slice(at), new Date(stop.at)) : null,
  }
}

/** Which usage-wall state a parsed row is in. */
function rateLimitStateOf(m: ScannedMeta): RateLimitState {
  if (!m.limit_stop) return 'clear'
  return m.limit_stop.pending ? 'pending' : 'resolved'
}

/** Whether `f` might be a rate-limited row: a proven hit, or not yet scanned (see the rateLimited
 *  filter's own comment on why an unscanned row is always kept at this stage). */
function transcriptRateLimitCandidate(
  f: TranscriptFile,
  limited: Set<string>,
  scanned: Set<string>,
): boolean {
  const key = cacheKey(f)
  return limited.has(key) || !scanned.has(key)
}

/** The reasons a PARSED row is dropped outright, independent of the `instance` scope (which needs
 *  the resolved `desk` and is checked separately — see instanceExcludesRow). */
function shouldDropParsedRow(
  m: ScannedMeta,
  sinceMs: number | null,
  rateLimitVerdict: (state: RateLimitState) => boolean,
): boolean {
  if (m.substantive_turns === 0) return true
  // The mtime pass above is a cheap SUPERSET (writing a turn always touches the file, so mtime is
  // never older than the last activity). It is not exact, though: a transcript can be touched
  // without gaining a timestamped turn, which put rows reading "2d ago" inside a "Last 24 hours"
  // window. Re-check against the timestamp the row actually DISPLAYS, now that it is parsed.
  if (sinceMs !== null && m.last_activity_at < sinceMs) return true
  // The exact half of the usage-wall scope. The pre-filter above only narrowed the candidates;
  // this is the verdict, and it runs on the same parsed row the badge is rendered from, so the
  // filter and the badge cannot disagree.
  return !rateLimitVerdict(rateLimitStateOf(m))
}

/** Whether the `instance` scope excludes this row, now that `desk` is resolved. A row whose store
 *  named its own account was already settled before the cap (transcriptMatchesInstance) and never
 *  reaches here — deskMetaFor is Claude-only, so `desk` would be null for every one of them. */
function instanceExcludesRow(
  tf: TranscriptFile,
  instances: readonly string[] | undefined,
  desk: SessionMeta | null,
): boolean {
  if (!instances || tf.instance) return false
  return !instances.some((i) => (i === 'other' ? desk === null : desk?.instance === i))
}

/** Assemble one row's DTO once it has cleared every filter. Split out of toSummary purely for
 *  size — this is a single flat object literal, not a source of branching. */
function buildSessionSummary(
  tf: TranscriptFile,
  m: ScannedMeta,
  desk: SessionMeta | null,
  qmap: Map<string, QueueStatus>,
  dmap: Map<string, boolean>,
  collapsed: { counts: Map<string, number> },
  lookups: RowLookups,
): SessionSummary {
  const other = elsewhereFor(tf, lookups)
  return {
    session_id: tf.session_id,
    source: tf.source,
    tool: toolIdOf(tf),
    locator: tf.locator ?? makeLocator(tf),
    title: other?.title ?? m.title,
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
    ...instanceFieldsFor(tf, desk, lookups.numberOf),
    archived: other ? other.archived : tf.archived || (desk?.archived ?? false),
    done:
      dmap.get(sessionMarkKey(tf.source, tf.session_id, tf)) ??
      dmap.get(legacyMarkKey(tf.source, tf.session_id, tf.tool)) ??
      false,
    dispatched: tf.source === 'claude' && qmap.has(tf.session_id),
    subagent_count: collapsed.counts.get(`${tf.source}:${storeKeyOf(tf)}:${tf.session_id}`) ?? 0,
    limit_stop: withResetsAt(m.limit_stop),
    title_source: m.title_source,
    title_tag: m.title_tag,
    copy_index: 1,
    copy_count: 1,
    ended_because: m.ended_because,
    model: m.model,
    effort: effortFor(tf, m.effort, desk, lookups.climayteEffort),
    ...offloadsFor(tf, lookups),
    ...(other ? { from_pc: other.pc } : {}),
  }
}

/** The per-list lookups a row's instance number, effort and offloads come from, built once per call. */
interface RowLookups {
  numberOf: DesktopNumberLookup
  climayteEffort: Map<string, string>
  /** HSwarm runs by the 8-character session prefix HSwarm records. */
  hswarmRuns: Map<string, number>
  climayteTasks: Map<string, number>
  fromPc: Map<string, ElsewhereChat>
}

const rowLookups = (): RowLookups => ({
  numberOf: desktopNumberLookup(),
  climayteEffort: climayteEffortBySession(),
  hswarmRuns: hswarmRunsBySessionPrefix(),
  climayteTasks: climayteTasksBySession(),
  fromPc: chatsFromElsewhere(),
})

/** Another PC's chat in the chat sync's viewer, as that PC shows it: the PC's name, the chat's title
 *  and whether it is archived there. Undefined for every chat of this PC's. */
const elsewhereFor = (tf: TranscriptFile, lookups: RowLookups): ElsewhereChat | undefined =>
  tf.remote ? lookups.fromPc.get(tf.session_id) : undefined

/** The work a Claude chat handed off, by the CLI session id it ran under (CliMayte's origin records
 *  it whole, HSwarm its first 8 characters); absent when it handed off none. */
function offloadsFor(tf: TranscriptFile, lookups: RowLookups): Pick<SessionSummary, 'offloads'> {
  if (tf.source !== 'claude') return {}
  const hswarm = lookups.hswarmRuns.get(tf.session_id.slice(0, 8)) ?? 0
  const climayte = lookups.climayteTasks.get(tf.session_id) ?? 0
  return hswarm || climayte ? { offloads: { hswarm, climayte } } : {}
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const {
    limit = 200,
    offset = 0,
    sinceMs = null,
    untilMs = null,
    scopesNarrowClaudeOnly = false,
    project,
  } = opts
  const sources = parseSourceScope(opts.source)
  const instances = parseInstanceScope(opts.instance)
  const archivedStates = parseArchivedScope(opts.archived)
  const dispatchedStates = parseDispatchedScope(opts.dispatched)
  const rateLimitStates = parseRateLimitScope(opts.rateLimited)
  // None ticked in any scope is a real answer, not "unset": the list is empty by request.
  if (
    sources?.size === 0 ||
    instances?.length === 0 ||
    archivedStates.size === 0 ||
    dispatchedStates?.size === 0 ||
    rateLimitStates?.size === 0
  )
    return []
  // Whether a scope speaks about this row at all. Off the Claude-only reading every row is judged,
  // as before; on it, another provider's rows are not Claude facts and pass through untouched.
  const scopeAppliesTo = (f: TranscriptFile) => !scopesNarrowClaudeOnly || f.source === 'claude'
  const mmap = sessionMetaMap()
  // Read up here rather than beside dmap below, because the `dispatched` scope filters on it and
  // that has to happen before the newest-N cap.
  const qmap = queueStatusMap()
  // Async on purpose: this handler is already async, and on a cold cache the sync builder blocks
  // the whole daemon for the length of a full store sweep. ensureTranscriptIndex also coalesces
  // with the boot warm-up, so the first request after launch joins that build instead of racing it.
  let files = await ensureTranscriptIndex()
  // Before every other filter, and on the WHOLE index: whether a subagent's parent exists is a fact
  // about the store, and deciding it against an already-filtered list would promote a child to a row
  // merely because the current scope hid its parent.
  // Before the subagent collapse and on the WHOLE index, for the same reason that one runs early:
  // whether a conversation was continued is a fact about the store, and deciding it against an
  // already-filtered list would put a superseded transcript back on screen merely because the
  // current scope hid the session that replaced it.
  const continued = collapseContinuations(withDesktopContinuations(files, retiredSessionIds()))
  files = continued.rows
  /**
   * Every session id this row speaks for: its own, plus any transcript it absorbed by continuing it.
   *
   * A compaction moves a conversation to an id that the queue table, the instance map and the
   * archive flag have never seen, because they all recorded the id that existed when the run
   * started. Asking those tables about the surviving id alone answers "no" for a conversation they
   * know perfectly well under its previous name, which for the dispatched filter means an actively
   * running queued job vanishing from the queued view entirely.
   */
  const idsOf = (f: TranscriptFile): string[] => {
    const extra = continued.absorbed.get(f.session_id)
    return extra ? [f.session_id, ...extra] : [f.session_id]
  }
  const collapsed = collapseSubagents(files)
  files = collapsed.rows
  if (sources) files = files.filter((file) => sources.has(file.source))
  // A row whose id Desktop does not know is a CANDIDATE, not a miss: resolveInstanceByOrigin may
  // still place it once the parse supplies its cwd and start time. So this pre-filter keeps those
  // and toSummary settles them exactly, the same shape the usage-wall scope uses below and for
  // the same reason — a scope that runs before the cap cannot see anything only a parse knows,
  // and being conservative here costs a few parses where guessing would cost correctness.
  if (instances) {
    const byOrigin = originInstances()
    files = files.filter(
      (f) =>
        !scopeAppliesTo(f) ||
        instances.some((i) => transcriptMatchesInstance(f, i, idsOf, mmap, byOrigin)),
    )
  }
  if (archivedStates.size === 1) {
    const want = archivedStates.has('archived')
    files = files.filter((f) => transcriptArchivedFlag(f, idsOf, mmap) === want)
  }
  if (sinceMs !== null) files = files.filter((f) => f.mtime_ms >= sinceMs)
  // No re-check after the parse, unlike sinceMs below: mtime is an UPPER bound on real activity
  // (a file is never written before its last turn), so an mtime inside the window guarantees the
  // displayed timestamp is too. The sinceMs direction is the one where the superset can lie.
  if (untilMs !== null) files = files.filter((f) => f.mtime_ms <= untilMs)
  // Before the cap, for the same reason `instance` and `archived` are: a handful of queued runs
  // among thousands of hand-driven transcripts would never crack the newest-200, so a filter applied
  // afterwards would answer "you have never queued anything" on a machine that queues nightly.
  if (dispatchedStates && dispatchedStates.size === 1) {
    const want = dispatchedStates.has('queued')
    files = files.filter(
      (f) => !scopeAppliesTo(f) || transcriptDispatchedFlag(f, idsOf, qmap) === want,
    )
  }
  // A folder scope, for a caller that wants one repository's history rather than one instance's.
  // Matched against BOTH the working directory and the provider's project key, because the two
  // stores disagree about which they record: Claude writes an encoded project key and a cwd, the
  // foreign adapters often have only one of them.
  if (project) {
    const needle = project.toLowerCase()
    files = files.filter((f) => transcriptMatchesProject(f, needle))
  }
  // Same before-the-cap rule again, and this one needs a trick to obey it: the verdict comes from a
  // PARSE, not from the mtime index, so it cannot simply be a filter here. What it can be is a
  // narrowing — drop the rows the cache already proved are NOT limited, keep the ones it proved are
  // plus everything it has never seen, and let toSummary settle the remainder exactly. After the
  // boot warm-up the unscanned set is nearly empty, so this turns "re-read a thousand transcripts
  // to find nine" into one sqlite query. It is conservative in the safe direction: an unscanned row
  // is always kept, so the scope can be slow but never wrong.
  // 'clear' ticked means a row that never hit a wall qualifies, so the cache cannot prove any row
  // out and nothing can be narrowed here; the parsed verdict below does all the work.
  const rateLimitNarrows = !!rateLimitStates && !rateLimitStates.has('clear')
  if (rateLimitNarrows) {
    const limited = new Set(selectLimitedKeys.all(SCAN_VERSION).map((r) => r.cache_key))
    const scanned = new Set(selectScannedKeys.all(SCAN_VERSION).map((r) => r.cache_key))
    files = files.filter(
      (f) => !scopeAppliesTo(f) || transcriptRateLimitCandidate(f, limited, scanned),
    )
  }
  files = files.sort((a, b) => b.mtime_ms - a.mtime_ms)
  const dmap = doneMarkMap()
  const lookups = rowLookups()

  const budget = scanBudget()
  // The usage-wall scope needs the parsed verdict, so it keeps waiting for the parse; every other
  // list answers within the budget and shows an unparsed row from what the index knows.
  const metaOf = async (tf: TranscriptFile): Promise<ScannedMeta | null> => {
    if (rateLimitNarrows) return scanMeta(tf)
    const known = peekMeta(tf)
    if (known) return known
    const outcome: { parsed?: boolean } = {}
    await budget.wait(
      queueParse(tf).then((ok) => {
        outcome.parsed = ok
      }),
    )
    // Gone between the listing and the read: there is no row, same as a direct parse.
    if (outcome.parsed === false) return null
    return peekMeta(tf) ?? provisionalMeta(tf)
  }
  const toSummary = async (tf: TranscriptFile): Promise<SessionSummary | null> => {
    const m = await metaOf(tf)
    // Gone between the listing and the read, so there is no row to show. This is the path that
    // used to take the daemon down with it.
    if (!m) return null
    const applies = scopeAppliesTo(tf)
    const wallVerdict = (state: RateLimitState) =>
      !applies || !rateLimitStates || rateLimitStates.has(state)
    if (shouldDropParsedRow(m, sinceMs, wallVerdict)) return null
    // Desktop's own id link first; the origin join only for rows it has never heard of. Resolved
    // ONCE here and used for both the chip and the filter below, so the two cannot disagree.
    const desk = deskMetaFor(tf, m, idsOf(tf), mmap)
    if (applies && instanceExcludesRow(tf, instances, desk)) return null
    return buildSessionSummary(tf, m, desk, qmap, dmap, collapsed, lookups)
  }

  // Batched so a run of stubs costs extra parses only when it actually occurs: a store with no
  // scaffolding in it parses exactly `limit` files, the same as before.
  //
  // `offset` is paid for in the same currency as the cap, i.e. in REAL rows: a page is only a page
  // if page 2 starts where page 1 stopped, and stubs are dropped after the parse, so skipping N
  // index entries would skip an unknown number of rows and silently lose sessions between pages.
  // Fetching offset+limit and slicing is the only way to keep the pages contiguous.
  const wanted = offset + limit
  const out: SessionSummary[] = []
  const needle = opts.title?.trim().toLowerCase()
  if (needle) return rankedTitleMatches(files, needle, toSummary, offset, limit, budget)
  for (let cursor = 0; cursor < files.length && out.length < wanted; ) {
    const batch = files.slice(cursor, cursor + (wanted - out.length))
    cursor += batch.length
    const scanned = await mapPool(batch, SCAN_CONCURRENCY, toSummary)
    for (const s of scanned) if (s) out.push(s)
  }
  out.sort((a, b) => b.last_activity_at - a.last_activity_at)
  labelCopies(out, files)
  return offset > 0 ? out.slice(offset) : out
}

/** How well `needle` (lower-case) matches a row, 0 best; null when it does not. Substring beats
 *  letters-in-order, and the title beats the folder and id. */
export function titleMatchTier(
  needle: string,
  row: { title: string; cwd: string; session_id: string },
): number | null {
  const title = row.title.toLowerCase()
  const rest = [row.cwd.toLowerCase(), row.session_id.toLowerCase()]
  if (title.includes(needle)) return 0
  if (rest.some((f) => f.includes(needle))) return 1
  const inOrder = (text: string) => {
    let at = 0
    for (const ch of text) if (ch === needle[at] && ++at === needle.length) return true
    return false
  }
  if (inOrder(title)) return 2
  return rest.some(inOrder) ? 3 : null
}

/** How long one list may wait for transcripts nobody has parsed yet before it answers with what
 *  it has. The parse carries on in the background and the next request sees its result. */
const SCAN_BUDGET_MS = 400

// Narrow on purpose: every parse in flight takes its slices in the same turn of the event loop, so
// the width is what the daemon's other requests wait behind.
const PARSE_QUEUE_CONCURRENCY = 2

interface QueuedParse {
  tf: TranscriptFile
  /** True when the transcript parsed, false when it could not be read (gone, unreadable). */
  done: Promise<boolean>
  finish: (parsed: boolean) => void
}
const parseQueue = new Map<string, QueuedParse>()
let draining = false

const takeNewestQueued = (): QueuedParse | null => {
  let best: [string, QueuedParse] | null = null
  for (const entry of parseQueue)
    if (!best || entry[1].tf.mtime_ms > best[1].tf.mtime_ms) best = entry
  if (!best) return null
  parseQueue.delete(best[0])
  return best[1]
}

function drainParseQueue(): Promise<void> {
  const worker = async () => {
    for (let item = takeNewestQueued(); item; item = takeNewestQueued()) {
      try {
        item.finish((await scanMeta(item.tf)) !== null)
      } catch {
        // An unreadable transcript stays uncached, as everywhere else.
        item.finish(false)
      }
    }
  }
  return Promise.all(Array.from({ length: PARSE_QUEUE_CONCURRENCY }, worker))
    .then(() => undefined)
    .finally(() => {
      draining = parseQueue.size > 0
      if (draining) void drainParseQueue()
    })
}

/** Ask for a transcript to be parsed in the background, newest first, a couple at a time machine-
 *  wide. The promise settles when that parse is done, which may be long after the request that
 *  asked has answered. */
function queueParse(tf: TranscriptFile): Promise<boolean> {
  const key = cacheKey(tf)
  const queued = parseQueue.get(key)
  if (queued) {
    if (tf.mtime_ms > queued.tf.mtime_ms) queued.tf = tf
    return queued.done
  }
  const { promise: done, resolve: finish } = Promise.withResolvers<boolean>()
  parseQueue.set(key, { tf, done, finish })
  if (!draining) {
    draining = true
    void drainParseQueue()
  }
  return done
}

/** One list's allowance for waiting on parses, shared by everything that waits in it. */
function scanBudget(ms = SCAN_BUDGET_MS) {
  const deadline = performance.now() + ms
  let expired: Promise<void> | null = null
  return {
    async wait(work: Promise<unknown>): Promise<void> {
      const left = deadline - performance.now()
      if (left <= 0) return
      expired ??= new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        timer.unref?.()
      })
      await Promise.race([work, expired])
    },
  }
}
type ScanBudget = ReturnType<typeof scanBudget>

const selectTitles = db.query<{ cache_key: string; title: string; cwd: string }, [number]>(
  'select cache_key, title, cwd from session_scan_cache where scan_version >= ?',
)

// Every cached title and folder by cache key, read from the scan table once and kept current by
// rememberScan, so a search never re-reads thousands of rows. A row the table later drops stays
// here harmlessly: matching walks the live index and only looks keys up.
let titles: Map<string, { title: string; cwd: string }> | null = null
function titleIndex(): Map<string, { title: string; cwd: string }> {
  if (!titles) {
    titles = new Map()
    for (const r of selectTitles.all(SCAN_VERSION)) titles.set(r.cache_key, r)
  }
  return titles
}

// How many candidates one match pass looks at before the event loop gets a turn.
const MATCH_SLICE = 800

/** The title-search path of listSessions.
 *
 *  The match runs on what the scan cache already knows (one sqlite read, then a pass over the
 *  candidates that parses nothing), and only the best `limit` hits are built into rows. A
 *  transcript the cache has no title for is matched on its index fields meanwhile and parsed in
 *  the background; the request waits for that at most SCAN_BUDGET_MS. Every step is short
 *  and the event loop gets a turn between batches, so a search over thousands of sessions never
 *  holds the daemon. */
async function rankedTitleMatches(
  files: TranscriptFile[],
  needle: string,
  toSummary: (tf: TranscriptFile) => Promise<SessionSummary | null>,
  offset: number,
  limit: number,
  budget: ScanBudget,
): Promise<SessionSummary[]> {
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
  const known = titleIndex()
  await turn()
  const misses = files.filter((f) => !known.has(cacheKey(f)))
  if (misses.length) {
    await budget.wait(Promise.all(misses.map(queueParse)))
  }
  const candidates: Array<{ tf: TranscriptFile; tier: number }> = []
  for (let from = 0; from < files.length; from += MATCH_SLICE) {
    for (const tf of files.slice(from, from + MATCH_SLICE)) {
      const row = known.get(cacheKey(tf))
      const tier = titleMatchTier(needle, {
        title: row?.title ?? tf.title ?? '',
        cwd: row?.cwd ?? tf.cwd ?? decodeProjectKey(tf.project),
        session_id: tf.session_id,
      })
      if (tier !== null) candidates.push({ tf, tier })
    }
    await turn()
  }
  candidates.sort((a, b) => a.tier - b.tier || b.tf.mtime_ms - a.tf.mtime_ms)
  await turn()
  // Rows are built only for the best candidates, a page's worth at a time: a parsed row can still
  // drop out (a stub, a scope the parse settles), and the fresh title is what finally ranks it.
  const wanted = offset + limit
  const hits: Array<{ row: SessionSummary; tier: number }> = []
  for (let cursor = 0; cursor < candidates.length && hits.length < wanted; ) {
    const batch = candidates.slice(
      cursor,
      cursor + Math.max(wanted - hits.length, SCAN_CONCURRENCY),
    )
    cursor += batch.length
    const rows = await mapPool(batch, SCAN_CONCURRENCY, (c) => toSummary(c.tf))
    for (const row of rows) {
      const tier = row ? titleMatchTier(needle, row) : null
      if (row && tier !== null) hits.push({ row, tier })
    }
    await turn()
  }
  hits.sort((a, b) => a.tier - b.tier || b.row.last_activity_at - a.row.last_activity_at)
  const out = hits.slice(offset, offset + limit).map((h) => h.row)
  labelCopies(out, files)
  return out
}

/**
 * Tell each row how many transcripts its conversation has, and which one this is.
 *
 * WHY THIS IS NOT A FOLD. Interrupt a chat and resume it and the CLI opens a fresh transcript,
 * replays the history and carries on, so one conversation becomes two or three files that look
 * like unrelated chats with the same title. The obvious fix is to hide all but the fullest, and it
 * is wrong: measured across 36 such pairs on a real store, EVERY older copy held turns the newer
 * one did not, and they were the user's own words — usually the last thing said before the
 * interrupt ("See you soon.", "skip domains4sale.uk,, do the rest"), which the resumed file never
 * carried over. Not one of the 36 was safely absorbable. So nothing is hidden; the rows are
 * labelled, and the reader can see that two rows are one conversation in two parts.
 *
 * RUNS AFTER THE PARSES, and that ordering is the whole reason it works: thread_key comes from the
 * scan, so reading the table before the batch loop answers nothing on a cold cache and every row
 * would call itself the only copy on the first list after an upgrade. By here, every row that was
 * returned has been scanned and written.
 */
function labelCopies(rows: SessionSummary[], files: TranscriptFile[]): void {
  const threadOf = new Map<string, string>()
  for (const row of selectThreadKeys.all(SCAN_VERSION)) threadOf.set(row.cache_key, row.thread_key)
  // Grouped over every candidate transcript, not just the returned page: a conversation's other
  // copy is an ordinary row that may fall outside the current window, and counting the page alone
  // would tell a row it is unique whenever its twin happened not to be on screen.
  const groups = new Map<string, TranscriptFile[]>()
  for (const f of files) {
    const key = threadOf.get(cacheKey(f))
    if (!key) continue
    const at = groups.get(key)
    if (at) at.push(f)
    else groups.set(key, [f])
  }
  // Numbered OLDEST FIRST, so copy 1 is where the conversation started and the numbering reads
  // chronologically. Size was the first attempt and it is not the same ordering: a transcript with
  // fewer turns but fatter tool output is the larger file, which had copy 1 of "File path analysis"
  // holding 225 turns while copy 2 held 246. Last-written is a fact about the conversation; bytes
  // are a fact about the disk.
  for (const group of groups.values()) group.sort((a, b) => a.mtime_ms - b.mtime_ms)
  for (const row of rows) {
    const key = threadOf.get(`${row.source}:${row.session_id}:${row.transcript_path}`)
    const group = key ? groups.get(key) : undefined
    if (!group || group.length < 2) continue
    const at = group.findIndex(
      (f) => f.session_id === row.session_id && f.path === row.transcript_path,
    )
    row.copy_index = at === -1 ? 1 : at + 1
    row.copy_count = group.length
  }
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

/**
 * The done-mark's storage key. Bare `sessionId` for claude is kept exactly as it always was — that
 * namespace has real marks on disk and Claude Code sessions are never format-ambiguous — but a
 * non-claude mark keys on the locator's STORE identity (session-locator.ts's `storeKeyOf`), not tool
 * alone: tool distinguishes two products of one format (Kilo vs MiMo Code, both `opencode`), but not
 * two Hermes profiles, which both report `tool: 'hermes'` yet are separate `state.db` files, nor two
 * catalog entries of the same product pointed at different databases. A mark keyed on tool alone
 * would let either pair toggle whichever store's session the id happened to resolve to (audit AH-35
 * follow-up). `storeKeyOf` already reduces to the tool id (or source) for file-backed formats, so
 * for those this produces the BYTE-FOR-BYTE same string as before: only db-backed formats (opencode,
 * hermes) change shape, from `${source}:${tool}:${id}` to `${source}:${storeKey}:${id}` where
 * storeKey is the database path. Passing no `tf` (the caller has only a source, not a resolved row)
 * falls back to the old `source:id` key unchanged, exactly the pre-locator behavior.
 *
 * Marks written before storeKey existed must stay readable forever. A mark written under the
 * pre-storeKey key (tool-only, no path) for a db-backed
 * session is not silently orphaned — see {@link legacyMarkKey}, read second at both read
 * sites in this file (the `done` field in toSummary and getSession). Nothing ever writes under the
 * pre-storeKey key again; the second read exists only so a mark set before this change stays findable until it
 * is next toggled, which rewrites it under the new key.
 */
export function sessionMarkKey(
  source: SessionSource,
  sessionId: string,
  tf?: { tool?: string; path?: string },
): string {
  if (source === 'claude') return sessionId
  if (!tf) return `${source}:${sessionId}`
  const storeKey = storeKeyOf({ source, tool: tf.tool, path: tf.path ?? '', session_id: sessionId })
  return storeKey === source ? `${source}:${sessionId}` : `${source}:${storeKey}:${sessionId}`
}

/**
 * The done-mark key {@link sessionMarkKey} produced BEFORE this change — tool only, never the store
 * path. Read-only fallback: a Hermes/OpenCode mark set before this fix is still found under its old
 * key. Never write under this key going forward.
 */
export function legacyMarkKey(source: SessionSource, sessionId: string, tool?: string): string {
  if (source === 'claude') return sessionId
  const t = tool && tool !== source ? tool : null
  return t ? `${source}:${t}:${sessionId}` : `${source}:${sessionId}`
}

/**
 * Which Claude Desktop instance ran this conversation, by every route we have, in order of strength.
 *
 *  1. Desktop's own `cliSessionId` link, for THIS id.
 *  2. The same link for any id this row absorbed by continuing it. A compaction moves a conversation
 *     to an id Desktop never recorded, so asking about the surviving id alone answers "no" for a
 *     conversation it knows perfectly well under the name it had when the run started.
 *  3. The origin join — same working directory, same creation instant — which is the only thing
 *     left for a transcript Desktop wrote no metadata row for at all. Unique or nothing; see
 *     resolveInstanceByOrigin.
 *
 * Null means genuinely unknown, and the UI says so rather than rendering an empty space: on a real
 * store 45 of 400 sessions have no Desktop record anywhere on disk, and a blank gap there reads as
 * a missing feature instead of a missing fact.
 */
function deskMetaFor(
  tf: TranscriptFile,
  meta: ScannedMeta,
  ids: string[],
  mmap: Map<string, SessionMeta>,
): SessionMeta | null {
  if (tf.source !== 'claude' || tf.remote) return null
  for (const id of ids) {
    const hit = mmap.get(id)
    if (hit) return hit
  }
  return resolveInstanceByOrigin(meta.cwd, meta.created_at)
}

/**
 * The three `instance*` columns of a row, from whichever source actually knows.
 *
 * TWO different facts land in one triple, and the order is the point. A store that splits per
 * ACCOUNT (Codex: one CODEX_HOME per instance) knows the answer from the row's own path, with no
 * parse, no join and no guess — so it wins outright. Claude Desktop's answer is the resolved one
 * (id link, then absorbed ids, then the origin join; see {@link deskMetaFor}) and it stays a bare
 * dir name, because that is the identity every other Claude surface in this codebase uses.
 *
 * One function, used by both the list and the single-session route, so a row cannot change its
 * account when you click on it.
 */
function instanceFieldsFor(
  tf: TranscriptFile,
  desk: SessionMeta | null,
  numberOf: DesktopNumberLookup,
): Pick<SessionSummary, 'instance' | 'instance_ref' | 'instance_num'> {
  const own = tf.instance
  if (own)
    return {
      instance: own.name,
      instance_ref: own.ref,
      instance_num: own.num > 0 ? own.num : null,
    }
  const instance = tf.source === 'claude' ? (desk?.instance ?? null) : null
  return {
    instance,
    instance_ref: null,
    instance_num: instance === null ? null : numberOf(instance),
  }
}

type DesktopNumberLookup = (label: string) => number | null

/**
 * Label (`default` or a dir name under the instances root) -> that Desktop profile's permanent
 * number, from the registry list_instance_numbers reads. One file read per list call, then a map
 * lookup per row. Null for a label with no registry entry: the registry numbers a profile when
 * AgentHydra first lists it, and this never assigns one, so a list call cannot mint numbers.
 */
function desktopNumberLookup(): DesktopNumberLookup {
  const numbers = allInstanceNumbers()
  return (label) => {
    const dir = label === 'default' ? defaultClaudeUserDataDir() : join(instancesRoot(), label)
    return numbers[instanceRef('desktop', dir)] ?? null
  }
}

/** What a Claude row's effort is, most specific record first: the effort CliMayte launched the
 *  session at, the effort its own newest turn was stamped with, then the effort the Desktop app
 *  keeps for the chat. Null when none of them wrote one down. */
function effortFor(
  tf: TranscriptFile,
  scanned: string | null,
  desk: SessionMeta | null,
  climayte: Map<string, string>,
): string | null {
  if (tf.source !== 'claude') return scanned
  return climayte.get(tf.session_id) ?? scanned ?? desk?.effort ?? null
}

/**
 * Every folder that has conversations in it, newest first.
 *
 * THE POINT: a client that has been asked to search "all my chat histories" cannot start, because
 * the only listing surface is newest-N sessions and there is no way to learn what exists. This is
 * the index of the index — 1,231 sessions on this machine collapse to a few dozen folders, which
 * is small enough to hand to an agent whole and specific enough to then scope a real query with
 * (`project=` on the session list, `instance=` on search).
 *
 * Built from the transcript INDEX alone: project, cwd, source and mtime are all index columns, so
 * this costs no transcript reads at all no matter how large the store is.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const files = await ensureTranscriptIndex()
  const byCwd = new Map<string, ProjectSummary>()
  for (const f of files) {
    const cwd = f.cwd || decodeProjectKey(f.project)
    let row = byCwd.get(cwd)
    if (!row) {
      row = {
        cwd,
        project: f.project,
        sessions: 0,
        by_source: { claude: 0, codex: 0, opencode: 0, hermes: 0, dsh: 0, zswarm: 0, foreign: 0 },
        first_activity_at: f.mtime_ms,
        last_activity_at: f.mtime_ms,
      }
      byCwd.set(cwd, row)
    }
    row.sessions++
    row.by_source[f.source]++
    if (f.mtime_ms < row.first_activity_at) row.first_activity_at = f.mtime_ms
    if (f.mtime_ms > row.last_activity_at) row.last_activity_at = f.mtime_ms
  }
  return [...byCwd.values()].sort((a, b) => b.last_activity_at - a.last_activity_at)
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
      // The CACHE row goes — it describes a file revision that no longer exists. The PERMANENT
      // record does not: it is stamped `gone_at` and keeps every number the chat ever had. Losing
      // the cache is housekeeping; losing the history is what made "all time" mean "the last
      // month", because Claude Code deletes transcripts after 30 days. See db.ts session_stats.
      const gone = db.query<{ session_id: string; source: string }, [string]>(
        'select session_id, source from session_scan_cache where cache_key = ?',
      )
      const now = Date.now()
      db.transaction(() => {
        for (const r of dead) {
          const row = gone.get(r.cache_key)
          if (row?.session_id) markSessionGone.run(now, `${row.source}:${row.session_id}`)
          del.run(r.cache_key)
        }
      })()
    }
  } catch {
    // Best-effort housekeeping; a failed prune must never stop the warm-up below.
  }

  const batch = [...files].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, newest)
  // Half the request-path width: this is speculative work, and a request that arrives mid-warm-up
  // should be able to overtake it. It never duplicates that request's work — scanMeta's in-flight
  // map means the two share whichever file they both want.
  await mapPool(batch, Math.max(1, Math.floor(SCAN_CONCURRENCY / 2)), async (tf) => {
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
  locator?: string,
): Promise<SessionSummary | null> {
  // findTranscriptAsync, not the sync pair this used to call: only a MISS can be wrong, and the
  // sync miss path cannot WAIT for the sweep it starts (it would have to be the blocking builder).
  // This function is already async and is what answers "show me this session", including for a run
  // dispatched a moment ago whose transcript is newer than the snapshot — precisely the case that
  // has to wait rather than report nothing.
  const tf = await findTranscriptAsync(sessionId, source, locator)
  if (!tf) return null
  const m = await scanMeta(tf)
  // Deleted between finding it and reading it, which answers the caller's question the same way a
  // miss above does: there is no such session.
  if (!m) return null
  await ensureTranscriptIndex()
  const qmap = queueStatusMap()
  const dmap = doneMarkMap()
  // Same resolution the list uses, so a row does not change its account when you click it.
  const meta = deskMetaFor(tf, m, [tf.session_id], sessionMetaMap())
  const lookups = rowLookups()
  const other = elsewhereFor(tf, lookups)
  return {
    session_id: tf.session_id,
    source: tf.source,
    tool: toolIdOf(tf),
    locator: tf.locator ?? makeLocator(tf),
    title: other?.title ?? m.title,
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
    ...instanceFieldsFor(tf, meta, lookups.numberOf),
    archived: other ? other.archived : tf.archived || (meta?.archived ?? false),
    done:
      dmap.get(sessionMarkKey(tf.source, sessionId, tf)) ??
      dmap.get(legacyMarkKey(tf.source, sessionId, tf.tool)) ??
      false,
    dispatched: tf.source === 'claude' && qmap.has(tf.session_id),
    // Asked of the whole index rather than tracked per row, because this route can be handed a
    // subagent's own id — reached from a search hit — and that row is not in the collapsed list at
    // all. It answers 0 for itself, which is true: a subagent spawned nothing.
    subagent_count:
      collapseSubagents(listTranscriptFiles()).counts.get(
        `${tf.source}:${storeKeyOf(tf)}:${tf.session_id}`,
      ) ?? 0,
    limit_stop: withResetsAt(m.limit_stop),
    title_source: m.title_source,
    title_tag: m.title_tag,
    // This route answers about ONE session and never builds the group, so it does not claim to
    // know about other copies. The list is where that count comes from.
    copy_index: 1,
    copy_count: 1,
    ended_because: m.ended_because,
    model: m.model,
    effort: effortFor(tf, m.effort, meta, lookups.climayteEffort),
    ...offloadsFor(tf, lookups),
    ...(other ? { from_pc: other.pc } : {}),
  }
}
