// server/src/dsh-sessions.ts — reader for DeepSeek Harness (`@deepseek-ai/dsh`) session logs.
//
// Written against the harness's OWN shipped source, not against a guess: `@deepseek-ai/dsh` installs
// unminified JavaScript with its types beside it, so every rule below was read out of the package
// this machine has (0.1.5-rc.1) rather than inferred from one transcript. Nothing here ports its
// code — this is a from-scratch reader against its on-disk shapes, the same relationship
// server/src/opencode-sessions.ts has to OpenCode's schema and hermes-sessions.ts to Hermes's.
//
// THE STORE, AND WHY IT IS A THIRD SHAPE. Claude and Codex write one flat JSONL per session;
// OpenCode and Hermes keep every session in one SQLite database. DSH is neither: it writes ONE FILE
// PER SESSION, like Claude, but the bytes are ZSTANDARD FRAMES, so every generic path in this
// codebase that opens a transcript and reads lines gets binary and silently finds nothing. That is
// the whole reason this file exists rather than a `format: 'claude'` catalog row.
//
//   <DSH_HOME>/sessions/<project-key>/<session-id>/session.v3.jsonl.zstd   the log
//   <DSH_HOME>/storages/session_projcache/sessions/<session-id>.json       a PROJECTION of it
//   <DSH_HOME>/storages/workspace.json                                     workspaces + archived ids
//
// THE PROJECTION IS WHY LISTING IS CHEAP. `session_projcache` is the harness's own materialized view
// of each log — title, cwd, created-at, token totals, turn count, the last prompt's timestamp — so a
// list of two hundred sessions costs two hundred small JSON reads instead of two hundred
// decompressions. It is a CACHE and is treated as one: every field it provides is re-derivable from
// the log, a session with no projection (or a stale one) still lists by decoding its header, and
// nothing here fails because the projection is missing. See dshProjection.
//
// MULTI-FRAME, AND THE TAIL CAN BE TORN. The log is appended as independent zstd frames — 8 frames
// for a 20-record session here, one per flush, NOT one per record — and the harness documents
// "torn-tail crash recovery", which means the last frame on disk may be half-written at the moment
// we read it. A whole-buffer decode of that throws, and throwing would make a LIVE session
// unreadable exactly while it is interesting. So a failed decode falls back to the longest prefix
// that ends on a frame boundary and decodes (see decodeZstdTolerant), which costs nothing in the
// normal case because the normal case succeeds on the first try.
//
// READONLY, ALWAYS. The harness owns these files; this reader opens them for reading and never
// writes, moves or repairs one — same contract as every other store AgentHydra reads.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { TailEvent } from './types'

/** The last segment of a path on EITHER separator. A cwd is whatever the harness recorded, so a
 *  home written on Windows keeps its backslashes wherever it is read. */
const pathLeaf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Directory names inside a DSH home. Named once because three different readers below join them. */
const SESSIONS_DIR = 'sessions'
const PROJCACHE_DIR = join('storages', 'session_projcache', 'sessions')
const WORKSPACE_FILE = join('storages', 'workspace.json')

/**
 * Hard ceiling on one decompressed session log.
 *
 * A zstd log is small on disk and large in memory — the sample session here is 14 KB compressed and
 * 42 KB out, and a long agent run is tens of megabytes of tool output — so the decompressed size,
 * not the file size, is what a reader must bound. 64 MB is far past any real conversation and still
 * far under a size that would threaten the daemon; past it the session lists (from its projection)
 * but reads as empty rather than taking the process down with it.
 */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024

/** The zstd frame magic (little-endian 0xFD2FB528). Only used to find a torn tail's last good cut. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const compact = (value: string): string => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

function iso(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Decompress a whole multi-frame zstd log, tolerating a half-written final frame.
 *
 * The fast path is the first line and it is what runs for every settled session. The retry exists
 * for one case: a session being written WHILE we read it, whose last frame is incomplete. Frames are
 * self-delimiting, so the fix is to decode the longest prefix that ends where a frame began — found
 * by walking back through the frame magic. The magic can also occur by chance inside compressed
 * data, which is why a candidate cut is accepted only when the decode of it actually succeeds, and
 * why there is an attempt cap: a genuinely corrupt file must cost a bounded number of tries, not a
 * walk back through every byte that happens to look like a frame header.
 */
