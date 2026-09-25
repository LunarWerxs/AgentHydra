// server/src/foreign-sessions.ts — conversations from tools with a shape all their own.
//
// WHY A FOURTH READER RATHER THAN FOUR MORE. Claude, Codex and OpenCode each earned a source of
// their own because each has a parser, a tail reader, a usage model and a UI story. The tools here
// have none of that in common with them and little in common with each other — but they DO share
// the only thing that matters at this layer: each keeps a list of conversations somewhere, each can
// be turned into "who said what, when", and none of them records per-token usage the way the API
// providers do. So they get ONE source (`foreign`) and one adapter apiece, which is a table entry
// and a function rather than a fifth of the codebase.
//
// WHAT AN ADAPTER OWES: a list of sessions under a root, and the events of one session. Everything
// else — the list, search, export, the tab — comes for free from the shared DTOs.
//
// NO TOKENS, AND THAT IS NOT AN OVERSIGHT. Not one of these stores records what a turn cost.
// Copilot and the IDE integrations bill credits and never write a token count at all; Grok, Kimi
// and Zed simply do not persist one. So these sessions appear in the list, are readable and
// searchable, and contribute NOTHING to the spend charts. A zero there would be a claim they were
// free; an absence is the truth. Pi is the one exception - its assistant messages carry `usage` and
// `cost` - but pricing it would be a spend reader of its own, so for now it is read like the rest.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TailEvent } from './types'

/** One conversation from a foreign store, in the shape the transcript index wants. */
export interface ForeignSession {
  session_id: string
  /** Absolute path to whatever the adapter will be handed back to read the conversation. */
  path: string
  title: string
  cwd: string
  project: string
  created_at: number | null
  last_activity_at: number
  size_bytes: number
  archived: boolean
}

interface Adapter {
  list(root: string): ForeignSession[]
  /**
   * The same listing for a caller that can wait, and therefore must not be blocked.
   *
   * Optional, because most of these stores are a handful of small files and reading them is over
   * before yielding would have cost anything. It exists for the one that is not: a VS Code store
   * has to be JSON-parsed in full, which measured 5.2 s cold — inside the whole-store sweep, which
   * is async exactly so the daemon can keep answering while it runs.
   */
  listAsync?(root: string): Promise<ForeignSession[]>
  read(path: string): TailEvent[]
}

const iso = (ms: number): string => new Date(ms).toISOString()
const compact = (s: string): string => s.replace(/\s+/g, ' ').trim()
const truncate = (s: string, n = 6000): string => (s.length > n ? `${s.slice(0, n)}…` : s)

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** A title from the first thing the user actually said, when the store records no title of its own. */
function titleFromText(text: string, fallback: string): string {
  const t = compact(text)
  return t ? truncate(t, 120) : fallback
}

// --- Grok ---------------------------------------------------------------------------------------
// `<root>/<session-uuid>/` with summary.json (a generated title, the cwd, both timestamps),
// chat_history.jsonl (the conversation) and events.jsonl (per-turn timing). Assistant records carry
// `model_id` but no token counts anywhere in the directory.

interface GrokSummary {
  info?: { id?: string; cwd?: string }
  session_summary?: string
  created_at?: string
  updated_at?: string
  num_messages?: number
}

