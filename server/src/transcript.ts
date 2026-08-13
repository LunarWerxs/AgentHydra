import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  CLAUDE_PROJECTS_ROOT,
  CODEX_ARCHIVED_SESSIONS_ROOT,
  CODEX_SESSION_INDEX_PATH,
  CODEX_SESSIONS_ROOT,
  OPENCODE_DB_PATH,
} from './config'
import { listOpenCodeSessions, readOpenCodeSession } from './opencode-sessions'
import type { SessionSource, TailEvent, TailResult } from './types'

// --- cwd folder-name encoding (forward only; reverse is lossy) --------------

/** Mirror Claude Code's project-folder key: non [A-Za-z0-9_-] chars collapse to '-'. */
export function encodeCwdKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9_-]/g, '-')
}

/** Best-effort reverse of a project folder name back to a path (only used if no cwd on events). */
export function decodeProjectKey(key: string): string {
  // e.g. "C--Projects-MyApp" -> "C:\Projects\MyApp" (heuristic)
  const m = key.match(/^([A-Za-z])--(.*)$/)
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`
  return key.replace(/-/g, '/')
}

// --- transcript file index (TTL-cached) -------------------------------------

export interface TranscriptFile {
  session_id: string
  source: SessionSource
  path: string
  project: string
  mtime_ms: number
  size_bytes: number
  archived: boolean
  /** OpenCode already stores these as indexed columns, so metadata scans need not re-derive them. */
  title?: string
  cwd?: string
  created_at?: number | null
  /**
   * The OTHER files that belong to this same session, for providers that write more than one.
   *
   * Codex writes one rollout per execution thread and identifies the user-owned chat by
   * `payload.session_id`, so a single conversation can be hundreds of files. The list below keeps
   * one ROW per conversation (see finishIndex) because that is what a session list is, but each of
   * those discarded files carries its own token spend, and dropping them undercounted Codex usage
   * by an order of magnitude. Anything totalling a session must read these as well as `path`.
   */
  siblingPaths?: string[]
}

let cache: { at: number; files: TranscriptFile[] } | null = null
const TTL_MS = 2000

export interface CodexRolloutIdentity {
  sessionId: string
  isSubagent: boolean
}

/**
 * Codex writes one rollout per execution thread, including every spawned subagent. The filename
 * suffix and payload.id identify that rollout, while payload.session_id identifies the user-owned
 * chat all of those threads belong to. Only the top-level rollout is the conversation shown by
 * Codex itself; indexing child rollouts produces dozens of overlapping rows with the same title.
 */
export function codexRolloutIdentity(event: unknown, fallbackId: string): CodexRolloutIdentity {
  const payload =
    event &&
    typeof event === 'object' &&
    (event as any).type === 'session_meta' &&
    (event as any).payload &&
    typeof (event as any).payload === 'object'
      ? (event as any).payload
      : null
  const sessionId =
    typeof payload?.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : fallbackId
  const isSubagent =
    payload?.thread_source === 'subagent' ||
    !!(payload?.source && typeof payload.source === 'object' && payload.source.subagent)
  return { sessionId, isSubagent }
}

const codexIdentityCache = new Map<string, CodexRolloutIdentity>()

export interface CodexSessionIndexEntry {
  title: string
  updatedAt: number | null
}

/** Parse Codex Desktop's append-style sidebar index. Later rows win when a title is regenerated or
 * renamed, while malformed/incomplete rows are ignored so an active write cannot break browsing. */
export function parseCodexSessionIndex(text: string): Map<string, CodexSessionIndexEntry> {
  const entries = new Map<string, CodexSessionIndexEntry>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row?.id !== 'string' || typeof row?.thread_name !== 'string') continue
    const id = row.id.trim()
    const title = row.thread_name.trim()
    if (!id || !title) continue
    const timestamp = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN
    entries.set(id, {
      title,
      updatedAt: Number.isNaN(timestamp) ? null : timestamp,
    })
  }
  return entries
}

let codexSessionIndexCache:
  | {
      mtimeMs: number
      size: number
      entries: Map<string, CodexSessionIndexEntry>
    }
  | undefined

function readCodexSessionIndex(): Map<string, CodexSessionIndexEntry> {
  try {
    const stat = statSync(CODEX_SESSION_INDEX_PATH)
    if (
      codexSessionIndexCache?.mtimeMs === stat.mtimeMs &&
      codexSessionIndexCache.size === stat.size
    )
      return codexSessionIndexCache.entries
    const entries = parseCodexSessionIndex(readFileSync(CODEX_SESSION_INDEX_PATH, 'utf8'))
    codexSessionIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries }
    return entries
  } catch {
    return new Map()
  }
}

/** Read only the first JSONL record. Session metadata can be tens of KB because it includes base
 * instructions, while the rollout itself can be many MB; loading the whole file here would make
 * every session-list refresh unnecessarily expensive. */
function readCodexRolloutIdentity(path: string, fallbackId: string): CodexRolloutIdentity {
  const cached = codexIdentityCache.get(path)
  if (cached) return cached

  const chunks: Buffer[] = []
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    while (total < 1024 * 1024) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      const newline = chunk.subarray(0, read).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)))
      total += read
    }
  } catch {
    // Active rollouts can move to the archive between discovery and this read.
    return { sessionId: fallbackId, isSubagent: false }
  } finally {
    if (fd !== null) closeSync(fd)
  }

  let event: unknown = null
  try {
    event = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
  } catch {
    // A just-created or legacy malformed rollout still remains discoverable by its filename.
  }
  const identity = codexRolloutIdentity(event, fallbackId)
  // Do not pin a failed/incomplete first-line read forever; the next index refresh may see it after
  // Codex has finished writing the session_meta record.
  if (event) codexIdentityCache.set(path, identity)
  return identity
}

/**
 * Async twin of {@link readCodexRolloutIdentity}, for the non-blocking index build.
 *
 * Same contract and the same shared cache; the only difference is that it never holds the event
 * loop. The 64 KiB first slice is the overwhelmingly common case (a session_meta record is a few
 * KB); the 1 MiB retry matches the sync reader's ceiling for a pathological single-line head.
 */
async function readCodexRolloutIdentityAsync(
  path: string,
  fallbackId: string,
): Promise<CodexRolloutIdentity> {
  const cached = codexIdentityCache.get(path)
  if (cached) return cached

  let head = ''
  try {
    const file = Bun.file(path)
    head = await file.slice(0, 64 * 1024).text()
    if (!head.includes('\n') && file.size > 64 * 1024)
      head = await file.slice(0, 1024 * 1024).text()
  } catch {
    // Active rollouts can move to the archive between discovery and this read.
    return { sessionId: fallbackId, isSubagent: false }
  }

  const newline = head.indexOf('\n')
  let event: unknown = null
  try {
    event = JSON.parse((newline >= 0 ? head.slice(0, newline) : head).trim())
  } catch {
    // A just-created or legacy malformed rollout still remains discoverable by its filename.
  }
  const identity = codexRolloutIdentity(event, fallbackId)
  if (event) codexIdentityCache.set(path, identity)
  return identity
}

/** Bounded-concurrency map, local so this module stays free of a cycle back through sessions.ts. */
async function mapPool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!)
  })
  await Promise.all(workers)
  return out
}

let refreshing = false

/**
 * The store's file index: every transcript's id, mtime and size.
 *
 * Served stale-while-revalidate, because building it is the one cost in this app that scales with
 * how much history you have KEPT rather than with what you asked to see: it globs the whole store
 * and stats every file (measured: 145 ms warm / 414 ms cold for 1,255 transcripts, and it grows
 * linearly from there). Paying that inside a request put a folder-sized tax on every poll. Callers
 * now get the last snapshot immediately and a fresh sweep runs just after, so request latency
 * tracks the number of rows asked for, not the size of ~/.claude.
 *
 * `force` is for the two callers that cannot tolerate a stale answer — looking up a session that
 * ISN'T in the snapshot, which is exactly what a just-created transcript looks like.
 */
export function listTranscriptFiles(force = false): TranscriptFile[] {
  const now = performance.now()
  if (!force && cache) {
    if (now - cache.at >= TTL_MS && !refreshing) {
      refreshing = true
      // setTimeout, not an inline call: this must land on its own turn of the loop rather than
      // inside whichever request happened to notice the snapshot was stale.
      setTimeout(() => {
        try {
          buildTranscriptIndex()
        } catch {
          // Keep serving the previous snapshot; the next tick tries again.
        } finally {
          refreshing = false
        }
      }, 0)
    }
    return cache.files
  }
  return buildTranscriptIndex()
}

let lastMissSweepAt = Number.NEGATIVE_INFINITY

/**
 * The index as seen after a fresh sweep, for a caller that just failed to find a session in the
 * snapshot. Throttled to one sweep per TTL: a transcript created moments ago is worth re-globbing
 * the store for, but a session id that simply does not exist (a deleted transcript the UI is still
 * polling) must not buy a full folder scan on every single request.
 */
export function listTranscriptFilesAfterMiss(): TranscriptFile[] {
  const now = performance.now()
  if (cache && now - lastMissSweepAt < TTL_MS) return cache.files
  lastMissSweepAt = now
  return listTranscriptFiles(true)
}

/**
 * Every transcript root is created lazily by the CLI that owns it, so on a machine that has never
 * run Claude (or Codex, or archived a rollout) the folder simply is not there — and `scanSync`
 * answers a missing root by THROWING ENOENT rather than yielding nothing. An absent store is not an
 * error, it is an empty one.
 *
 * This is load-bearing, not defensive dressing: the index is warmed at startup from an unawaited
 * call, so the throw surfaced as an unhandled rejection and killed the daemon before it could serve
 * /api/health. A fresh install saw a process that exited instead of an empty Sessions list. The
 * release smoke job caught it on all three OSes; nothing on a developer machine can, because every
 * developer machine has the folders.
 *
 * Materialized inside the try because the iterator throws lazily: the ENOENT arrives on first
 * advance, not at the scanSync call, so wrapping only the call would catch nothing.
 */
function scanRootSync(glob: Bun.Glob, cwd: string): string[] {
  try {
    return [...glob.scanSync({ cwd, onlyFiles: true })]
  } catch {
    return []
  }
}

/** Async twin of {@link scanRootSync}, with the same "a missing root is an empty one" contract.
 *  The iterator throws lazily too, so the `for await` has to be INSIDE the try. */
async function scanRootAsync(glob: Bun.Glob, cwd: string): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const rel of glob.scan({ cwd, onlyFiles: true })) out.push(rel)
  } catch {
    return out
  }
  return out
}

const CLAUDE_TRANSCRIPT_GLOB = '*/*.jsonl'
const CODEX_ROLLOUT_GLOB = '**/rollout-*.jsonl'
/** How many files the async build stats/reads at once. Wide enough to keep the disk busy, bounded
 *  so a huge store cannot open thousands of handles at once. */
const INDEX_SCAN_WIDTH = 24

function claudeRecord(rel: string, mtimeMs: number, sizeBytes: number): TranscriptFile {
  return {
    session_id: basename(rel).replace(/\.jsonl$/, ''),
    source: 'claude',
    path: join(CLAUDE_PROJECTS_ROOT, rel),
    project: rel.split(/[\\/]/)[0],
    mtime_ms: mtimeMs,
    size_bytes: sizeBytes,
    archived: false,
  }
}

/** The rollout uuid embedded in the filename — the identity fallback when the first record does
 *  not parse (a rollout still being written, or a legacy shape). */
function codexFallbackId(rel: string): string {
  const name = basename(rel).replace(/\.jsonl$/, '')
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? name
}

function codexRecord(
  root: string,
  rel: string,
  archived: boolean,
  mtimeMs: number,
  sizeBytes: number,
  identity: CodexRolloutIdentity,
  indexed: CodexSessionIndexEntry | undefined,
): TranscriptFile {
  return {
    session_id: identity.sessionId,
    source: 'codex',
    path: join(root, rel),
    project: 'codex',
    mtime_ms: Math.max(mtimeMs, indexed?.updatedAt ?? 0),
    size_bytes: sizeBytes,
    archived,
    title: indexed?.title,
  }
}

function openCodeRecords(): TranscriptFile[] {
  return listOpenCodeSessions().map((session) => ({
    session_id: session.session_id,
    source: 'opencode' as const,
    path: OPENCODE_DB_PATH,
    project: session.project,
    mtime_ms: session.last_activity_at,
    size_bytes: session.size_bytes,
    archived: session.archived,
    title: session.title,
    cwd: session.cwd,
    created_at: session.created_at,
  }))
}

/** A moved JSONL can briefly appear in both active and archived roots while filesystem caches
 *  settle. Source + id is the identity; newest wins, matching findTranscript's old behavior. */
/**
 * One row per session, keeping the newest file as its face — and REMEMBERING the rest.
 *
 * The dedupe is what makes the session list a list of conversations rather than of files, and it
 * has to stay. What it must not do is destroy the fact that the others existed: Codex writes a
 * rollout per execution thread, so a conversation is routinely hundreds of files, each with its own
 * token counter. Discarding them silently made the analytics report a fraction of real Codex spend
 * (5,283 rollouts on this machine collapsed to 146 rows). They are carried on `siblingPaths`, which
 * only a total ever reads.
 */
function finishIndex(
  files: TranscriptFile[],
  at: number,
  subagentPaths?: Map<string, string[]>,
): TranscriptFile[] {
  const unique = new Map<string, TranscriptFile>()
  const siblings = new Map<string, string[]>()
  for (const file of files) {
    const key = `${file.source}:${file.session_id}`
    const paths = siblings.get(key)
    if (paths) paths.push(file.path)
    else siblings.set(key, [file.path])
    const previous = unique.get(key)
    if (!previous || file.mtime_ms >= previous.mtime_ms) unique.set(key, file)
  }
  const result = [...unique.values()].map((file) => {
    const key = `${file.source}:${file.session_id}`
    // Only the OTHERS: `path` is already read by every caller, and listing it twice would double
    // that file's tokens. Subagent rollouts join them, since they are the same conversation's spend.
    const rest = (siblings.get(key) ?? []).filter((p) => p !== file.path)
    if (file.source === 'codex')
      for (const p of subagentPaths?.get(file.session_id) ?? []) if (p !== file.path) rest.push(p)
    return rest.length ? { ...file, siblingPaths: rest } : file
  })
  cache = { at, files: result }
  return result
}

function buildTranscriptIndex(): TranscriptFile[] {
  const now = performance.now()
  const files: TranscriptFile[] = []
  const claudeGlob = new Bun.Glob(CLAUDE_TRANSCRIPT_GLOB)
  for (const rel of scanRootSync(claudeGlob, CLAUDE_PROJECTS_ROOT)) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(join(CLAUDE_PROJECTS_ROOT, rel))
    } catch {
      continue
    }
    files.push(claudeRecord(rel, st.mtimeMs, st.size))
  }

  const codexSessionIndex = readCodexSessionIndex()
  const subagentPaths = new Map<string, string[]>()
  const addCodexRoot = (root: string, archived: boolean) => {
    const glob = new Bun.Glob(CODEX_ROLLOUT_GLOB)
    for (const rel of scanRootSync(glob, root)) {
      const path = join(root, rel)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const identity = readCodexRolloutIdentity(path, codexFallbackId(rel))
      // Subagents are an implementation detail of their parent chat. Their visible user history is
      // a forked copy of that chat, so merging them would duplicate turns; the top-level rollout is
      // the complete user-facing conversation and is the only row Codex itself exposes.
      //
      // They are REMEMBERED rather than discarded, because a subagent burns its own tokens and the
      // parent rollout does not contain them. Dropping them outright made the analytics report a
      // fraction of real Codex spend: on this machine 4,716 of 4,860 archived rollouts are
      // subagents. See TranscriptFile.siblingPaths, which only a total ever reads.
      if (identity.isSubagent) {
        rememberSubagent(subagentPaths, identity.sessionId, path)
        continue
      }
      files.push(
        codexRecord(
          root,
          rel,
          archived,
          st.mtimeMs,
          st.size,
          identity,
          codexSessionIndex.get(identity.sessionId),
        ),
      )
    }
  }
  addCodexRoot(CODEX_SESSIONS_ROOT, false)
  addCodexRoot(CODEX_ARCHIVED_SESSIONS_ROOT, true)

  files.push(...openCodeRecords())
  return finishIndex(files, now, subagentPaths)
}

/** One conversation can own hundreds of subagent rollouts; capped so a runaway fan-out cannot put
 *  an unbounded array on an index row. The cap is generous enough to cover a real session (the
 *  largest here owns 444) and exists only as a ceiling. */
const MAX_SUBAGENT_PATHS = 2000

function rememberSubagent(map: Map<string, string[]>, sessionId: string, path: string): void {
  const list = map.get(sessionId)
  if (!list) {
    map.set(sessionId, [path])
    return
  }
  if (list.length < MAX_SUBAGENT_PATHS) list.push(path)
}

/**
 * The same index, built WITHOUT holding the event loop.
 *
 * This exists because the sync builder is not merely slow, it is *blocking*: globbing the store,
 * statting every transcript and reading the head of every Codex rollout measured 1,288 ms for 1,405
 * files on the author's machine. The daemon binds its port ~250 ms after launch, so a startup warm
 * that used the sync builder left the socket accepting connections while nothing could be answered
 * — the browser's very first GET sat in the queue for over a second, and moving the warm call after
 * `Bun.serve` (which it already was) could not help, because the block is inside the same turn.
 *
 * Correctness is identical: same globs, same records, same dedupe, same cache slot.
 */
async function buildTranscriptIndexAsync(): Promise<TranscriptFile[]> {
  const now = performance.now()
  const files: TranscriptFile[] = []

  const claudeRels = await scanRootAsync(new Bun.Glob(CLAUDE_TRANSCRIPT_GLOB), CLAUDE_PROJECTS_ROOT)
  const claudeStats = await mapPool(claudeRels, INDEX_SCAN_WIDTH, async (rel) => {
    try {
      const st = await statAsync(join(CLAUDE_PROJECTS_ROOT, rel))
      return claudeRecord(rel, st.mtimeMs, st.size)
    } catch {
      return null
    }
  })
  for (const record of claudeStats) if (record) files.push(record)

  const codexSessionIndex = readCodexSessionIndex()
  const subagentPaths = new Map<string, string[]>()
  for (const [root, archived] of [
    [CODEX_SESSIONS_ROOT, false],
    [CODEX_ARCHIVED_SESSIONS_ROOT, true],
  ] as const) {
    const rels = await scanRootAsync(new Bun.Glob(CODEX_ROLLOUT_GLOB), root)
    const records = await mapPool(rels, INDEX_SCAN_WIDTH, async (rel) => {
      const path = join(root, rel)
      try {
        const st = await statAsync(path)
        const identity = await readCodexRolloutIdentityAsync(path, codexFallbackId(rel))
        // Same rule as the sync builder: not a row, but its tokens are not thrown away.
        if (identity.isSubagent) return { subagentOf: identity.sessionId, path }
        return codexRecord(
          root,
          rel,
          archived,
          st.mtimeMs,
          st.size,
          identity,
          codexSessionIndex.get(identity.sessionId),
        )
      } catch {
        return null
      }
    })
    for (const record of records) {
      if (!record) continue
      if ('subagentOf' in record) rememberSubagent(subagentPaths, record.subagentOf, record.path)
      else files.push(record)
    }
  }

  files.push(...openCodeRecords())
  return finishIndex(files, now, subagentPaths)
}

let indexBuild: Promise<TranscriptFile[]> | null = null

/**
 * The async, request-safe way to get the index — prefer this over {@link listTranscriptFiles} in
 * any caller that is already async.
 *
 * Keeps listTranscriptFiles's stale-while-revalidate contract (a caller holding a snapshot never
 * waits for the sweep) and adds coalescing: concurrent callers on a cold cache share ONE build
 * instead of each paying for their own, which is exactly the startup shape — the boot warm-up and
 * the first `/api/sessions` request arrive within milliseconds of each other.
 */
export async function ensureTranscriptIndex(force = false): Promise<TranscriptFile[]> {
  const now = performance.now()
  if (!force && cache && now - cache.at < TTL_MS) return cache.files
  if (!indexBuild) {
    indexBuild = buildTranscriptIndexAsync()
      .catch(() => cache?.files ?? [])
      .finally(() => {
        indexBuild = null
      })
  }
  const build = indexBuild
  if (!force && cache) return cache.files
  return build
}

export function findTranscript(sessionId: string, source?: SessionSource): TranscriptFile | null {
  const pick = (files: TranscriptFile[]) =>
    files.filter((f) => f.session_id === sessionId && (!source || f.source === source))
  // A miss is the one answer the snapshot can get wrong — a transcript created seconds ago is
  // absent from it — and it is also the cheap case, so re-sweep before believing it.
  let matches = pick(listTranscriptFiles())
  if (matches.length === 0) matches = pick(listTranscriptFilesAfterMiss())
  if (matches.length === 0) return null
  // newest wins if a session id appears under multiple project folders
  return matches.reduce((a, b) => (b.mtime_ms > a.mtime_ms ? b : a))
}

// --- byte-tail reader --------------------------------------------------------

async function readTailBytes(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path)
  const size = file.size
  const start = Math.max(0, size - maxBytes)
  const blob = start > 0 ? file.slice(start) : file
  return await blob.text()
}

// --- text helpers ------------------------------------------------------------

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

const CODEX_INJECTED_USER_BLOCK =
  /^\s*<(recommended_plugins|environment_context|app-context|permissions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|multi_agent_mode|turn_aborted)\b/i

/** Codex Desktop carries request/runtime context as user-role blocks. They are transport metadata,
 * not human turns, and must not become titles or transcript bubbles. */
export function isCodexInjectedUserText(text: string): boolean {
  return (
    CODEX_INJECTED_USER_BLOCK.test(text) ||
    // Codex may deliver a repository's AGENTS.md preamble as a user-role transport message even
    // though it came from the runtime, not the human. Without this guard it becomes the title.
    /^\s*#\s*AGENTS\.md instructions\b/i.test(text)
  )
}

/** Convert one Codex rollout item. event_msg mirrors message text for live UI updates, so only
 * response_item is consumed; reading both would duplicate every visible turn. */
export function codexEventToTailEvents(ev: any): TailEvent[] {
  if (ev?.type !== 'response_item') return []
  const payload = ev?.payload
  const timestamp: string | null = typeof ev?.timestamp === 'string' ? ev.timestamp : null

  if (payload?.type === 'message') {
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') return []
    const out: TailEvent[] = []
    const blocks = Array.isArray(payload.content) ? payload.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'input_text' && block.type !== 'output_text') continue
      if (typeof block.text !== 'string') continue
      if (role === 'user' && isCodexInjectedUserText(block.text)) continue
      const text = compact(block.text)
      if (!text) continue
      out.push({
        role,
        kind: 'text',
        text: truncate(text, 6000),
        tool_name: null,
        timestamp,
      })
    }
    return out
  }

  if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
    const input = compact(stringifyToolResult(payload.arguments ?? payload.input))
    return [
      {
        role: 'assistant',
        kind: 'tool_use',
        text: truncate(input, 1200),
        tool_name: payload.name ?? 'tool',
        timestamp,
      },
    ]
  }
  if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
    const output = compact(stringifyToolResult(payload.output))
    return output
      ? [
          {
            role: 'user',
            kind: 'tool_result',
            text: truncate(output, 2000),
            tool_name: null,
            timestamp,
          },
        ]
      : []
  }
  return []
}

/**
 * Bookkeeping the CLI writes into its own transcript that was never part of the conversation.
 *
 * Resuming a session whose last turn died on an API error makes `claude` repair the dangling tail
 * by appending a canned pair — user `isMeta: true` "Continue from where you left off." plus a
 * `<synthetic>` assistant "No response requested." — both stamped with the SAME millisecond,
 * because no model was ever called. Rendering them as real turns tells a story that never happened:
 * it reads as though we prompted the session and it refused, when the CLI was talking to itself
 * (mis-read exactly that way 2026-07-15; the run had in fact been sent nothing but "resume").
 *
 * The rate-limit notice is the ONE synthetic message worth keeping: it is also `<synthetic>` but
 * carries `isApiErrorMessage: true`, and it is the only thing on screen that explains why a session
 * stopped. Keep that; drop the self-talk.
 */
function isCliBookkeeping(ev: any): boolean {
  if (ev?.isMeta === true) return true
  return ev?.message?.model === '<synthetic>' && ev?.isApiErrorMessage !== true
}

/**
 * Plumbing the CLI wraps in pseudo-tags and stores as an ordinary user message: slash-command
 * invocations, hook output, bash echoes, the local-command caveat. It is addressed to the MODEL,
 * not written by the human, so it must never stand in for what a session is "about".
 *
 * Unlike the bookkeeping above, most of these carry no `isMeta` flag, so this tag scan is the only
 * thing that catches them. It is what keeps a `/usage` probe — a transcript holding nothing but a
 * caveat and a `<command-name>` line — from being listed as a real session (see sessions.ts).
 */
const COMMAND_WRAPPER =
  /^\s*<\/?(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/i

export function isCommandWrapperText(text: string): boolean {
  return COMMAND_WRAPPER.test(text)
}

/**
 * Pull a readable label out of a turn that is real work wrapped in a pseudo-tag.
 *
 * Distinct from COMMAND_WRAPPER above, and the difference is the whole point: that list is
 * plumbing to be ignored outright, whereas a `<scheduled-task name="…">` turn IS the session's
 * actual prompt — it just arrives wearing an envelope. Dropping it would leave a genuine session
 * titled with its uuid; keeping it whole titled one "<scheduled-task name="studio-executor-parity-
 * sweep" file="C:\Users\…">".
 *
 * Prefers a `name` attribute (someone chose that string as a label) and otherwise falls back to the
 * body text. Anything that isn't a wrapped turn passes through untouched.
 */
export function unwrapTaggedText(text: string): string {
  const open = text.match(/^\s*<([a-z][\w-]*)\b([^>]*)>/i)
  if (!open) return text
  const name = open[2].match(/\bname\s*=\s*"([^"]+)"/i)?.[1]
  if (name?.trim()) return name.trim()
  const body = text
    .slice(open[0].length)
    .replace(new RegExp(`</${open[1]}\\s*>\\s*$`, 'i'), '')
    .trim()
  return body || text
}

/** What a caller wants kept out of the raw stream. Every field defaults to the historical
 *  behaviour, so an unchanged caller gets an unchanged answer. */
export interface TailFilter {
  /** Emit `thinking` blocks as their own events instead of dropping them. Off by default: they are
   *  the bulkiest part of a transcript and the least useful part to skim. */
  thinking?: boolean
}

/**
 * THE hide-"thinking" filter. Turns one raw transcript JSONL event into zero or more
 * displayable TailEvents. Reused for both disk-tail reading and the live stream-json path,
 * so the rule lives in exactly one place (per the rebuild plan).
 *
 * Rules:
 *  - keep only user/assistant events
 *  - drop the CLI's own resume bookkeeping (see isCliBookkeeping)
 *  - drop `thinking` and `redacted_thinking` content blocks unless `filter.thinking` asks for them
 *  - assistant `text` -> text event
 *  - `tool_use` -> collapsed tool event (name + compact input)
 *  - user `tool_result` -> collapsed tool_result event
 *  - a plain-string user message -> text event
 */
export function eventToTailEvents(ev: any, filter: TailFilter = {}): TailEvent[] {
  const message = ev?.message
  const role: string | undefined = message?.role ?? ev?.type
  const type: string | undefined = ev?.type
  if (type !== 'user' && type !== 'assistant' && role !== 'user' && role !== 'assistant') return []
  if (isCliBookkeeping(ev)) return []
  const r: 'user' | 'assistant' =
    role === 'assistant' || type === 'assistant' ? 'assistant' : 'user'
  const ts: string | null = ev?.timestamp ?? null
  const content = message?.content
  const out: TailEvent[] = []

  if (typeof content === 'string') {
    const t = compact(content)
    if (t)
      out.push({ role: r, kind: 'text', text: truncate(t, 6000), tool_name: null, timestamp: ts })
    return out
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const bt = block.type
      if (bt === 'thinking' || bt === 'redacted_thinking') {
        // <- the filter. `redacted_thinking` carries an encrypted `data` field and no readable
        // text, so asking for thinking still shows nothing for it: there is nothing to show.
        if (!filter.thinking) continue
        const t = compact(typeof block.thinking === 'string' ? block.thinking : '')
        if (t)
          out.push({
            role: 'assistant',
            kind: 'thinking',
            text: truncate(t, 6000),
            tool_name: null,
            timestamp: ts,
          })
        continue
      }
      if (bt === 'text' && typeof block.text === 'string') {
        const t = compact(block.text)
        if (t)
          out.push({
            role: r,
            kind: 'text',
            text: truncate(t, 6000),
            tool_name: null,
            timestamp: ts,
          })
      } else if (bt === 'tool_use') {
        const input = block.input ? truncate(compact(JSON.stringify(block.input)), 1200) : ''
        out.push({
          role: 'assistant',
          kind: 'tool_use',
          text: input,
          tool_name: block.name ?? 'tool',
          timestamp: ts,
        })
      } else if (bt === 'tool_result') {
        const t = compact(stringifyToolResult(block.content))
        if (t)
          out.push({
            role: 'user',
            kind: 'tool_result',
            text: truncate(t, 2000),
            tool_name: null,
            timestamp: ts,
          })
      }
    }
  }
  return out
}

export function eventToTailEventsForSource(
  source: SessionSource,
  ev: any,
  filter: TailFilter = {},
): TailEvent[] {
  return source === 'codex' ? codexEventToTailEvents(ev) : eventToTailEvents(ev, filter)
}

export interface TailOptions {
  limit?: number
  /** When true, drop tool_use/tool_result and only count text-bearing turns toward the limit. */
  textOnly?: boolean
  /** Include the model's reasoning blocks (see TailFilter). */
  thinking?: boolean
  /** Only what a person typed. The point of `limit` is a window of turns, so this has to be applied
   *  BEFORE the window is counted — filtering 40 mixed turns client-side yields a handful of human
   *  ones, which is not a readable session. */
  humanOnly?: boolean
  title?: string
  cwd?: string
}

/** The display filter, as one predicate, so the two source paths below cannot drift apart.
 *  Exported for server/tests/tail-filter.test.ts, which pins the rules rather than the callers. */
export function tailKeeper(opts: TailOptions): (e: TailEvent) => boolean {
  if (opts.humanOnly) return (e) => e.kind === 'text' && e.role === 'user'
  if (opts.textOnly) return (e) => e.kind === 'text' || e.kind === 'thinking'
  return () => true
}

/** Read the last `limit` real turns of a session's transcript, thinking filtered out. */
export async function tailTranscript(
  sessionId: string,
  opts: TailOptions = {},
  source?: SessionSource,
): Promise<TailResult> {
  const limit = opts.limit ?? 40
  const keep = tailKeeper(opts)
  const filter: TailFilter = { thinking: opts.thinking ?? false }
  const tf = findTranscript(sessionId, source)
  if (!tf) {
    return {
      session_id: sessionId,
      source: source ?? 'claude',
      title: opts.title ?? sessionId,
      cwd: opts.cwd ?? '',
      events: [],
      error: 'transcript not found',
    }
  }
  if (tf.source === 'opencode') {
    const content = readOpenCodeSession(sessionId)
    if (!content) {
      return {
        session_id: sessionId,
        source: tf.source,
        title: opts.title ?? tf.title ?? sessionId,
        cwd: opts.cwd ?? tf.cwd ?? '',
        events: [],
        error: 'transcript not found',
      }
    }
    const events = content.events.filter(keep).slice(-limit)
    return {
      session_id: sessionId,
      source: tf.source,
      title: opts.title ?? tf.title ?? sessionId,
      cwd: opts.cwd ?? tf.cwd ?? '',
      events,
    }
  }
  const raw = await readTailBytes(tf.path, 6 * 1024 * 1024)
  const lines = raw.split('\n')
  const collected: TailEvent[][] = []
  let title = opts.title ?? ''
  let cwd = opts.cwd ?? ''

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof ev?.cwd === 'string') cwd = ev.cwd
    if (!cwd && typeof ev?.payload?.cwd === 'string') cwd = ev.payload.cwd
    const tes = eventToTailEventsForSource(tf.source, ev, filter).filter(keep)
    if (tes.length === 0) continue
    collected.push(tes)
    if (collected.length >= limit) break
  }

  const events = collected.reverse().flat()
  if (!title) title = sessionId
  return {
    session_id: sessionId,
    source: tf.source,
    title,
    cwd: cwd || decodeProjectKey(tf.project),
    events,
  }
}
