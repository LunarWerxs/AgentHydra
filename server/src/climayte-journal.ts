// server/src/climayte-journal.ts — CliMayte's orchestration journal (docs/CLIMAYTE.md "Journal"): one short
// JSON line per state change of every worker, in `<CONFIG_DIR>/corch/journal.jsonl`.
//
// WHY (owner, 2026-09-30, the first real climayte task): "we probably also need logging in CliMayte".
// Each worker keeps its own stream-json log and its last 60 events, but nothing told the story of a
// whole orchestration in one place: what was dispatched, which account each attempt got and why,
// the moves, handoffs, retries, finishes and their cost. This file is that record. climayte.ts writes
// it; the route, the climayte_log MCP tool and the CliMayte view's Log read it.
//
// Append-only, a few hundred bytes a line, rotated at JOURNAL_MAX_BYTES with one previous file kept
// (`journal.1.jsonl`). A failed write is logged and dropped: the journal must never stop a worker.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type CliMayteJournalEvent =
  | 'dispatched' // climayte_run created it
  | 'launched' // an attempt started on an account (the pick's reasons ride along)
  | 'moved' // the session changed account (before the launch on the new one)
  | 'limit' // the account hit its usage limit (or was stopped short of paid extra usage)
  | 'signed-out' // the account's login failed
  | 'handoff-requested' // asked to wrap up and write a handoff (near its limit, or on request)
  | 'handoff-written' // it wrote the handoff; the task goes on in a fresh session
  | 'handoff-resumed' // the fresh session started from the handoff
  | 'follow-up-queued' // climayte_send queued a message
  | 'cwd-changed' // climayte_send asked for another folder (`cwd`, `from`; `pending`), or the launch moved there (`copied`)
  | 'follow-up-delivered' // an attempt started with that message
  | 'asked' // the worker asked a question (climayte_ask; `said`: its first line); the answer is climayte_send
  | 'retry' // the API was overloaded, or the next attempt could not start: tried again later
  | 'interrupted' // the CLI was killed from outside (a daemon restart); resumed
  | 'cleaned' // its attempt ended and what the session left running was ended (`notice`: which)
  | 'waiting' // no account it may use is free
  | 'install-broken' // the Claude Code install does not run: held, no retry spent (`notice`: why)
  | 'install-repaired' // the install runs again: held work released
  | 'spill' // no account within its group's per_account took it: it started past it (`notice`: why)
  | 'start-short' // no account had room for it, none refills within five minutes: it started where the most room is (`notice`)
  | 'turn-done' // a turn finished and a queued follow-up comes next
  | 'turn-end' // a turn ended with this text (a Stop hook can force more turns after the report)
  | 'check' // the worker reported done; CliMayte runs the task's check command (`notice`: the command)
  | 'verdict' // its result was judged pass or fail (climayteVerdict); a fail names the next setting
  | 'priority' // its priority was changed (climayteSetPriority)
  | 'nudged' // an idle account was sent one cheap prompt to start its 5-hour window (session-keepalive.ts); id and group 'keepalive'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface CliMayteJournalEntry {
  ts: string // ISO time
  id: string
  group: string
  title: string
  event: CliMayteJournalEvent
  account?: string // '#84', or the account's name when it has no number
  from?: string // moved: the account it left
  attempt?: number // 1-based
  sessionPct?: number | null // launched: the account's 5-hour window when it was picked
  weekPct?: number | null // launched: its week
  active?: number // launched: workers already running on that account (every group)
  copied?: boolean // moved: the transcript was carried over
  notice?: string // limit / signed-out / retry / interrupted: the CLI's words, one line
  until?: string // limit: the wall's end; signed-out: its next recheck; waiting: its waitUntil (ISO)
  pct?: number | null // handoff-requested: how far into its limit (null: on request); limit at the ceiling: the reading
  path?: string // handoff file
  pending?: number // follow-up-queued: messages waiting now; cancelled: messages kept
  urgent?: boolean // follow-up-queued: the running work is stopped to deliver it first
  retry?: number // retry / interrupted: which retry this is, of 3
  waitS?: number // retry: seconds until it
  costUsd?: number // done / turn-done: this attempt's spend
  turns?: number // done / turn-done: this attempt's turns
  totalCostUsd?: number // done / turn-done: the worker's so far
  etaMin?: number // done / turn-done: the worker's own estimate for the message (its `ETA:` line)
  tookMin?: number // done / turn-done: the minutes it really worked on it (climayte-eta.ts)
  error?: string // failed / waiting: the first line
  said?: string // turn-end: the first line of the turn's closing text
  model?: string | null // dispatched / launched / follow-ups: the model asked for (null: the CLI's default)
  effort?: string | null // the same, for the effort level
  cwd?: string // dispatched / cwd-changed: the folder
  accounts?: number // dispatched: how many accounts it is restricted to (absent: any)
  kind?: string // dispatched / verdict: the kind of work (climayte-scorecard CLIMAYTE_KINDS)
  severity?: number // verdict: a fail's severity, 0-3 (climayte-scorecard.ts)
  reason?: string // dispatched with model auto: why the scorecard picked that setting
  verdict?: 'pass' | 'fail' // verdict
  priority?: number // dispatched / priority: higher starts first (0: the default)
  was?: number // priority: the one it replaced
  ceiling?: boolean // limit: CliMayte stopped it at its ceiling (90%), not the account's limit
  onArrival?: boolean // limit at the ceiling: already past it at the run's first reading (pastOnArrival)
  ok?: boolean // nudged: the window was seen running after it
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
  entry: CliMayteJournalEntry,
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
    console.error('[climayte] could not write the journal:', err)
  }
}