const grok: Adapter = {
  list(root) {
    const out: ForeignSession[] = []
    for (const id of dirs(root)) {
      const dir = join(root, id)
      const history = join(dir, 'chat_history.jsonl')
      if (!existsSync(history)) continue
      const s = readJson<GrokSummary>(join(dir, 'summary.json'))
      const created = s?.created_at ? Date.parse(s.created_at) : Number.NaN
      const updated = s?.updated_at ? Date.parse(s.updated_at) : Number.NaN
      const cwd = s?.info?.cwd && s.info.cwd !== '.' ? s.info.cwd : ''
      out.push({
        session_id: id,
        path: history,
        title: s?.session_summary?.trim() || 'Grok session',
        cwd,
        project: cwd || 'grok',
        created_at: Number.isFinite(created) ? created : null,
        last_activity_at: Number.isFinite(updated) ? updated : mtimeOf(history),
        size_bytes: sizeOf(history),
        archived: false,
      })
    }
    return out
  },
  read(path) {
    const out: TailEvent[] = []
    // Grok records no per-message timestamp, only per-turn events in a sibling file. The file's own
    // mtime is the honest stand-in: it dates the conversation without inventing a time per message.
    const at = iso(mtimeOf(path))
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return out
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec: {
        type?: string
        content?: unknown
        tool_calls?: Array<{ name?: string }>
      }
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      // The system prompt is machinery, not conversation, and it is enormous.
      if (rec.type !== 'user' && rec.type !== 'assistant') continue
      const role = rec.type
      for (const call of rec.tool_calls ?? [])
        out.push({
          role,
          kind: 'tool_use',
          text: '',
          tool_name: call.name ?? 'tool',
          timestamp: at,
        })
      const body = Array.isArray(rec.content)
        ? rec.content
            .map((c) => (c && typeof c === 'object' ? ((c as { text?: string }).text ?? '') : ''))
            .join('\n')
        : typeof rec.content === 'string'
          ? rec.content
          : ''
      const t = compact(body)
      if (t) out.push({ role, kind: 'text', text: truncate(t), tool_name: null, timestamp: at })
    }
    return out
  },
}

// --- Kimi ---------------------------------------------------------------------------------------
// `<root>/wd_<workspace>_<hash>/session_<uuid>/` with state.json (title and both timestamps) and
// one wire.jsonl per agent under agents/. Only the `main` agent is the user's conversation; the
// numbered ones are its delegated workers.

interface KimiState {
  createdAt?: string
  updatedAt?: string
  title?: string
  agents?: Record<string, { homedir?: string; cwd?: string }>
}

const kimi: Adapter = {
  list(root) {
    const out: ForeignSession[] = []
    for (const wd of dirs(root)) {
      for (const session of dirs(join(root, wd))) {
        const dir = join(root, wd, session)
        const wire = join(dir, 'agents', 'main', 'wire.jsonl')
        if (!existsSync(wire)) continue
        const st = readJson<KimiState>(join(dir, 'state.json'))
        const created = st?.createdAt ? Date.parse(st.createdAt) : Number.NaN
        const updated = st?.updatedAt ? Date.parse(st.updatedAt) : Number.NaN
        const cwd = st?.agents?.main?.cwd ?? ''
        out.push({
          session_id: session.replace(/^session_/, ''),
          path: wire,
          title: st?.title?.trim() || 'Kimi session',
          cwd,
          // The workspace directory carries the project name that produced it.
          project: cwd || wd.replace(/^wd_/, '').replace(/_[0-9a-f]{8,}$/, ''),
          created_at: Number.isFinite(created) ? created : null,
          last_activity_at: Number.isFinite(updated) ? updated : mtimeOf(wire),
          size_bytes: sizeOf(wire),
          archived: false,
        })
      }
    }
    return out
  },
  read(path) {
    const out: TailEvent[] = []
    const at = iso(mtimeOf(path))
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return out
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec: { role?: string; content?: unknown; type?: string }
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const role = rec.role === 'user' || rec.role === 'assistant' ? rec.role : null
      if (!role) continue
      const body =
        typeof rec.content === 'string'
          ? rec.content
          : Array.isArray(rec.content)
            ? rec.content
                .map((c) =>
                  c && typeof c === 'object' ? ((c as { text?: string }).text ?? '') : '',
                )
                .join('\n')
            : ''
      const t = compact(body)
      if (t) out.push({ role, kind: 'text', text: truncate(t), tool_name: null, timestamp: at })
    }
    return out
  },
}

// --- VS Code Copilot ------------------------------------------------------------------------------
// `<root>/workspaceStorage/<hash>/chatSessions/<uuid>.json`. One JSON document per chat with a
// `requests` array; each request has the user's text, an epoch-ms timestamp, and a `response` array
// of kind-tagged parts. Nothing anywhere records tokens: Copilot bills premium requests.

interface VsCodeChat {
  sessionId?: string
  creationDate?: number
  lastMessageDate?: number
  requests?: Array<{
    timestamp?: number
    message?: { text?: string }
    response?: Array<Record<string, unknown>>
  }>
}

