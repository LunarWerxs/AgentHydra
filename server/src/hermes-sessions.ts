// server/src/hermes-sessions.ts — reader for Hermes Agent's SQLite state store.
//
// Schema verified against NousResearch/hermes-agent's hermes_state_common.py SCHEMA_SQL (MIT,
// Copyright (c) Nous Research), read remotely rather than cloned (870 MB repo). Nothing here ports
// Hermes's own code — this is a from-scratch reader written against its published table shapes,
// the same relationship server/src/opencode-sessions.ts has to OpenCode's schema.
//
// ONE FILE, BUT NOT ONE STORE. Hermes keeps everything in a single SQLite database, `state.db`, at
// the root of HERMES_HOME — but a named profile (`hermes --profile work`) gets its own database at
// `<HERMES_HOME>/profiles/<name>/state.db`, entirely separate sessions, messages and usage. So
// "read Hermes" means finding every one of these files, not just the root one. See listHermesStores.
//
// NO PRICE INVENTED HERE. `session_model_usage` carries Hermes's own estimated/actual cost columns
// (it proxies to whichever provider the user configured, so it prices what it can), but this reader
// deliberately does not read them: server/src/analytics.ts prices every model through THIS repo's
// own catalog instead, so a Hermes session and a Claude session answer "what did this cost" from the
// same table. A model the catalog has no price for costs 0 and is flagged unpriced — never guessed,
// and never quietly taken on Hermes's word for a provider we cannot ourselves verify.
//
// READONLY, ALWAYS. Hermes owns this file; a daemon that writes to someone else's session store one
// day was never the plan. Opened readonly, which SQLite serves correctly against a store still in
// WAL mode — a reader sees every frame the writer has committed to the log, checkpointed or not.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TailEvent } from './types'

