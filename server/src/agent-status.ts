// server/src/agent-status.ts - one live "working / waiting on you / done" row per agent session.
//
// Design idea from stablyai/orca's agent status store (docs/reference/agent-status-store.md, MIT);
// written fresh for AgentHydra.
//
// WHY THIS EXISTS. The session list could say a chat was recently active (a transcript mtime) or cut
// off by a usage wall, but never "Claude is working", "Claude is waiting on you" or "Claude's turn is
// done". Claude Code says exactly that through its own hooks (status-hooks.ts installs them), and the
// rate-limit scan knows when a session is sitting at a usage wall. This store is where both land.
//
// THREE RULES, each from a stale-status bug the design exists to avoid:
//   1. Precedence is settled ONCE, here, at write time, and the row carries its provenance (source,
//      event, at). Readers show `state` as written; none of them re-adjudicates it.
//   2. A row read back after a daemon restart is stamped restoredUnconfirmed and never reads as live:
//      hooks kept firing while the daemon was down and nobody heard them. The next event for that
//      session replaces it, and a restored sub-agent count is not carried into the live row.
//   3. The lead agent's own state is kept beside the folded one, so a lead that finished while a
//      sub-agent it started is still running reads working, not done.

import { db } from './db'
import type { AgentStatus, AgentStatusSource, AgentStatusState } from './types'

export type { AgentStatus, AgentStatusSource, AgentStatusState }

/** One fact from one producer. `at` is when it happened; for a hook, when the daemon heard it. */
export interface AgentStatusEvent {
  sessionId: string
  source: AgentStatusSource
  /** A Claude Code hook event name (UserPromptSubmit, PreToolUse, ...) or 'rate-limit'. */
  event: string
  at: string
  cwd?: string | null
  toolName?: string | null
  notificationType?: string | null
  /** The event came from inside a sub-agent (Claude Code puts an agent_id on those). */
  fromSubagent?: boolean
}

interface Row {
  session_id: string
  state: AgentStatusState
  main_state: 'working' | 'done'
  subagents: number
  waiting: string | null
  source: AgentStatusSource
  event: string
  cwd: string | null
  at: string
  restored_unconfirmed: number
}

/** The tools whose call starts a sub-agent. `Agent` is the current name, `Task` the older one. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
/** Events that prove the session did work after whatever preceded them. */
const ACTIVITY_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse'])

function fold(
  main: Row['main_state'],
  subagents: number,
  waiting: string | null,
): AgentStatusState {
  if (waiting) return 'blocked'
  return main === 'done' && subagents > 0 ? 'working' : main
}

/**
 * Does `e` get to change `prev`? The single place precedence is decided.
 *
 * A newer fact wins. An older one loses, with one exception: the rate-limit scan reports a stop at
 * the moment the transcript stopped, which is usually a hair BEFORE the hook Stop of that same
 * turn. A Stop or a notification is not evidence the session got past the wall, so the wall wins
 * over them; only real work after it (a prompt, a tool call) supersedes it.
 */
function supersedes(prev: Row | null, e: AgentStatusEvent): boolean {
  if (!prev || e.at >= prev.at) return true
  return (
    e.source === 'rate-limit' && prev.source === 'claude-hook' && !ACTIVITY_EVENTS.has(prev.event)
  )
}

/**
 * The next row for `prev` given `e`, or null when the event changes nothing. Pure, so the whole
 * transition table is testable without a daemon.
 */
export function nextAgentStatus(prev: Row | null, e: AgentStatusEvent): Row | null {
  if (!supersedes(prev, e)) return null
  // A restored row's counts are not evidence: stops sent while the daemon was down were never heard.
  const base = prev && !prev.restored_unconfirmed ? prev : null
  let main: Row['main_state'] = base?.main_state ?? 'done'
  let subagents = base?.subagents ?? 0
  let waiting = base?.waiting ?? null
  switch (e.event) {
    case 'UserPromptSubmit':
      main = 'working'
      waiting = null
      break
    case 'PreToolUse':
    case 'PostToolUse':
      // Work resumed, so whatever was asked has been answered. A sub-agent's own tool call says
      // nothing about the lead, whose state stays as it was.
      if (!e.fromSubagent) main = 'working'
      waiting = null
      if (e.event === 'PreToolUse' && SUBAGENT_TOOLS.has(e.toolName ?? '')) subagents += 1
      break
    case 'Notification':
      // A finished turn already waits on you ('done' says so), and the idle reminder repeats that.
      if (e.notificationType === 'idle_prompt') return null
      if (main === 'done' && subagents === 0) return null
      waiting = e.notificationType || 'notification'
      break
    case 'Stop':
      main = 'done'
      waiting = null
      break
    case 'SubagentStop':
      subagents = Math.max(0, subagents - 1)
      break
    case 'SessionEnd':
      main = 'done'
      subagents = 0
      waiting = null
      break
    case 'rate-limit':
      main = 'done'
      waiting = 'rate-limit'
      break
    default:
      return null
  }
  return {
    session_id: e.sessionId,
    state: fold(main, subagents, waiting),
    main_state: main,
    subagents,
    waiting,
    source: e.source,
    event: e.event,
    cwd: e.cwd ?? prev?.cwd ?? null,
    // Never moves backwards, so "a newer fact wins" keeps meaning the same thing.
    at: prev && prev.at > e.at ? prev.at : e.at,
    restored_unconfirmed: 0,
  }
}