/** The readable text of one response part. Copilot's parts are a tagged union and most of them are
 *  UI furniture; the two that carry what the model actually said are handled, the rest named. */
function vsCodeResponseText(part: Record<string, unknown>): { text: string; tool: string | null } {
  const kind = typeof part.kind === 'string' ? part.kind : ''
  if (kind === 'toolInvocationSerialized') {
    const msg = part.pastTenseMessage ?? part.invocationMessage
    const value =
      msg && typeof msg === 'object' ? ((msg as { value?: string }).value ?? '') : String(msg ?? '')
    return { text: compact(value), tool: 'tool' }
  }
  // A plain markdown part is `{ value: "..." }` with no kind at all.
  const value = part.value
  if (typeof value === 'string') return { text: compact(value), tool: null }
  if (value && typeof value === 'object')
    return { text: compact((value as { value?: string }).value ?? ''), tool: null }
  return { text: '', tool: null }
}

/**
 * Listed chats, keyed by path, valid only while the file is byte-for-byte the one that was parsed.
 *
 * Listing a VS Code store means JSON.parse-ing every chat document, because that is the only place
 * the title and timestamps live — there is no index file to read instead. That is not free at any
 * real size: 355 chats measured 5.2 SECONDS, which was the single largest slice of a whole-store
 * sweep, and the sweep runs on a timer. A chat that has not been touched since the last sweep will
 * parse to exactly what it parsed to last time, so this keeps that answer and re-reads only what
 * actually changed. Two stats replace a full parse; the same trade the Codex identity cache makes.
 */
const vsCodeChatCache = new Map<string, { stamp: string; session: ForeignSession | null }>()

/**
 * The listing, one chat at a time.
 *
 * A generator rather than a loop so the two callers can share it exactly: {@link Adapter.list}
 * drains it in one go, and the async path drains it a chunk at a time, handing the event loop back
 * in between. The cache bookkeeping and the prune live here, once, so the two cannot drift — and
 * the prune sits in a `finally` so it still runs when a caller stops draining early.
 */
function* vsCodeChats(root: string): Generator<ForeignSession | null> {
  const storage = join(root, 'workspaceStorage')
  const seen = new Set<string>()
  try {
    yield* vsCodeChatsUnder(storage, seen)
  } finally {
    // Deleted chats must not keep their slot forever. Scoped to the paths under THIS root, because
    // one cache serves every VS Code flavour on the machine (Code, Insiders, VSCodium) and each is
    // listed by its own call — a sweep of one is no evidence at all about another's files.
    for (const path of vsCodeChatCache.keys())
      if (path.startsWith(storage) && !seen.has(path)) vsCodeChatCache.delete(path)
  }
}

function* vsCodeChatsUnder(storage: string, seen: Set<string>): Generator<ForeignSession | null> {
  for (const hash of dirs(storage)) {
    const chats = join(storage, hash, 'chatSessions')
    let names: string[]
    try {
      names = readdirSync(chats).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(chats, name)
      seen.add(path)
      // mtime AND size: mtime alone can repeat within a filesystem's timestamp granularity, and
      // an edit that keeps the byte count is exactly the case a coarse clock hides.
      let stamp: string
      let size = 0
      try {
        const st = statSync(path)
        size = st.size
        stamp = `${st.mtimeMs}:${st.size}`
      } catch {
        yield null
        continue
      }
      const hit = vsCodeChatCache.get(path)
      if (hit?.stamp === stamp) {
        yield hit.session
        continue
      }
      const doc = readJson<VsCodeChat>(path)
      // A read that FAILED is not remembered. readJson answers null for a locked or half-written
      // file exactly as it does for a malformed one, and VS Code is usually running while this
      // sweep happens — so caching that null would drop a perfectly good chat out of the list
      // until something happened to edit it again. An empty chat is a real, stable answer and IS
      // remembered, so it is not re-parsed every sweep.
      if (!doc) {
        yield null
        continue
      }
      if (!doc.requests?.length) {
        vsCodeChatCache.set(path, { stamp, session: null })
        yield null
        continue
      }
      const first = doc.requests[0]?.message?.text ?? ''
      const session: ForeignSession = {
        session_id: doc.sessionId || name.replace(/\.json$/, ''),
        path,
        title: titleFromText(first, 'Copilot chat'),
        cwd: '',
        // VS Code identifies a workspace by an opaque hash, so that is the honest grouping key —
        // inventing a folder name from it would be a guess the user cannot check.
        project: hash,
        created_at: doc.creationDate ?? null,
        last_activity_at: doc.lastMessageDate ?? doc.creationDate ?? mtimeOf(path),
        size_bytes: size,
        archived: false,
      }
      vsCodeChatCache.set(path, { stamp, session })
      yield session
    }
  }
}

