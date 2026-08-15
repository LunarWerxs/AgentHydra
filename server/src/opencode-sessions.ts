import { Database } from 'bun:sqlite'
import { existsSync, statSync } from 'node:fs'
import { OPENCODE_DB_PATH } from './config'
import type { TailEvent } from './types'
import type { OpenCodeUsageRow } from './usage-foreign'

export interface OpenCodeSessionRecord {
  session_id: string
  project: string
  cwd: string
  title: string
  created_at: number | null
  last_activity_at: number
  archived: boolean
  size_bytes: number
  /**
   * The session that spawned this one, or null when it is a top-level conversation.
   *
   * OpenCode gives a subagent its own session row — `agent` reads `general`/`investigator`/`explore`
   * rather than `build` — so a machine that fans out has as many child rows as real conversations
   * (47 top-level against 41 children when this was written). They are a real session with their own
   * messages, models and tokens, so they stay in the index; what they are not is a row in a list of
   * conversations the user held. See listSessions in server/src/sessions.ts.
   */
  parent_id: string | null
}

interface SessionRow {
  id: string
  project_id: string | null
  directory: string | null
  title: string | null
  time_created: number | null
  time_updated: number | null
  time_archived: number | null
  parent_id: string | null
  size_bytes: number
}

interface MessageRow {
  id: string
  data: string
  time_created: number
}

interface PartRow {
  message_id: string
  data: string
  time_created: number
}

function openDb(path = OPENCODE_DB_PATH): Database | null {
  if (!existsSync(path)) return null
  try {
    return new Database(path, { readonly: true })
  } catch {
    return null
  }
}

/**
 * Whether a column exists, asked rather than assumed.
 *
 * `session.parent_id` arrived partway through OpenCode's life, and the stores that share this format
 * (Kilo writes the same SQLite under another filename) lag it by their own release cadence. Naming
 * the column unconditionally would throw inside the one try/catch that guards the whole listing, and
 * that catch returns an empty array — so a store one version behind would report that the user has
 * no sessions at all rather than no subagents. Cheap enough to ask on every call: sqlite answers
 * `pragma table_info` from the schema it already has parsed.
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    return db
      .query<{ name: string }, []>(`pragma table_info(${table})`)
      .all()
      .some((c) => c.name === column)
  } catch {
    return false
  }
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function epoch(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function iso(value: unknown, fallback: number): string {
  return new Date(epoch(value, fallback)).toISOString()
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
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

/**
 * Convert one OpenCode message and its parts to the same display DTO as the JSONL providers.
 * Reasoning/step bookkeeping stays hidden; text and tool activity remain available.
 */
export function openCodePartsToTailEvents(
  role: unknown,
  messageCreatedAt: number,
  parts: Array<{ data: unknown; timeCreatedAt?: number }>,
): TailEvent[] {
  if (role !== 'user' && role !== 'assistant') return []
  const messageRole = role
  const out: TailEvent[] = []

  for (const row of parts) {
    const part = row.data
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, any>
    const timestamp = iso(p.time?.start, row.timeCreatedAt ?? messageCreatedAt)
    if (p.type === 'text' && typeof p.text === 'string') {
      const text = compact(p.text)
      if (text) {
        out.push({
          role: messageRole,
          kind: 'text',
          text: truncate(text, 6000),
          tool_name: null,
          timestamp,
        })
      }
      continue
    }
    if (p.type !== 'tool' || messageRole !== 'assistant') continue

    const state = p.state && typeof p.state === 'object' ? p.state : {}
    const input = compact(printable(state.input))
    out.push({
      role: 'assistant',
      kind: 'tool_use',
      text: truncate(input || String(state.title ?? ''), 1200),
      tool_name: typeof p.tool === 'string' ? p.tool : 'tool',
      timestamp,
    })
    const output = compact(printable(state.output))
    if (output) {
      out.push({
        role: 'user',
        kind: 'tool_result',
        text: truncate(output, 2000),
        tool_name: typeof p.tool === 'string' ? p.tool : null,
        timestamp: iso(state.time?.completed, row.timeCreatedAt ?? messageCreatedAt),
      })
    }
  }
  return out
}

/**
 * The last listing per database, valid only while the store's bytes are unchanged.
 *
 * The query below sizes each session with two correlated subqueries, so it walks the whole `message`
 * and `part` tables once PER SESSION — it is the store, not the session count, that sets the cost.
 * Measured at 939 ms for 110 sessions, paid on every whole-store sweep even though a database nobody
 * has written to cannot have a different answer. Callers must treat the result as read-only.
 */
const openCodeListCache = new Map<string, { stamp: string; rows: OpenCodeSessionRecord[] }>()

/**
 * Identity of a SQLite store as bytes on disk.
 *
 * The `-wal` file counts as much as the database itself: with write-ahead logging on — which is how
 * OpenCode ships — a new session lands in the log first and the main file's mtime can sit perfectly
 * still while the store has moved on. Stamping only the `.db` would serve a stale list until
 * something happened to checkpoint it.
 */
function openCodeDbStamp(path: string): string {
  let out = ''
  for (const p of [path, `${path}-wal`]) {
    try {
      const st = statSync(p)
      out += `${st.mtimeMs}:${st.size};`
    } catch {
      out += 'x;'
    }
  }
  return out
}