function decodeZstdTolerant(raw: Buffer): Buffer | null {
  const opts = { maxOutputLength: MAX_DECOMPRESSED_BYTES }
  try {
    return zstdDecompressSync(raw, opts)
  } catch {
    // fall through to the torn-tail retry
  }
  const cuts: number[] = []
  for (let i = raw.length - ZSTD_MAGIC.length; i > 0 && cuts.length < 8; i--) {
    if (raw.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, i, i + ZSTD_MAGIC.length) === 0) cuts.push(i)
  }
  for (const cut of cuts) {
    try {
      return zstdDecompressSync(raw.subarray(0, cut), opts)
    } catch {
      // this cut was a coincidence inside frame data, or the prefix is damaged too — try the next
    }
  }
  return null
}

/** One record of a DSH session log. `type` is the discriminant; `data` is that type's own payload. */
export interface DshEvent {
  type: string
  seq?: number
  time?: number
  data?: any
  /** Only the header line carries these: it is the physical session header, not a SessionEventMap event. */
  id?: string
  version?: number
  createdAt?: number
  cwd?: string
}

/**
 * Every record of one session log, in order.
 *
 * Both spellings are read. `compression: 'none'` is a supported harness setting and writes the same
 * JSONL uncompressed, so a `.jsonl` with no `.zstd` suffix is a valid log and not a leftover.
 *
 * A line that does not parse is skipped rather than fatal — the last line of a log being written to
 * is routinely a partial record, and one unreadable record must not cost the other nine hundred.
 */
export function readDshLog(path: string): DshEvent[] {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return []
  }
  const text = path.endsWith('.zstd')
    ? decodeZstdTolerant(raw)?.toString('utf8')
    : raw.toString('utf8')
  if (!text) return []
  const out: DshEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') out.push(parsed)
    } catch {
      // a torn final line, or a record from a newer harness we cannot parse: skip it
    }
  }
  return out
}

// --- store discovery ----------------------------------------------------------------------------

/** The current log inside one session directory, or null when the directory holds none.
 *
 *  A session directory can hold SEVERAL generations — the backend "retains immutable historical
 *  format generations" across a format migration, so `session.v2.jsonl.zstd` can sit beside the
 *  `session.v3.jsonl.zstd` that superseded it. The highest version is the live one; reading an older
 *  generation would replay a conversation the harness itself has already migrated past. */
function currentLogFile(sessionDir: string): { path: string; version: number } | null {
  let best: { path: string; version: number } | null = null
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return null
  }
  for (const name of names) {
    const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (!best || version > best.version) best = { path: join(sessionDir, name), version }
  }
  return best
}

/** The archived session ids recorded in a home's workspace store, as a set for membership tests.
 *
 *  Archiving is a REAL state in DSH (the workspace store keeps `archivedSessionIds`), which is the
 *  half of the story the `foreign` lane cannot tell — every adapter there hardcodes `archived:
 *  false`. Reading it is what lets an archived DSH chat be filtered the same way an archived Claude
 *  or Codex one is. */