const vscodeCopilot: Adapter = {
  list: (root) => [...vsCodeChats(root)].filter((s): s is ForeignSession => s !== null),
  /**
   * The same listing, handing the loop back every so often.
   *
   * The whole-store sweep is async precisely so the daemon keeps answering while it runs, and a
   * synchronous call inside it defeats that no matter what wraps it. Parsing this store cold
   * measured 5.2 s in one unbroken block — long enough that the FIRST sweep after launch, when
   * nothing is cached yet, froze the daemon for about six seconds while it ran.
   */
  async listAsync(root) {
    const out: ForeignSession[] = []
    let examined = 0
    for (const session of vsCodeChats(root)) {
      if (session) out.push(session)
      // Counted per FILE LOOKED AT, not per session returned. A chat that is empty, unreadable, or
      // cached-as-empty still costs a stat and often a full parse while contributing no row, so
      // budgeting by results would let an arbitrarily long run of them execute with no await in it
      // at all — which on a profile full of abandoned chat panels is the whole freeze, back again.
      if (++examined % 32 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return out
  },
  read(path) {
    const out: TailEvent[] = []
    const doc = readJson<VsCodeChat>(path)
    for (const req of doc?.requests ?? []) {
      const at = iso(req.timestamp ?? doc?.creationDate ?? mtimeOf(path))
      const asked = compact(req.message?.text ?? '')
      if (asked)
        out.push({
          role: 'user',
          kind: 'text',
          text: truncate(asked),
          tool_name: null,
          timestamp: at,
        })
      for (const part of req.response ?? []) {
        if (!part || typeof part !== 'object') continue
        const { text, tool } = vsCodeResponseText(part)
        if (!text) continue
        out.push({
          role: 'assistant',
          kind: tool ? 'tool_use' : 'text',
          text: truncate(text),
          tool_name: tool,
          timestamp: at,
        })
      }
    }
    return out
  },
}

// --- Copilot CLI ----------------------------------------------------------------------------------
// `<root>/session-state/<uuid>/` with workspace.yaml (id, cwd, repository, branch, both timestamps)
// and a checkpoints/index.md. There is no transcript: the CLI keeps state and checkpoints, not the
// conversation. So these sessions are listed with everything the store DOES record, and open to a
// short note saying why there is nothing to read.

const YAML_LINE = /^([a-z_]+):\s*(.*)$/

function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = YAML_LINE.exec(line.trim())
    if (m?.[1]) out[m[1]] = (m[2] ?? '').trim()
  }
  return out
}

const copilotCli: Adapter = {
  list(root) {
    const out: ForeignSession[] = []
    const stateRoot = join(root, 'session-state')
    for (const id of dirs(stateRoot)) {
      const dir = join(stateRoot, id)
      const yaml = join(dir, 'workspace.yaml')
      if (!existsSync(yaml)) continue
      let meta: Record<string, string>
      try {
        meta = parseFlatYaml(readFileSync(yaml, 'utf8'))
      } catch {
        continue
      }
      const created = meta.created_at ? Date.parse(meta.created_at) : Number.NaN
      const updated = meta.updated_at ? Date.parse(meta.updated_at) : Number.NaN
      const cwd = meta.cwd ?? ''
      out.push({
        session_id: meta.id || id,
        path: yaml,
        title: meta.repository
          ? `${meta.repository}${meta.branch ? ` (${meta.branch})` : ''}`
          : cwd || 'Copilot CLI session',
        cwd,
        project: cwd || meta.repository || 'copilot',
        created_at: Number.isFinite(created) ? created : null,
        last_activity_at: Number.isFinite(updated) ? updated : mtimeOf(yaml),
        size_bytes: sizeOf(dir),
        archived: false,
      })
    }
    return out
  },
  read(path) {
    // The checkpoint index is the only human-readable record the CLI keeps. Better than an empty
    // panel, and clearly not a transcript.
    const index = join(path, '..', 'checkpoints', 'index.md')
    let text = ''
    try {
      text = readFileSync(index, 'utf8')
    } catch {
      return []
    }
    const t = compact(text)
    if (!t) return []
    return [
      {
        role: 'assistant',
        kind: 'text',
        text: truncate(t),
        tool_name: null,
        timestamp: iso(mtimeOf(index)),
      },
    ]
  },
}