function toStatus(r: Row): AgentStatus {
  return {
    sessionId: r.session_id,
    state: r.state,
    mainState: r.main_state,
    subagents: r.subagents,
    waiting: r.waiting,
    source: r.source,
    event: r.event,
    cwd: r.cwd,
    at: r.at,
    restoredUnconfirmed: r.restored_unconfirmed === 1,
  }
}

function getRow(sessionId: string): Row | null {
  return db.query<Row, [string]>('select * from agent_status where session_id = ?').get(sessionId)
}

/** Every producer writes through here. Answers what happened to the event and the row after it. */
export function recordAgentStatus(e: AgentStatusEvent): {
  outcome: 'applied' | 'ignored'
  status: AgentStatus | null
} {
  const prev = getRow(e.sessionId)
  const next = nextAgentStatus(prev, e)
  if (!next) return { outcome: 'ignored', status: prev ? toStatus(prev) : null }
  db.query(
    `insert into agent_status (session_id, state, main_state, subagents, waiting, source, event, cwd, at, restored_unconfirmed)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     on conflict(session_id) do update set state = excluded.state, main_state = excluded.main_state,
       subagents = excluded.subagents, waiting = excluded.waiting, source = excluded.source,
       event = excluded.event, cwd = excluded.cwd, at = excluded.at, restored_unconfirmed = 0`,
  ).run(
    next.session_id,
    next.state,
    next.main_state,
    next.subagents,
    next.waiting,
    next.source,
    next.event,
    next.cwd,
    next.at,
  )
  return { outcome: 'applied', status: toStatus(next) }
}

/**
 * The rate-limit scan's clearing half. A rate-limit row is the scan's claim that a session sits at a
 * usage wall, and without the (opt-in) hooks nothing else ever writes a newer fact for it: once the
 * scan stops finding that stop (the session was resumed or moved on), the claim is withdrawn, or the
 * row would read "waiting on you" until the next restart. Rows another producer has written since
 * are not the scan's to drop. Answers how many rows went.
 */
export function releaseRateLimitStatus(stillAtWall: Iterable<string>): number {
  const keep = new Set(stillAtWall)
  const stale = db
    .query<{ session_id: string }, []>(
      "select session_id from agent_status where source = 'rate-limit'",
    )
    .all()
    .filter((r) => !keep.has(r.session_id))
  const drop = db.query("delete from agent_status where session_id = ? and source = 'rate-limit'")
  for (const r of stale) drop.run(r.session_id)
  return stale.length
}

export function getAgentStatus(sessionId: string): AgentStatus | null {
  const r = getRow(sessionId)
  return r ? toStatus(r) : null
}

/** Newest first, bounded: the list answers "what is going on now", not the store's whole past. */
export function listAgentStatus(limit = 500): AgentStatus[] {
  return db
    .query<Row, [number]>('select * from agent_status order by at desc limit ?')
    .all(limit)
    .map(toStatus)
}

/**
 * Claude Code's hook payload (JSON on the hook command's stdin, forwarded as the POST body) to an
 * event, or null when it names no session. Only the routing fields are read: tool inputs, prompts
 * and notification text never reach the store.
 */
export function hookEventFromPayload(body: unknown, at: string): AgentStatusEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const sessionId = text(b.session_id)
  const event = text(b.hook_event_name)
  if (!sessionId || !event) return null
  return {
    sessionId,
    source: 'claude-hook',
    event,
    at,
    cwd: text(b.cwd),
    toolName: text(b.tool_name),
    notificationType: text(b.notification_type),
    fromSubagent: text(b.agent_id) !== null,
  }
}

/** Stamp every row on disk as restored. Runs once, when this process first loads the store, which is
 *  before any producer can write through it. Exported for tests, which simulate a restart with it. */
export function hydrateAgentStatus(): void {
  db.exec('update agent_status set restored_unconfirmed = 1 where restored_unconfirmed = 0')
}
hydrateAgentStatus()
