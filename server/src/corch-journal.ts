// server/src/corch-journal.ts — Corch's orchestration journal (docs/CORCH.md "Journal"): one short
// JSON line per state change of every worker, in `<CONFIG_DIR>/corch/journal.jsonl`.
//
// WHY (owner, 2026-09-30, the first real corch task): "we probably also need logging in Corch".
// Each worker keeps its own stream-json log and its last 60 events, but nothing told the story of a
// whole orchestration in one place: what was dispatched, which account each attempt got and why,
// the moves, handoffs, retries, finishes and their cost. This file is that record. corch.ts writes
// it; the route, the corch_log MCP tool and the Corch view's Log read it.
//
// Append-only, a few hundred bytes a line, rotated at JOURNAL_MAX_BYTES with one previous file kept
// (`journal.1.jsonl`). A failed write is logged and dropped: the journal must never stop a worker.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type CorchJournalEvent =
  | 'dispatched' // corch_run created it
  | 'launched' // an attempt started on an account (the pick's reasons ride along)
  | 'moved' // the session changed account (before the launch on the new one)
  | 'limit' // the account hit its usage limit (or was stopped short of paid extra usage)
  | 'signed-out' // the account's login failed
  | 'handoff-requested' // asked to wrap up and write a handoff (near its limit, or on request)
  | 'handoff-written' // it wrote the handoff; the task goes on in a fresh session
  | 'handoff-resumed' // the fresh session started from the handoff
  | 'follow-up-queued' // corch_send queued a message
  | 'follow-up-delivered' // an attempt started with that message
  | 'retry' // the API was overloaded, or the next attempt could not start: tried again later
  | 'interrupted' // the CLI was killed from outside (a daemon restart); resumed
  | 'waiting' // no account it may use is free
  | 'turn-done' // a turn finished and a queued follow-up comes next
  | 'turn-end' // a turn ended with this text (a Stop hook can force more turns after the report)
  | 'done'
  | 'failed'
  | 'cancelled'

export interface CorchJournalEntry {
  ts: string // ISO time
  id: string
  group: string
  title: string
  event: CorchJournalEvent
  account?: string // '#84', or the account's name when it has no number
  from?: string // moved: the account it left
  attempt?: number // 1-based
  sessionPct?: number | null // launched: the account's 5-hour window when it was picked
  weekPct?: number | null // launched: its week
  active?: number // launched: workers already running on that account (every group)
  copied?: boolean // moved: the transcript was carried over
  notice?: string // limit / signed-out / retry / interrupted: the CLI's words, one line
  until?: string // limit: the wall's end; signed-out: its next recheck (ISO)
  pct?: number | null // handoff-requested: how far into its limit (null: on request)
  path?: string // handoff file
  pending?: number // follow-up-queued: messages waiting now; cancelled: messages kept
  urgent?: boolean // follow-up-queued: the running work is stopped to deliver it first
  retry?: number // retry / interrupted: which retry this is, of 3
  waitS?: number // retry: seconds until it
  costUsd?: number // done / turn-done: this attempt's spend
  turns?: number // done / turn-done: this attempt's turns
  totalCostUsd?: number // done / turn-done: the worker's so far
  error?: string // failed / waiting: the first line
  said?: string // turn-end: the first line of the turn's closing text
  cwd?: string // dispatched
  accounts?: number // dispatched: how many accounts it is restricted to (absent: any)
}

export const JOURNAL_MAX_BYTES = 5 * 1024 * 1024

/** The previous file a rotation keeps: `journal.jsonl` → `journal.1.jsonl`. */
export const previousJournal = (path: string): string => path.replace(/\.jsonl$/, '.1.jsonl')

/** The first non-empty line, trimmed and capped: journal lines stay short. */
export function firstLine(text: string | null | undefined, max = 300): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  return line.trim().slice(0, max)
}

/** Append one entry, rotating first when the file has reached `maxBytes`. Never throws. */
export function appendJournal(
  path: string,
  entry: CorchJournalEntry,
  maxBytes = JOURNAL_MAX_BYTES,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      // no journal yet
    }
    if (size >= maxBytes) renameSync(path, previousJournal(path))
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.error('[corch] could not write the journal:', err)
  }
}

export interface JournalFilter {
  group?: string
  id?: string
  /** Epoch ms or an ISO time: only entries after it. */
  since?: number | string
  /** The newest this many (default 100, at most 5000). */
  limit?: number
}

function sinceMs(since: JournalFilter['since']): number | null {
  if (since === undefined || since === '') return null
  const n =
    typeof since === 'number' ? since : /^\d+$/.test(since) ? Number(since) : Date.parse(since)
  return Number.isFinite(n) ? n : null
}

/** Entries in scope, oldest first, the newest `limit` of them. Reads the previous file only when
 *  the current one does not hold enough. */
