import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
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
}

interface SessionRow {
  id: string
  project_id: string | null
  directory: string | null
  title: string | null
  time_created: number | null
  time_updated: number | null
  time_archived: number | null
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

export function listOpenCodeSessions(path = OPENCODE_DB_PATH): OpenCodeSessionRecord[] {
  const db = openDb(path)
  if (!db) return []
  try {
    const rows = db
      .query<SessionRow, []>(
        `select
           s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
           s.time_archived,
           coalesce((select sum(length(m.data)) from message m where m.session_id = s.id), 0) +
           coalesce((select sum(length(p.data)) from part p where p.session_id = s.id), 0)
             as size_bytes
         from session s`,
      )
      .all()
    return rows.map((row) => ({
      session_id: row.id,
      project: row.project_id || 'opencode',
      cwd: row.directory || '',
      title: row.title || row.id,
      created_at: row.time_created,
      last_activity_at: row.time_updated ?? row.time_created ?? 0,
      archived: row.time_archived !== null,
      size_bytes: Number(row.size_bytes) || 0,
    }))
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