export function listOpenCodeSessions(path = OPENCODE_DB_PATH): OpenCodeSessionRecord[] {
  const stamp = openCodeDbStamp(path)
  const hit = openCodeListCache.get(path)
  if (hit?.stamp === stamp) return hit.rows
  const db = openDb(path)
  if (!db) return []
  try {
    const parentId = hasColumn(db, 'session', 'parent_id') ? 's.parent_id' : 'null as parent_id'
    const rows = db
      .query<SessionRow, []>(
        `select
           s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
           s.time_archived, ${parentId},
           coalesce((select sum(length(m.data)) from message m where m.session_id = s.id), 0) +
           coalesce((select sum(length(p.data)) from part p where p.session_id = s.id), 0)
             as size_bytes
         from session s`,
      )
      .all()
    const records = rows.map((row) => ({
      session_id: row.id,
      project: row.project_id || 'opencode',
      cwd: row.directory || '',
      title: row.title || row.id,
      created_at: row.time_created,
      last_activity_at: row.time_updated ?? row.time_created ?? 0,
      archived: row.time_archived !== null,
      size_bytes: Number(row.size_bytes) || 0,
      // Empty string is not a parent: an older store that writes '' rather than NULL would otherwise
      // make every session the child of a session that does not exist.
      parent_id: row.parent_id || null,
    }))
    openCodeListCache.set(path, { stamp, rows: records })
    return records
  } catch {
    return []
  } finally {
    db.close()
  }
}

export interface OpenCodeSessionContent {
  events: TailEvent[]
  messageCount: number
}

export function readOpenCodeSession(
  sessionId: string,
  path = OPENCODE_DB_PATH,
): OpenCodeSessionContent | null {
  const db = openDb(path)
  if (!db) return null
  try {
    const messages = db
      .query<MessageRow, [string]>(
        'select id, data, time_created from message where session_id = ? order by time_created, id',
      )
      .all(sessionId)
    if (messages.length === 0) return { events: [], messageCount: 0 }
    const partRows = db
      .query<PartRow, [string]>(
        'select message_id, data, time_created from part where session_id = ? order by time_created, id',
      )
      .all(sessionId)
    const byMessage = new Map<string, Array<{ data: unknown; timeCreatedAt: number }>>()
    for (const row of partRows) {
      const list = byMessage.get(row.message_id) ?? []
      list.push({ data: parseJson(row.data), timeCreatedAt: row.time_created })
      byMessage.set(row.message_id, list)
    }

    const events: TailEvent[] = []
    let messageCount = 0
    for (const row of messages) {
      const message = parseJson(row.data)
      const converted = openCodePartsToTailEvents(
        message?.role,
        row.time_created,
        byMessage.get(row.id) ?? [],
      )
      if (converted.some((event) => event.kind === 'text')) messageCount++
      events.push(...converted)
    }
    return { events, messageCount }
  } catch {
    return null
  } finally {
    db.close()
  }
}

export interface OpenCodeSearchEvent {
  session_id: string
  cwd: string
  project: string
  text: string
}

interface OpenCodeSearchRow {
  session_id: string
  cwd: string | null
  project: string | null
  text: string | null
}

/**
 * Search input for OpenCode. Only text parts are returned: the UI hides reasoning, and raw tool
 * payloads contain far more noise than useful conversation text. Filter/extract in SQLite so a
 * search does not first materialize every tool payload in the (potentially hundreds-of-MiB) DB.
 */
export function listOpenCodeSearchEvents(path = OPENCODE_DB_PATH): OpenCodeSearchEvent[] {
  const db = openDb(path)
  if (!db) return []
  try {
    const rows = db
      .query<OpenCodeSearchRow, []>(
        `select p.session_id, s.directory as cwd, s.project_id as project,
                case when json_valid(p.data) then json_extract(p.data, '$.text') end as text
         from part p join session s on s.id = p.session_id
         where case when json_valid(p.data) then json_extract(p.data, '$.type') end = 'text'
         order by s.time_updated desc, p.time_created`,
      )
      .all()
    const out: OpenCodeSearchEvent[] = []
    for (const row of rows) {
      if (typeof row.text !== 'string' || !row.text.trim()) continue
      out.push({
        session_id: row.session_id,
        cwd: row.cwd || '',
        project: row.project || 'opencode',
        text: row.text,
      })
    }
    return out
  } catch {
    return []
  } finally {
    db.close()
  }
}

/**
 * One session's stored token totals.
 *
 * OpenCode keeps these as columns on the session row, already summed, so this is a read rather than
 * a parse — which is why the analytics tier reporting zero for OpenCode was the least excusable of
 * the three providers. Returns null when the row or the database is missing; a session that simply
 * has no usage yet comes back with zeros, which is a different and true answer.
 */
export function readOpenCodeUsage(
  sessionId: string,
  path = OPENCODE_DB_PATH,
): OpenCodeUsageRow | null {
  const db = openDb(path)
  if (!db) return null
  try {
    const row = db
      .query<OpenCodeUsageRow, [string]>(
        'select model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, ' +
          'tokens_cache_write, cost, time_updated from session where id = ?',
      )
      .get(sessionId)
    if (!row) return null
    // Assistant replies, so the model breakdown can say "N replies" for OpenCode as it does for the
    // others. OpenCode keeps the role inside each message's JSON blob rather than in a column, so
    // this matches on the blob: one indexed scan of this session's rows, not a parse of every body.
    let turns = 0
    try {
      turns =
        db
          .query<{ n: number }, [string]>(
            'select count(*) as n from message where session_id = ? ' +
              `and data like '%"role":"assistant"%'`,
          )
          .get(sessionId)?.n ?? 0
    } catch {
      // A schema this query does not fit: the totals still stand, the reply count is simply 0.
    }
    return { ...row, turns }
  } catch {
    // An older OpenCode without these columns: no usage rather than a broken list.
    return null
  }
}