// --- Zed ------------------------------------------------------------------------------------------
// `<root>/threads/threads.db`, one row per thread: id, summary (the title), timestamps, and a `data`
// blob holding the messages. The blob's shape varies by `data_type`, so only the parts that are
// unambiguously messages are read and anything else yields an empty conversation rather than a
// guess.

interface ZedRow {
  id: string
  summary: string | null
  updated_at: string | null
  created_at: string | null
  data: string | null
}

function zedDb(path: string): Database | null {
  if (!existsSync(path)) return null
  try {
    return new Database(path, { readonly: true })
  } catch {
    return null
  }
}

const zed: Adapter = {
  list(root) {
    const path = join(root, 'threads', 'threads.db')
    const db = zedDb(path)
    if (!db) return []
    try {
      const rows = db
        .query('select id, summary, updated_at, created_at, data from threads')
        .all() as ZedRow[]
      return rows.map((r) => {
        const updated = r.updated_at ? Date.parse(r.updated_at) : Number.NaN
        const created = r.created_at ? Date.parse(r.created_at) : Number.NaN
        return {
          session_id: r.id,
          // Virtual path: the DB holds every thread, so a row needs its id to be reachable again.
          path: `${path}#${r.id}`,
          title: r.summary?.trim() || 'Zed thread',
          cwd: '',
          project: 'zed',
          created_at: Number.isFinite(created) ? created : null,
          last_activity_at: Number.isFinite(updated) ? updated : mtimeOf(path),
          size_bytes: r.data?.length ?? 0,
          archived: false,
        }
      })
    } catch {
      // A schema that is not the one above: report no threads rather than a wrong reading of them.
      return []
    } finally {
      db.close()
    }
  },
  read: zedRead,
}

/** One Zed thread message → a TailEvent, or null when it's not a role we display or carries no
 *  text after compacting. Pulled out of the zed adapter's `read` so the per-message shape
 *  wrangling isn't inline inside the row-mapping loop. */
function zedMessageToTailEvent(m: Record<string, unknown>, at: string): TailEvent | null {
  const role = m.role === 'user' || m.role === 'assistant' ? m.role : null
  if (!role) return null
  const segments = m.segments
  const text = Array.isArray(segments)
    ? segments
        .map((s) =>
          s && typeof s === 'object' ? ((s as { text?: string }).text ?? '') : String(s ?? ''),
        )
        .join('\n')
    : typeof m.text === 'string'
      ? m.text
      : ''
  const t = compact(text)
  return t ? { role, kind: 'text', text: truncate(t), tool_name: null, timestamp: at } : null
}

function zedRead(virtualPath: string): TailEvent[] {
  const hash = virtualPath.lastIndexOf('#')
  if (hash < 0) return []
  const path = virtualPath.slice(0, hash)
  const id = virtualPath.slice(hash + 1)
  const db = zedDb(path)
  if (!db) return []
  try {
    const row = db.query('select data, updated_at from threads where id = ?').get(id) as
      | { data: string | null; updated_at: string | null }
      | undefined
    if (!row?.data) return []
    const at = row.updated_at ? iso(Date.parse(row.updated_at)) : iso(mtimeOf(path))
    const parsed = JSON.parse(row.data) as { messages?: Array<Record<string, unknown>> }
    const out: TailEvent[] = []
    for (const m of parsed.messages ?? []) {
      const ev = zedMessageToTailEvent(m, at)
      if (ev) out.push(ev)
    }
    return out
  } catch {
    return []
  } finally {
    db.close()
  }
}