export function readJournal(path: string, filter: JournalFilter = {}): CorchJournalEntry[] {
  const limit = Math.min(5_000, Math.max(1, Math.floor(filter.limit ?? 100)))
  const after = sinceMs(filter.since)
  const pick = (file: string): CorchJournalEntry[] => {
    if (!existsSync(file)) return []
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: CorchJournalEntry[] = []
    for (const line of text.split('\n')) {
      // A cheap text check before the parse: a filtered read of a 5 MB file parses only its lines.
      if (!line || (filter.id && !line.includes(filter.id))) continue
      if (filter.group && !line.includes(filter.group)) continue
      let e: CorchJournalEntry
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (filter.id && e.id !== filter.id) continue
      if (filter.group && e.group !== filter.group) continue
      if (after !== null && !(Date.parse(e.ts) > after)) continue
      out.push(e)
    }
    return out
  }
  let entries = pick(path)
  if (entries.length < limit) entries = [...pick(previousJournal(path)), ...entries]
  return entries.slice(-limit)
}

const pct = (v: number | null | undefined): string =>
  typeof v === 'number' ? `${Math.round(v)}%` : '?'
const usd = (v: number | undefined): string => `$${(v ?? 0).toFixed(2)}`
const pad = (n: number): string => String(n).padStart(2, '0')
const turns = (n: number | undefined): string => `${n ?? 0} ${n === 1 ? 'turn' : 'turns'}`

/** `HH:MM:SS` in the daemon's local time; entries from another day get their date in front. */
export function journalTime(ts: string, now: Date = new Date()): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

/** What happened, in words (the part of a readable line after the worker's id and title). */
export function describeJournalEntry(e: CorchJournalEntry, now: Date = new Date()): string {
  const on = e.account ? ` on ${e.account}` : ''
  const pick = `(session ${pct(e.sessionPct)}, week ${pct(e.weekPct)}, ${e.active ?? 0} active)`
  const at = (iso: string | undefined): string => (iso ? journalTime(iso, now) : '?')
  switch (e.event) {
    case 'dispatched':
      return `dispatched in ${e.cwd ?? '?'}${e.accounts ? ` (restricted to ${e.accounts} account${e.accounts === 1 ? '' : 's'})` : ''}`
    case 'launched':
      return `launched${on} ${pick}${e.attempt && e.attempt > 1 ? `, attempt ${e.attempt}` : ''}`
    case 'moved':
      return `moved from ${e.from ?? '?'} to ${e.account ?? '?'}${e.copied === false ? ' (no transcript to carry)' : ''}`
    case 'limit':
      return `hit its limit${on}; walled until ${at(e.until)}${e.notice ? `: ${e.notice}` : ''}`
    case 'signed-out':
      return `signed out${on}; rechecked at ${at(e.until)}${e.notice ? `: ${e.notice}` : ''}`
    case 'handoff-requested':
      return `asked to hand off${on} ${typeof e.pct === 'number' ? `(at ${Math.round(e.pct)}% of its limit)` : '(on request)'}`
    case 'handoff-written':
      return `wrote its handoff${on}`
    case 'handoff-resumed':
      return `resumed from its handoff${on} ${pick}`
    case 'follow-up-queued':
      return e.urgent
        ? `urgent follow-up: its running work is stopped to deliver it first (${e.pending ?? 1} waiting)`
        : `follow-up queued (${e.pending ?? 1} waiting)`
    case 'follow-up-delivered':
      return `follow-up delivered${on} ${pick}`
    case 'retry':
      return `retry ${e.retry ?? '?'}/3${on} in ${e.waitS ?? 0} s${e.notice ? `: ${e.notice}` : ''}`
    case 'interrupted':
      return `interrupted${on} (AgentHydra restarted or the process was killed); resuming, retry ${e.retry ?? '?'}/3`
    case 'waiting':
      return `waiting: ${e.error ?? 'no account is free'}`
    case 'turn-done':
      return `turn done${on}: ${usd(e.costUsd)}, ${turns(e.turns)} (task so far ${usd(e.totalCostUsd)}); next queued message follows`
    case 'turn-end':
      return `turn ended${on}${e.said ? `: ${e.said}` : ''}`
    case 'done':
      return `done${on}: ${usd(e.costUsd)}, ${turns(e.turns)} (task total ${usd(e.totalCostUsd)})`
    case 'failed':
      return `failed${on}: ${e.error ?? '?'}`
    case 'cancelled':
      return `cancelled${on}${e.pending ? `; ${e.pending} queued message(s) kept for when it is continued` : ''}`
    default:
      return String(e.event)
  }
}

/** One readable line: `23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`. */
export function formatJournalLine(e: CorchJournalEntry, now: Date = new Date()): string {
  return `${journalTime(e.ts, now)} ${e.id} '${e.title}' ${describeJournalEntry(e, now)}`
}