export interface JournalFilter {
  group?: string
  id?: string
  /** Epoch ms or an ISO time: only entries after it. */
  since?: number | string
  /** The newest this many (default 30, at most 5000; `since` reads only the new ones). */
  limit?: number
}

function sinceMs(since: JournalFilter['since']): number | null {
  if (since === undefined || since === '') return null
  const n =
    typeof since === 'number' ? since : /^\d+$/.test(since) ? Number(since) : Date.parse(since)
  return Number.isFinite(n) ? n : null
}

// Entries of one read whose worker an earlier entry of the same read already named: their readable
// line prints the id alone. The climayte_log MCP answer is re-sent with the chat's whole context,
// and the title repeated on every line was 42% of its bytes (review, 2026-10-01). A WeakSet, so the
// mark lives and dies with the read's own objects and the JSON answer stays as it was.
const titleShown = new WeakSet<CliMayteJournalEntry>()

/** Entries in scope, oldest first, the newest `limit` of them. Reads the previous file only when
 *  the current one does not hold enough. */
export function readJournal(path: string, filter: JournalFilter = {}): CliMayteJournalEntry[] {
  // 30, not 100: one wake reads what is new (`since`), and 100 lines was more than any wake used.
  const limit = Math.min(5_000, Math.max(1, Math.floor(filter.limit ?? 30)))
  const after = sinceMs(filter.since)
  const pick = (file: string): CliMayteJournalEntry[] => {
    if (!existsSync(file)) return []
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: CliMayteJournalEntry[] = []
    for (const line of text.split('\n')) {
      // A cheap text check before the parse: a filtered read of a 5 MB file parses only its lines.
      if (!line || (filter.id && !line.includes(filter.id))) continue
      if (filter.group && !line.includes(filter.group)) continue
      let e: CliMayteJournalEntry
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
  const out = entries.slice(-limit)
  const named = new Set<string>()
  for (const e of out) {
    if (named.has(e.id)) titleShown.add(e)
    else named.add(e.id)
  }
  return out
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

/** `dispatched in <cwd>`, with its kind, the accounts it may use, its model, why, its priority. */
function describeDispatchLine(e: CliMayteJournalEntry, runs: string): string {
  return `dispatched in ${e.cwd ?? '?'}${e.kind ? ` as ${e.kind}` : ''}${e.accounts ? ` (restricted to ${e.accounts} account${e.accounts === 1 ? '' : 's'})` : ''}${runs}${e.reason ? ` (${e.reason})` : ''}${e.priority ? `, priority ${e.priority}` : ''}`
}

/** `launched on <account> (pick's session, week, active); second and later attempts say which.` */
function describeLaunchLine(
  e: CliMayteJournalEntry,
  on: string,
  pick: string,
  runs: string,
): string {
  return `launched${on} ${pick}${e.attempt && e.attempt > 1 ? `, attempt ${e.attempt}` : ''}${runs}`
}

/** `moved from <old> to <new>`; says so when the transcript was not carried over. */
function describeMovedLine(e: CliMayteJournalEntry): string {
  return `moved from ${e.from ?? '?'} to ${e.account ?? '?'}${e.copied === false ? ' (no transcript to carry)' : ''}`
}

/** `limit`: the CliMayte ceiling (when it stopped the account) or the account's own wall; both rest until. */
function describeLimitLine(
  e: CliMayteJournalEntry,
  on: string,
  at: (iso: string | undefined) => string,
): string {
  if (e.ceiling && e.onArrival)
    return `found past CliMayte's ceiling${typeof e.pct === 'number' ? ` (${Math.round(e.pct)}%)` : ''} on its first request${on}, placed on an old or missing reading; account rests until ${at(e.until)}`
  if (e.ceiling)
    return `stopped at CliMayte's ceiling${typeof e.pct === 'number' ? ` (${Math.round(e.pct)}%)` : ''}${on}; account rests until ${at(e.until)}`
  return `hit its limit${on}; walled until ${at(e.until)}${e.notice ? `: ${e.notice}` : ''}`
}

/** `signed out`: it takes no work until it signs in again, and the CLI's words when it gave them. */
function describeSignedOutLine(e: CliMayteJournalEntry, on: string): string {
  return `signed out${on}; not used until it signs in again${e.notice ? `: ${e.notice}` : ''}`
}

/** `asked to hand off`: how far into its limit it was, or on request. */
function describeHandoffRequestedLine(e: CliMayteJournalEntry, on: string): string {
  return `asked to hand off${on} ${typeof e.pct === 'number' ? `(at ${Math.round(e.pct)}% of its limit)` : '(on request)'}`
}

/** The short events: `wrote its handoff`, `ended what its session left running`, `checking its result`. */
function describeShortLine(e: CliMayteJournalEntry, on: string, event: string): string {
  if (event === 'handoff-written') return `wrote its handoff${on}`
  if (event === 'cleaned') return `ended what its session left running${on}: ${e.notice ?? '?'}`
  return `checking its result: ${e.notice ?? '?'}`
}

/** `follow-up queued` (urgent: its running work is stopped) and how many messages wait. */
function describeFollowUpQueuedLine(e: CliMayteJournalEntry, runs: string): string {
  return e.urgent
    ? `urgent follow-up: its running work is stopped to deliver it first (${e.pending ?? 1} waiting)${runs}`
    : `follow-up queued (${e.pending ?? 1} waiting)${runs}`
}

/** `retry <n>/3` in so many seconds; the CLI's words, when it gave them. */
function describeRetryLine(e: CliMayteJournalEntry, on: string): string {
  return `retry ${e.retry ?? '?'}/3${on} in ${e.waitS ?? 0} s${e.notice ? `: ${e.notice}` : ''}`
}

/** `waiting`, until about a wall or until an account is free; the first line of the error. */
function describeWaitingLine(
  e: CliMayteJournalEntry,
  at: (iso: string | undefined) => string,
): string {
  return `waiting${e.until ? ` until about ${at(e.until)}` : ''}: ${e.error ?? 'no account is free'}`
}

/** The attempt's spend and turns, then how the turn ended: `turn done` or `done`. */
function describeDoneTurnLine(e: CliMayteJournalEntry, on: string, event: string): string {
  const eta =
    e.etaMin !== undefined && e.tookMin !== undefined
      ? `; estimated ${e.etaMin} min, took ${e.tookMin} min`
      : ''
  if (event === 'turn-done')
    return `turn done${on}: ${usd(e.costUsd)}, ${turns(e.turns)} (task so far ${usd(e.totalCostUsd)})${eta}; next queued message follows`
  return `done${on}: ${usd(e.costUsd)}, ${turns(e.turns)} (task total ${usd(e.totalCostUsd)})${eta}`
}

/** `judged`: its verdict, with the next setting (on a fail) and the words that came with it. */
function describeVerdictLine(e: CliMayteJournalEntry, runs: string): string {
  return `judged ${e.verdict === 'pass' ? 'a pass' : 'a fail'}${runs}${e.notice ? `: ${e.notice}` : ''}${e.verdict === 'fail' && e.reason ? `; ${e.reason}` : ''}`
}

/** `nudged`: the 5-hour window started (when it resets, the model and its cost) or not. */
function describeNudgedLine(
  e: CliMayteJournalEntry,
  on: string,
  at: (iso: string | undefined) => string,
): string {
  return e.ok
    ? `started the 5-hour window${on}${e.until ? `; it resets ${at(e.until)}` : ''}${e.model ? ` (${e.model}, ${usd(e.costUsd)})` : ''}`
    : `nudge${on} did not start the window: ${e.notice ?? '?'}`
}

/** `cwd-changed`: the folder it continues in, now or from its next launch. */
function describeCwdChangedLine(e: CliMayteJournalEntry): string {
  return e.pending
    ? `asked to continue in ${e.cwd ?? '?'}${e.from ? ` (now ${e.from})` : ''}, from its next launch`
    : `continues in ${e.cwd ?? '?'}${e.from ? ` (was ${e.from})` : ''}${e.copied === false ? ' (no transcript to carry; the session starts fresh there)' : ''}`
}

/** The pieces several lines share, worked out once per entry. */
interface DescribeParts {
  on: string
  pick: string
  runs: string
  at: (iso: string | undefined) => string
}

type Describe = (e: CliMayteJournalEntry, p: DescribeParts) => string

/** One line per event; an event not listed reads as its own name. */
const DESCRIBE: Partial<Record<CliMayteJournalEvent, Describe>> = {
  dispatched: (e, p) => describeDispatchLine(e, p.runs),
  launched: (e, p) => describeLaunchLine(e, p.on, p.pick, p.runs),
  moved: (e) => describeMovedLine(e),
  limit: (e, p) => describeLimitLine(e, p.on, p.at),
  'signed-out': (e, p) => describeSignedOutLine(e, p.on),
  'handoff-requested': (e, p) => describeHandoffRequestedLine(e, p.on),
  'handoff-written': (e, p) => describeShortLine(e, p.on, 'handoff-written'),
  'handoff-resumed': (_e, p) => `resumed from its handoff${p.on} ${p.pick}${p.runs}`,
  'follow-up-queued': (e, p) => describeFollowUpQueuedLine(e, p.runs),
  'follow-up-delivered': (_e, p) => `follow-up delivered${p.on} ${p.pick}${p.runs}`,
  asked: (e, p) => `asked${p.on}${e.said ? `: ${e.said}` : ''}`,
  retry: (e, p) => describeRetryLine(e, p.on),
  cleaned: (e, p) => describeShortLine(e, p.on, 'cleaned'),
  interrupted: (e, p) =>
    `interrupted${p.on} (AgentHydra restarted or the process was killed); resuming, retry ${e.retry ?? '?'}/3`,
  waiting: (e, p) => describeWaitingLine(e, p.at),
  spill: (e, p) => `spilled past its group's per_account${p.on}: ${e.notice ?? ''}`,
  'start-short': (e, p) => `started short${p.on}: ${e.notice ?? ''}`,
  'turn-done': (e, p) => describeDoneTurnLine(e, p.on, 'turn-done'),
  'turn-end': (e, p) => `turn ended${p.on}${e.said ? `: ${e.said}` : ''}`,
  check: (e, p) => describeShortLine(e, p.on, 'check'),
  verdict: (e, p) => describeVerdictLine(e, p.runs),
  'cwd-changed': (e) => describeCwdChangedLine(e),
  priority: (e) => `priority set to ${e.priority ?? 0} (was ${e.was ?? 0})`,
  nudged: (e, p) => describeNudgedLine(e, p.on, p.at),
  done: (e, p) => describeDoneTurnLine(e, p.on, 'done'),
  failed: (e, p) => `failed${p.on}: ${e.error ?? '?'}`,
  cancelled: (e, p) =>
    `cancelled${p.on}${e.pending ? `; ${e.pending} queued message(s) kept for when it is continued` : ''}`,
}

/** What happened, in words (the part of a readable line after the worker's id and title). */
export function describeJournalEntry(e: CliMayteJournalEntry, now: Date = new Date()): string {
  // A line read back from disk can name any event, so only the table's own keys are looked up.
  const describe = Object.hasOwn(DESCRIBE, e.event) ? DESCRIBE[e.event] : undefined
  if (!describe) return String(e.event)
  // The model and effort asked for, when either was (the entry records null for the CLI's default).
  const runs =
    e.model || e.effort
      ? ` with ${e.model ?? 'the default model'}, effort ${e.effort ?? 'default'}`
      : ''
  return describe(e, {
    on: e.account ? ` on ${e.account}` : '',
    pick: `(session ${pct(e.sessionPct)}, week ${pct(e.weekPct)}, ${e.active ?? 0} active)`,
    runs,
    at: (iso) => (iso ? journalTime(iso, now) : '?'),
  })
}

/** One readable line: `23:41:07 w-1234abcd 'Fix events rows' launched on #84 (session 12%, week 0%, 0 active)`.
 *  The title only on a worker's first line of one read (readJournal); its later lines carry the id alone. */
export function formatJournalLine(e: CliMayteJournalEntry, now: Date = new Date()): string {
  const who = titleShown.has(e) ? e.id : `${e.id} '${e.title}'`
  return `${journalTime(e.ts, now)} ${who} ${describeJournalEntry(e, now)}`
}