// --- Pi -------------------------------------------------------------------------------------------
// `<root>/--<encoded cwd>--/<timestamp>_<uuid>.jsonl`, or the same files flat in the root when
// PI_CODING_AGENT_SESSION_DIR points at one directory. Written from the format documented in
// earendil-works/pi packages/coding-agent/docs/session-format.md (MIT); no code taken from it.
//
// A Pi file is a TREE, not a transcript. After a `session` header line (id, cwd, timestamp) every
// entry links to its parent by `id`/`parentId`, and branching (/tree) appends a new child to an
// earlier entry in the SAME file. Reading the lines in file order would therefore splice every
// abandoned branch into the conversation. Pi resumes a file at its LAST entry, so that entry's
// parent chain back to a root is the session; every other childless entry is the tip of a branch
// the user left, listed as a fork of it through a `<file>#<tipId>` virtual path, as Zed's are.

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  /** `session` header only. */
  cwd?: string
  /** `session_info`: the name set with /name. */
  name?: string
  /** `compaction` and `branch_summary`. */
  summary?: string
  /** `custom_message`. */
  content?: unknown
  display?: boolean
  message?: {
    role?: string
    content?: unknown
    toolName?: string
    command?: string
    output?: string
    summary?: string
    display?: boolean
  }
}

interface PiTree {
  header: PiEntry | null
  /** Insertion order is file order, which is what "last entry is the leaf" is measured against. */
  entries: Map<string, PiEntry>
  leaf: string | null
}

function parsePiTree(path: string): PiTree | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const tree: PiTree = { header: null, entries: new Map(), leaf: null }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: PiEntry
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'session') {
      tree.header ??= rec
      continue
    }
    if (typeof rec.id !== 'string') continue
    tree.entries.set(rec.id, rec)
    tree.leaf = rec.id
  }
  return tree.header ? tree : null
}

/** Root-first chain of entries ending at `tip`. The seen-set bounds a parentId cycle in a bad
 *  file. */
function piBranch(tree: PiTree, tip: string): PiEntry[] {
  const out: PiEntry[] = []
  const seen = new Set<string>()
  let at: string | null | undefined = tip
  while (at && !seen.has(at)) {
    seen.add(at)
    const entry = tree.entries.get(at)
    if (!entry) break
    out.push(entry)
    at = entry.parentId
  }
  return out.reverse()
}

/** The readable text of a Pi content field: a plain string, or blocks whose `text` ones count. */
function piText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: string }).type === 'text'
        ? ((c as { text?: string }).text ?? '')
        : '',
    )
    .join('\n')
}

function piFirstUserText(entries: PiEntry[]): string {
  for (const e of entries)
    if (e.type === 'message' && e.message?.role === 'user') {
      const t = compact(piText(e.message.content))
      if (t) return t
    }
  return ''
}

const piTime = (entry: PiEntry | undefined, fallback: number): number => {
  const t = entry?.timestamp ? Date.parse(entry.timestamp) : Number.NaN
  return Number.isFinite(t) ? t : fallback
}

/** One file's sessions: the active branch first, then one row per abandoned branch that holds
 *  conversation of its own. */