function archivedIds(root: string): Set<string> {
  const store = readJson<{ global?: { archivedSessionIds?: unknown } }>(join(root, WORKSPACE_FILE))
  const ids = store?.global?.archivedSessionIds
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

/** The harness's own projection of one session, when it has one. Shapes are read defensively: this
 *  is a cache whose version field (7, here) is free to move without warning, and every field it
 *  offers has a fallback in the log itself. */
interface DshProjection {
  identity?: { createdAt?: number; cwd?: string; formatVersion?: number }
  rows?: Record<string, { val?: any } | undefined>
}

function dshProjection(root: string, sessionId: string): DshProjection | null {
  return (
    readJson<{ record?: DshProjection }>(join(root, PROJCACHE_DIR, `${sessionId}.json`))?.record ??
    null
  )
}

const projRow = <T>(proj: DshProjection | null, name: string): T | undefined =>
  proj?.rows?.[name]?.val as T | undefined

// --- session listing ----------------------------------------------------------------------------

export interface DshSessionRecord {
  session_id: string
  /** The workspace this ran in, by its folder name — what the harness's own session list calls it. */
  project: string
  cwd: string
  title: string
  created_at: number | null
  last_activity_at: number
  archived: boolean
  size_bytes: number
  /** Absolute path to the log file itself, which is this store's per-session identity. */
  path: string
}

/**
 * Every session under one DSH home.
 *
 * The DIRECTORY WALK is the source of truth for what exists, not the workspace store and not the
 * projection cache: a session's log is written before anything else knows about it, and a workspace
 * entry can name a session whose files were removed. Metadata then comes from the projection when
 * there is one and from the log's own header when there is not, so a session is never invisible
 * merely because a cache has not caught up.
 *
 * The project-key directory is NOT decoded back into a path. Its encoding is documented as lossy
 * (separators collapse, unsafe characters escape, the whole thing truncates at 251 characters), so
 * the only trustworthy cwd is the one the session itself recorded.
 */
export function listDshSessions(root: string): DshSessionRecord[] {
  const sessionsRoot = join(root, SESSIONS_DIR)
  if (!existsSync(sessionsRoot)) return []
  const archived = archivedIds(root)
  const out: DshSessionRecord[] = []

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  for (const projectDir of projectDirs) {
    let sessionDirs: string[]
    try {
      sessionDirs = readdirSync(join(sessionsRoot, projectDir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const sessionId of sessionDirs) {
      const log = currentLogFile(join(sessionsRoot, projectDir, sessionId))
      if (!log) continue
      let size = 0
      let mtime = 0
      try {
        const st = statSync(log.path)
        size = st.size
        mtime = st.mtimeMs
      } catch {
        continue // the session was removed between the two reads; it is not a session any more
      }

      const proj = dshProjection(root, sessionId)
      let cwd = typeof proj?.identity?.cwd === 'string' ? proj.identity.cwd : ''
      const title = projRow<string>(proj, 'title') ?? ''
      let created = typeof proj?.identity?.createdAt === 'number' ? proj.identity.createdAt : null
      const lastPromptAt = projRow<{ lastPromptAt?: number }>(
        proj,
        'sessionListMetadata',
      )?.lastPromptAt

      if (!cwd || !created) {
        // No projection (or an incomplete one): the log's first record is the session header and
        // carries both. One decode of a session that is usually small, and only for the sessions
        // the cache does not already answer for.
        const header = readDshLog(log.path)[0]
        if (header?.type === 'session') {
          if (!cwd && typeof header.cwd === 'string') cwd = header.cwd
          if (!created && typeof header.createdAt === 'number') created = header.createdAt
        }
      }

      out.push({
        session_id: sessionId,
        // The cwd is whatever the HARNESS recorded, so a home written on Windows carries
        // backslashes wherever it is read; node's basename only splits on the host's separator,
        // which is why the Linux CI leg listed `D:\work\scratch` as the whole project name.
        project: cwd ? pathLeaf(cwd) || cwd : projectDir,
        cwd,
        title: compact(title),
        created_at: created,
        // The file's own mtime is the honest "last activity": the projection's lastPromptAt is when
        // the HUMAN last spoke, which on a long agent run is minutes or hours behind the work.
        last_activity_at: Math.max(mtime, typeof lastPromptAt === 'number' ? lastPromptAt : 0),
        archived: archived.has(sessionId),
        size_bytes: size,
        path: log.path,
      })
    }
  }
  return out
}

// --- transcript ---------------------------------------------------------------------------------

/** Text out of one message's content blocks, ignoring the block kinds a transcript should not show
 *  as prose (images, attachments). Reasoning is kept but tagged by the caller as `thinking`. */
function blockText(content: unknown, want: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, any>
    if (b.type === want && typeof b.text === 'string') parts.push(b.text)
  }
  return compact(parts.join('\n'))
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface DshSessionContent {
  events: TailEvent[]
  messageCount: number
}

/**
 * One session's conversation, as the same display DTO every other source produces.
 *
 * WHAT IS SHOWN, AND WHAT IS DELIBERATELY NOT. A DSH log records fifty-odd event types, most of
 * which are bookkeeping — permission presets, sandbox modes, inbox splices, step boundaries, the
 * request header, the title model's own little LLM call. What a transcript is for is who said what,
 * so this maps the four that carry that and drops the rest:
 *
 *   user/message      → a turn, but ONLY when its source is the human. The harness injects its own
 *                       runtime-context snapshots as user messages with `source.kind: 'plugin'`, and
 *                       showing those would put "Current DSH file policy: workspace-write…" on
 *                       screen as though the user had typed it.
 *   assistant/message → the reply, with `reasoning` blocks kept as `thinking` so a collapsed
 *                       transcript matches what the other sources produce.
 *   tool/call         → the tool and its raw arguments.
 *   tool/result       → its outcome, attributed to the tool by callId.
 *
 * system/message is excluded on purpose: it is the assembled system prompt (7.5 KB in a one-line
 * test session), it is regenerated every step, and no other source's transcript shows it.
 */
export function readDshSession(path: string): DshSessionContent | null {
  const records = readDshLog(path)
  if (records.length === 0) return null

  const events: TailEvent[] = []
  let messageCount = 0
  /** callId → tool name, so a result can name the tool that produced it. */
  const toolNames = new Map<string, string>()

  for (const rec of records) {
    const time = iso(rec.time)
    const data = rec.data ?? {}
    switch (rec.type) {
      case 'user/message': {
        if (data?.source?.kind !== 'user') continue
        const text = blockText(data.content, 'text')
        if (!text) continue
        events.push({
          role: 'user',
          kind: 'text',
          text: truncate(text, 6000),
          tool_name: null,
          timestamp: time,
        })
        messageCount++
        continue
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const thinking = blockText(message.content, 'reasoning')
        if (thinking)
          events.push({
            role: 'assistant',
            kind: 'thinking',
            text: truncate(thinking, 6000),
            tool_name: null,
            timestamp: time,
          })
        const text = blockText(message.content, 'text')
        if (text) {
          events.push({
            role: 'assistant',
            kind: 'text',
            text: truncate(text, 6000),
            tool_name: null,
            timestamp: time,
          })
          messageCount++
        }
        continue
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        if (typeof data.callId === 'string') toolNames.set(data.callId, name)
        events.push({
          role: 'assistant',
          kind: 'tool_use',
          // `arguments` is the raw JSON string the model produced, unparsed by the harness itself.
          text: truncate(compact(printable(data.arguments)), 1200),
          tool_name: name,
          timestamp: time,
        })
        continue
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const block = Array.isArray(message.content) ? message.content[0] : null
        const callId = block?.callId ?? message.source?.callId
        const text = compact(blockText(block?.content, 'text') || printable(block?.content))
        if (!text) continue
        events.push({
          role: 'user',
          kind: 'tool_result',
          text: truncate(text, 2000),
          tool_name: (typeof callId === 'string' ? toolNames.get(callId) : null) ?? null,
          timestamp: time,
        })
        continue
      }
      default:
        continue
    }
  }
  return { events, messageCount }
}

// --- usage --------------------------------------------------------------------------------------

export interface DshUsageRow {
  /** The route that produced the turn, as `<provider>/<model>` — `deepseek-official/deepseek-flash`. */
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  /** Epoch ms of the turn itself: DSH timestamps every record, so spend lands on the right day. */
  time_ms: number | null
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Per-turn token usage for one session, one row per assistant message that reported accounting.
 *
 * ⛔ DSH'S COUNTS ARE DISJOINT, AND THAT IS THE WHOLE CORRECTNESS STORY HERE. Its own type
 * documents `inputTokens` as UNCACHED input only, with cached input reported separately as
 * `cacheReadTokens`/`cacheWriteTokens` and billed input being the sum of the three — the same
 * convention Anthropic uses and the same one server/src/usage-foreign.ts's addTurn expects. An
 * adapter that folded cache reads back into input would double-count every cached token, which on a
 * long session is most of them.
 *
 * `usage` is OPTIONAL on the event (absent when the adapter reported no accounting), so a session
 * can legitimately produce fewer rows than it had turns; a missing count is left null rather than
 * zeroed, because zero is a claim that the turn was free.
 */
export function readDshUsage(path: string): DshUsageRow[] {
  const out: DshUsageRow[] = []
  for (const rec of readDshLog(path)) {
    if (rec.type !== 'assistant/message') continue
    const usage = rec.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const source = rec.data?.message?.source ?? {}
    const provider = typeof source.provider === 'string' ? source.provider : null
    const model = typeof source.model === 'string' ? source.model : null
    out.push({
      model: model ? (provider ? `${provider}/${model}` : model) : null,
      tokens_input: num(usage.inputTokens),
      tokens_output: num(usage.outputTokens),
      tokens_reasoning: num(usage.reasoningTokens),
      tokens_cache_read: num(usage.cacheReadTokens),
      tokens_cache_write: num(usage.cacheWriteTokens),
      time_ms: num(rec.time),
    })
  }
  return out
}
