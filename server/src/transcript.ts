import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
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

function buildTranscriptIndex(): TranscriptFile[] {
  const now = performance.now()
  const files: TranscriptFile[] = []
  const claudeGlob = new Bun.Glob('*/*.jsonl')
  for (const rel of claudeGlob.scanSync({ cwd: CLAUDE_PROJECTS_ROOT, onlyFiles: true })) {
    const path = join(CLAUDE_PROJECTS_ROOT, rel)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    const project = rel.split(/[\\/]/)[0]
    files.push({
      session_id: basename(rel).replace(/\.jsonl$/, ''),
      source: 'claude',
      path,
      project,
      mtime_ms: st.mtimeMs,
      size_bytes: st.size,
      archived: false,
    })
  }

  const codexSessionIndex = readCodexSessionIndex()
  const addCodexRoot = (root: string, archived: boolean) => {
    const glob = new Bun.Glob('**/rollout-*.jsonl')
    for (const rel of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const path = join(root, rel)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const name = basename(rel).replace(/\.jsonl$/, '')
      const rolloutId =
        name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? name
      const identity = readCodexRolloutIdentity(path, rolloutId)
      // Subagents are implementation detail of their parent chat. Their visible user history is a
      // forked copy of that chat, so merging them would duplicate turns; the top-level rollout is
      // the complete user-facing conversation and is the only row Codex itself exposes.
      if (identity.isSubagent) continue
      const indexed = codexSessionIndex.get(identity.sessionId)
      files.push({
        session_id: identity.sessionId,
        source: 'codex',
        path,
        project: 'codex',
        mtime_ms: Math.max(st.mtimeMs, indexed?.updatedAt ?? 0),
        size_bytes: st.size,
        archived,
        title: indexed?.title,
      })
    }
  }
  addCodexRoot(CODEX_SESSIONS_ROOT, false)
  addCodexRoot(CODEX_ARCHIVED_SESSIONS_ROOT, true)

  for (const session of listOpenCodeSessions()) {
    files.push({
      session_id: session.session_id,
      source: 'opencode',
      path: OPENCODE_DB_PATH,
      project: session.project,
      mtime_ms: session.last_activity_at,
      size_bytes: session.size_bytes,
      archived: session.archived,
      title: session.title,
      cwd: session.cwd,
      created_at: session.created_at,
    })
  }

  // A moved JSONL can briefly appear in both active and archived roots while filesystem caches
  // settle. Source + id is the identity; newest wins, matching findTranscript's old behavior.
  const unique = new Map<string, TranscriptFile>()
  for (const file of files) {
    const key = `${file.source}:${file.session_id}`
    const previous = unique.get(key)
    if (!previous || file.mtime_ms >= previous.mtime_ms) unique.set(key, file)
  }
  const result = [...unique.values()]
  cache = { at: now, files: result }
  return result
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

/**
 * THE hide-"thinking" filter. Turns one raw transcript JSONL event into zero or more
 * displayable TailEvents. Reused for both disk-tail reading and the live stream-json path,
 * so the rule lives in exactly one place (per the rebuild plan).
 *
 * Rules:
 *  - keep only user/assistant events
 *  - drop the CLI's own resume bookkeeping (see isCliBookkeeping)
 *  - drop `thinking` and `redacted_thinking` content blocks entirely (explicit type check)
 *  - assistant `text` -> text event
 *  - `tool_use` -> collapsed tool event (name + compact input)
 *  - user `tool_result` -> collapsed tool_result event
 *  - a plain-string user message -> text event
 */
export function eventToTailEvents(ev: any): TailEvent[] {
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
      if (bt === 'thinking' || bt === 'redacted_thinking') continue // <- the filter
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

export function eventToTailEventsForSource(source: SessionSource, ev: any): TailEvent[] {
  return source === 'codex' ? codexEventToTailEvents(ev) : eventToTailEvents(ev)
}

export interface TailOptions {
  limit?: number
  /** When true, drop tool_use/tool_result and only count text-bearing turns toward the limit. */
  textOnly?: boolean
  title?: string
  cwd?: string
}

/** Read the last `limit` real turns of a session's transcript, thinking filtered out. */
export async function tailTranscript(
  sessionId: string,
  opts: TailOptions = {},
  source?: SessionSource,
): Promise<TailResult> {
  const limit = opts.limit ?? 40
  const textOnly = opts.textOnly ?? false
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
    const events = (
      textOnly ? content.events.filter((event) => event.kind === 'text') : content.events
    ).slice(-limit)
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
    let tes = eventToTailEventsForSource(tf.source, ev)
    if (textOnly) tes = tes.filter((e) => e.kind === 'text')
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