function piSessionsOf(path: string, dirName: string, size: number): ForeignSession[] {
  const tree = parsePiTree(path)
  if (!tree?.leaf) return []
  const header = tree.header as PiEntry
  const mtime = mtimeOf(path)
  const fileName = (path.split(/[\\/]/).pop() ?? '').replace(/\.jsonl$/, '')
  const id = header.id || fileName.replace(/^.*?_/, '')
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  const project = cwd || (dirName ? dirName.replace(/^--|--$/g, '') : 'pi')
  const created = piTime(header, Number.NaN)
  const active = piBranch(tree, tree.leaf)
  // /name writes a session_info entry; the latest one anywhere in the file is the current name.
  let named = ''
  for (const e of tree.entries.values())
    if (e.type === 'session_info' && typeof e.name === 'string') named = e.name.trim()
  const title = named || titleFromText(piFirstUserText(active), 'Pi session')
  const base = {
    cwd,
    project,
    created_at: Number.isFinite(created) ? created : null,
    size_bytes: size,
    archived: false,
  }
  const out: ForeignSession[] = [
    {
      ...base,
      session_id: id,
      path,
      title,
      last_activity_at: piTime(tree.entries.get(tree.leaf), mtime),
    },
  ]
  const parents = new Set<string>()
  for (const e of tree.entries.values()) if (e.parentId) parents.add(e.parentId)
  const onActive = new Set(active.map((e) => e.id))
  for (const [tip, entry] of tree.entries) {
    if (tip === tree.leaf || parents.has(tip)) continue
    // Only the part past the fork point is the branch's own; a tip that is just a label or a
    // model switch hanging off the main line is not a conversation anyone could want to open.
    const own = piBranch(tree, tip).filter((e) => !onActive.has(e.id))
    const said = own.some(
      (e) =>
        e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant'),
    )
    if (!said) continue
    const asked = piFirstUserText(own)
    out.push({
      ...base,
      session_id: `${id}-fork-${tip}`,
      path: `${path}#${tip}`,
      title: `${title} (fork${asked ? `: ${truncate(asked, 60)}` : ''})`,
      last_activity_at: piTime(entry, mtime),
    })
  }
  return out
}

/** Every `.jsonl` a Pi root can hold: one level of per-cwd directories, or flat in the root. */
function piFiles(root: string): Array<{ path: string; dirName: string }> {
  const out: Array<{ path: string; dirName: string }> = []
  const collect = (dir: string, dirName: string) => {
    try {
      for (const n of readdirSync(dir))
        if (n.endsWith('.jsonl')) out.push({ path: join(dir, n), dirName })
    } catch {
      // An unreadable directory holds no sessions we can show.
    }
  }
  collect(root, '')
  for (const d of dirs(root)) collect(join(root, d), d)
  return out
}

/**
 * Listed files, keyed by path, valid only while the file is byte-for-byte the one that was parsed.
 * Listing a Pi store means parsing every whole file (the title and the forks live in the tree, not
 * in an index), so the same mtime+size stamp the VS Code cache uses keeps an idle sweep to a stat.
 */
const piCache = new Map<string, { stamp: string; sessions: ForeignSession[] }>()

function* piSessions(root: string): Generator<ForeignSession[]> {
  const seen = new Set<string>()
  try {
    for (const { path, dirName } of piFiles(root)) {
      seen.add(path)
      let stamp: string
      let size: number
      try {
        const st = statSync(path)
        size = st.size
        stamp = `${st.mtimeMs}:${st.size}`
      } catch {
        yield []
        continue
      }
      const hit = piCache.get(path)
      if (hit?.stamp === stamp) {
        yield hit.sessions
        continue
      }
      const sessions = piSessionsOf(path, dirName, size)
      // Pi appends while a session runs, so an empty parse may be a file caught mid-write: only a
      // parse that found something is remembered.
      if (sessions.length) piCache.set(path, { stamp, sessions })
      yield sessions
    }
  } finally {
    for (const path of piCache.keys())
      if (path.startsWith(root) && !seen.has(path)) piCache.delete(path)
  }
}

/** One Pi entry as the events a reader shows. System prompts, usage, labels and extension state are
 *  machinery, not conversation, and are left out. */