function openDb(path: string): Database | null {
  if (!existsSync(path)) return null
  try {
    return new Database(path, { readonly: true })
  } catch {
    return null
  }
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

/** Hermes stores instants as `REAL` seconds (Python's `time.time()`), everywhere in this schema —
 *  every other reader in this codebase works in epoch milliseconds, so every timestamp column is
 *  converted on the way in rather than leaving two units to get confused downstream. */
function toMs(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

function toIso(seconds: unknown): string | null {
  const ms = toMs(seconds)
  return ms === null ? null : new Date(ms).toISOString()
}

// --- store discovery ---------------------------------------------------------------------------

export interface HermesStore {
  /** Absolute path to this store's `state.db`. */
  dbPath: string
  /** The profile this store belongs to, or null for the default (root) store. */
  profile: string | null
}

/**
 * Every Hermes store under one HERMES_HOME root: the root's own `state.db`, plus one per named
 * profile at `<root>/profiles/<name>/state.db`. Each is a wholly separate database — its own
 * sessions, messages and usage — so "one Hermes install" can be several stores.
 *
 * The root itself is not resolved here. It comes from agent-catalog.ts's `hermes` entry via
 * `rootsFor`/`extraRootsWithFormat('hermes')` in server/src/transcript.ts, the same catalog lookup
 * (honouring the `HERMES_HOME` env override and the platform default dirs) every other tool goes
 * through — this function only enumerates what is UNDER a root once one is known, so it stays a
 * plain filesystem question with nothing to mock to test it.
 *
 * A machine that runs ONLY named profiles and has no root-level `state.db` is not covered: the
 * catalog would not report HERMES_HOME as a root at all in that case (a `dbName` tool's root is
 * gated on that file's presence), so there is nothing to look under for profiles either. Real
 * Hermes installs write the root store on first run regardless of whether a profile is also
 * configured, so this is a narrow gap rather than the common case.
 */
export function listHermesStores(root: string, dbName = 'state.db'): HermesStore[] {
  const out: HermesStore[] = []
  const rootDb = join(root, dbName)
  if (existsSync(rootDb)) out.push({ dbPath: rootDb, profile: null })
  let names: string[]
  try {
    names = readdirSync(join(root, 'profiles'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return out // no profiles directory: whatever the root itself carried is everything there is
  }
  for (const name of names) {
    const dbPath = join(root, 'profiles', name, dbName)
    if (existsSync(dbPath)) out.push({ dbPath, profile: name })
  }
  return out
}

// --- session listing -----------------------------------------------------------------------------

export interface HermesSessionRecord {
  session_id: string
  /** The profile name, or 'hermes' for the default store — there is no per-session project/cwd
   *  grouping finer than that a profile IS its own conversation history. */
  project: string
  cwd: string
  title: string
  created_at: number | null
  last_activity_at: number
  archived: boolean
  size_bytes: number
  /** The session that spawned this one (`parent_session_id`), when Hermes recorded one — its async
   *  delegation makes a subagent a session row of its own, same as OpenCode's `parent_id`. See
   *  collapseSubagents in server/src/sessions.ts, which already folds any source that sets this. */
  parent_id: string | null
}

interface SessionRow {
  id: string
  cwd: string | null
  display_name: string | null
  title: string | null
  started_at: number | null
  ended_at: number | null
  last_activity_at: number | null
  archived: number
  parent_session_id: string | null
  size_bytes: number
}

/** One store's sessions. Uncached, unlike OpenCode's listing: Hermes stores are a fraction of the
 *  size a long-lived OpenCode install reaches, and adding the same (mtime, size) settle-window logic
 *  for a store this small would be complexity spent on a cost that has not been measured here. */
export function listHermesSessions(dbPath: string, profile: string | null): HermesSessionRecord[] {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const rows = db
      .query<SessionRow, []>(
        `select s.id, s.cwd, s.display_name, s.title, s.started_at, s.ended_at,
                s.last_activity_at, s.archived, s.parent_session_id,
                coalesce((select sum(length(coalesce(m.content, '')) +
                                      length(coalesce(m.tool_calls, '')))
                          from messages m where m.session_id = s.id), 0) as size_bytes
         from sessions s`,
      )
      .all()
    return rows.map((row) => {
      const created = toMs(row.started_at)
      const last = toMs(row.last_activity_at) ?? toMs(row.ended_at) ?? created ?? 0
      return {
        session_id: row.id,
        project: profile ?? 'hermes',
        cwd: row.cwd || '',
        // `title` is Hermes's own (set explicitly or generated); `display_name` is the chat
        // platform's label (a Telegram/Discord thread name) when Hermes runs as a bot backend —
        // present even for a session Hermes never titled itself.
        title: row.title || row.display_name || row.id,
        created_at: created,
        last_activity_at: last,
        archived: row.archived !== 0,
        size_bytes: Number(row.size_bytes) || 0,
        parent_id: row.parent_session_id || null,
      }
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

// --- transcript ------------------------------------------------------------------------------

interface MessageRow {
  role: string
  content: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
}

interface ToolCall {
  name: string
  args: unknown
}

/**
 * `tool_calls` is the OpenAI chat-completions shape Hermes's gateway speaks to every provider it
 * proxies: a JSON array of `{ function: { name, arguments } }`, `arguments` itself a JSON-encoded
 * string. Parsed defensively — a row that does not match costs this one message its tool_use
 * events, never the rest of the transcript.
 */
function parseToolCalls(raw: string | null): ToolCall[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ToolCall[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const call = item as Record<string, unknown>
    const fn = (
      call.function && typeof call.function === 'object' ? call.function : call
    ) as Record<string, unknown>
    const name = typeof fn.name === 'string' && fn.name ? fn.name : 'tool'
    let args: unknown = fn.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        // Keep it as the raw string; still printable.
      }
    }
    out.push({ name, args: args ?? null })
  }
  return out
}

/**
 * One `messages` row to the same display DTO the other readers produce.
 *
 * Only 'user'/'assistant'/'tool' carry anything a session view shows: 'system' is the standing
 * instruction, not a turn either side spoke, and is dropped the same way OpenCode drops
 * reasoning/step bookkeeping. A 'tool' row is the RESULT of a call the assistant made, so — matching
 * how every other reader here attributes a tool_result — it is filed under role 'user', the side
 * that receives it, with the calling tool's name carried along for display.
 */
function hermesMessageToTailEvents(row: MessageRow): TailEvent[] {
  const timestamp = toIso(row.timestamp)
  if (row.role === 'user') {
    const text = compact(row.content ?? '')
    return text
      ? [{ role: 'user', kind: 'text', text: truncate(text, 6000), tool_name: null, timestamp }]
      : []
  }
  if (row.role === 'tool') {
    const text = compact(row.content ?? '')
    return text
      ? [
          {
            role: 'user',
            kind: 'tool_result',
            text: truncate(text, 2000),
            tool_name: row.tool_name || null,
            timestamp,
          },
        ]
      : []
  }
  if (row.role !== 'assistant') return []

  const out: TailEvent[] = []
  const text = compact(row.content ?? '')
  if (text)
    out.push({
      role: 'assistant',
      kind: 'text',
      text: truncate(text, 6000),
      tool_name: null,
      timestamp,
    })
  for (const call of parseToolCalls(row.tool_calls)) {
    out.push({
      role: 'assistant',
      kind: 'tool_use',
      text: truncate(compact(printable(call.args)), 1200),
      tool_name: call.name,
      timestamp,
    })
  }
  return out
}

export interface HermesSessionContent {
  events: TailEvent[]
  messageCount: number
}

/**
 * One session's transcript, newest schema column only: `active = 1`. `messages.active` is Hermes's
 * own signal for "still part of the visible history" — a compaction marks the turns it folded into
 * a summary inactive rather than deleting them — so reading only active rows is what makes this
 * transcript match what Hermes itself would show, rather than replaying superseded turns alongside
 * the summary that replaced them.
 */
export function readHermesSession(sessionId: string, dbPath: string): HermesSessionContent | null {
  const db = openDb(dbPath)
  if (!db) return null
  try {
    const rows = db
      .query<MessageRow, [string]>(
        `select role, content, tool_calls, tool_name, timestamp from messages
         where session_id = ? and active = 1 order by timestamp, id`,
      )
      .all(sessionId)
    const events: TailEvent[] = []
    let messageCount = 0
    for (const row of rows) {
      const converted = hermesMessageToTailEvents(row)
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

// --- search ----------------------------------------------------------------------------------

export interface HermesSearchEvent {
  session_id: string
  cwd: string
  project: string
  text: string
}

/** Every active message with text, across one store, for the body-search index. Mirrors
 *  listOpenCodeSearchEvents: filtered to plain text so a search does not first materialize every
 *  tool-call payload in the store. */
export function listHermesSearchEvents(
  dbPath: string,
  profile: string | null,
): HermesSearchEvent[] {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const rows = db
      .query<{ session_id: string; cwd: string | null; content: string | null }, []>(
        `select m.session_id, s.cwd, m.content
         from messages m join sessions s on s.id = m.session_id
         where m.active = 1 and m.role in ('user', 'assistant', 'tool') and m.content is not null
         order by coalesce(s.last_activity_at, s.started_at) desc, m.timestamp`,
      )
      .all()
    const out: HermesSearchEvent[] = []
    for (const row of rows) {
      if (!row.content?.trim()) continue
      out.push({
        session_id: row.session_id,
        cwd: row.cwd || '',
        project: profile ?? 'hermes',
        text: row.content,
      })
    }
    return out
  } catch {
    return []
  } finally {
    db.close()
  }
}

// --- usage / cost ------------------------------------------------------------------------------

export interface HermesUsageRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  api_call_count: number
  /** Epoch ms of this model's earliest/latest recorded use in the session, converted from the raw
   *  `REAL` seconds columns — null only if every contributing row left them unset. */
  first_seen_ms: number | null
  last_seen_ms: number | null
}

/**
 * One session's token totals, by model.
 *
 * `session_model_usage`'s primary key is (session_id, model, billing_provider, billing_base_url,
 * billing_mode, task) — the same model can carry several rows for one session (routed through more
 * than one provider, or used for more than one internal task), so this groups and sums BY MODEL,
 * which is the axis server/src/pricing.ts prices against. Hermes's own estimated/actual cost columns
 * are deliberately not read here; see the file header.
 */
export function readHermesUsage(sessionId: string, dbPath: string): HermesUsageRow[] {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const rows = db
      .query<
        Omit<HermesUsageRow, 'first_seen_ms' | 'last_seen_ms'> & {
          first_seen: number | null
          last_seen: number | null
        },
        [string]
      >(
        `select model,
                sum(input_tokens) as input_tokens,
                sum(output_tokens) as output_tokens,
                sum(cache_read_tokens) as cache_read_tokens,
                sum(cache_write_tokens) as cache_write_tokens,
                sum(reasoning_tokens) as reasoning_tokens,
                sum(api_call_count) as api_call_count,
                min(first_seen) as first_seen,
                max(last_seen) as last_seen
         from session_model_usage
         where session_id = ?
         group by model`,
      )
      .all(sessionId)
    return rows.map(({ first_seen, last_seen, ...rest }) => ({
      ...rest,
      first_seen_ms: toMs(first_seen),
      last_seen_ms: toMs(last_seen),
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}