function piEvents(e: PiEntry, at: string): TailEvent[] {
  const ev = (
    role: TailEvent['role'],
    kind: TailEvent['kind'],
    text: string,
    tool: string | null,
  ): TailEvent => ({ role, kind, text: truncate(text), tool_name: tool, timestamp: at })
  if (e.type === 'compaction' || e.type === 'branch_summary') {
    const t = compact(e.summary ?? '')
    const label = e.type === 'compaction' ? 'Compacted' : 'Branch summary'
    return t ? [ev('assistant', 'text', `${label}: ${t}`, null)] : []
  }
  if (e.type === 'custom_message') {
    const t = compact(piText(e.content))
    return e.display !== false && t ? [ev('user', 'text', t, null)] : []
  }
  if (e.type !== 'message' || !e.message) return []
  const m = e.message
  const out: TailEvent[] = []
  switch (m.role) {
    case 'user': {
      const t = compact(piText(m.content))
      if (t) out.push(ev('user', 'text', t, null))
      break
    }
    case 'assistant':
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== 'object') continue
        const block = c as {
          type?: string
          text?: string
          thinking?: string
          name?: string
          arguments?: unknown
        }
        if (block.type === 'text') {
          const t = compact(block.text ?? '')
          if (t) out.push(ev('assistant', 'text', t, null))
        } else if (block.type === 'thinking') {
          const t = compact(block.thinking ?? '')
          if (t) out.push(ev('assistant', 'thinking', t, null))
        } else if (block.type === 'toolCall') {
          const args = block.arguments ? compact(JSON.stringify(block.arguments)) : ''
          out.push(ev('assistant', 'tool_use', truncate(args, 500), block.name ?? 'tool'))
        }
      }
      break
    case 'toolResult': {
      const t = compact(piText(m.content))
      if (t) out.push(ev('user', 'tool_result', t, m.toolName ?? 'tool'))
      break
    }
    case 'bashExecution':
      // A command the user ran with `!`, not one the model asked for; shown as the tool it is.
      if (m.command) out.push(ev('user', 'tool_use', m.command, 'bash'))
      if (m.output?.trim()) out.push(ev('user', 'tool_result', m.output.trim(), 'bash'))
      break
    case 'custom': {
      const t = compact(piText(m.content))
      if (m.display !== false && t) out.push(ev('user', 'text', t, null))
      break
    }
    case 'branchSummary':
    case 'compactionSummary': {
      const t = compact(m.summary ?? '')
      if (t) out.push(ev('assistant', 'text', t, null))
      break
    }
  }
  return out
}

const pi: Adapter = {
  list: (root) => [...piSessions(root)].flat(),
  async listAsync(root) {
    const out: ForeignSession[] = []
    let examined = 0
    for (const sessions of piSessions(root)) {
      out.push(...sessions)
      if (++examined % 16 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return out
  },
  read(virtualPath) {
    // `#<tipId>` opens a fork; a bare path opens the active branch. Only a suffix after `.jsonl`
    // counts, so a `#` that is part of a real directory name is left alone.
    const hash = virtualPath.lastIndexOf('#')
    const forked = hash > 0 && virtualPath.slice(0, hash).endsWith('.jsonl')
    const path = forked ? virtualPath.slice(0, hash) : virtualPath
    const tree = parsePiTree(path)
    const tip = forked ? virtualPath.slice(hash + 1) : tree?.leaf
    if (!tree || !tip || !tree.entries.has(tip)) return []
    const fallback = mtimeOf(path)
    return piBranch(tree, tip).flatMap((e) => piEvents(e, iso(piTime(e, fallback))))
  },
}

/** Adapter per catalog tool id. A tool with `format: 'foreign'` and no entry here reads as empty,
 *  which is the same bounded failure as a path that does not exist. */
const ADAPTERS: Record<string, Adapter> = {
  grok,
  kimi,
  'vscode-copilot': vscodeCopilot,
  copilot: copilotCli,
  zed,
  pi,
}

export function foreignAdapter(toolId: string): Adapter | undefined {
  return ADAPTERS[toolId]
}

export function listForeignSessions(toolId: string, root: string): ForeignSession[] {
  try {
    return foreignAdapter(toolId)?.list(root) ?? []
  } catch {
    // A store whose layout has moved on contributes nothing. It must never take the index with it.
    return []
  }
}

/**
 * listForeignSessions for the async index sweep, which must not hold the event loop.
 *
 * Falls back to the sync listing for every adapter that has not needed an async one — that is the
 * correct answer for a store small enough that reading it never blocks anything.
 */
export async function listForeignSessionsAsync(
  toolId: string,
  root: string,
): Promise<ForeignSession[]> {
  try {
    const adapter = foreignAdapter(toolId)
    if (!adapter) return []
    return adapter.listAsync ? await adapter.listAsync(root) : adapter.list(root)
  } catch {
    // Same bargain as the sync listing: a store whose layout has moved on contributes nothing.
    return []
  }
}

export function readForeignSession(toolId: string, path: string): TailEvent[] {
  try {
    return foreignAdapter(toolId)?.read(path) ?? []
  } catch {
    return []
  }
}
