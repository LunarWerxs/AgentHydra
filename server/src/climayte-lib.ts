// server/src/climayte-lib.ts — the PURE half of CliMayte (docs/CLIMAYTE.md): record types, the worker brief,
// and the decisions that must be testable without a process, a timer or the store: how an attempt
// ended, which account takes the next one, how a session moves between accounts. climayte.ts (timers,
// store, spawning) imports from here; nothing here starts anything. The one impurity is
// copySessionTranscript, which copies files with node:fs.
//
// classifyAttempt leans on rate-limit-signal.ts and keeps its trusted-places rule: only the CLI's
// own API-error events, an errored terminal `result`, or stderr are evidence of a wall. Model prose
// and tool output never are, or a worker that merely TALKS about a session limit gets walled.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CliMayteEta, ETA_INSTRUCTION, stripReview } from './climayte-eta'
import { type CliMayteOrigin, verdictCoversNewestWork } from './climayte-ping'
import {
  type CliMaytePlacement,
  fitPct,
  PACE_BAND,
  paceGap,
  projectedPct,
} from './climayte-placement'
import {
  attemptUnits,
  type CliMayteVerdict,
  rereadUnits,
  UNITS_PER_PRO_PERCENT,
} from './climayte-scorecard'
import { pinHaikuModel } from './core/haiku-pin'
import { sharedKitStore, usageQuery } from './kit/query'
import type { KitStore } from './kit/store'
import {
  classifyLimit,
  compactNotice,
  createLimitStopTracker,
  isApiErrorEvent,
  limitEventText,
} from './rate-limit-signal'
import { contextOf, parseUsageLine, readTurnUsage } from './usage-tokens'

export type CliMayteStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'checking' // the worker reported done; CliMayte is running the task's `check` command
  | 'done'
  | 'failed'
  | 'cancelled'
// waiting = no eligible account right now (all at their limit or signed out); retried every tick
export type AttemptOutcome =
  | 'running'
  | 'done'
  | 'quota'
  | 'transient'
  | 'auth'
  | 'interrupted' // the CLI ended with no result and no error: killed (a daemon restart), not failed
  | 'install-broken' // died at once with no output while the Claude Code install does not run: held, no retry spent
  | 'handoff' // wound down near its limit and wrote a handoff; the task goes on in a fresh session
  | 'error'
  | 'cancelled'

export interface CliMayteAccountRef {
  id: string
  num: number | null
  name: string
  /** On an attempt: the config folder it ran in, so its spend is read from the transcript it wrote
   *  even when the instance store no longer lists that folder (absent on attempts before 2026-10-01). */
  configDir?: string
}

export interface CliMayteAttempt {
  account: CliMayteAccountRef
  pid: number | null
  log: string // absolute path of this attempt's stream-json stdout log
  errLog: string // absolute path of its stderr log
  startedAt: number
  endedAt: number | null
  outcome: AttemptOutcome
  notice: string | null // the limit/error notice, compacted (compactNotice)
  resumed: boolean // true when this attempt ran `--resume` (a follow-up or a handoff)
  started?: boolean // true once the CLI logged system/init: its message reached the session
  daemonPid?: number // the daemon that launched it; its handle dies with that daemon
  overage?: { resetsAt: number | null; notice?: string } // stopped to spare paid extra usage
  /** Stopped at CEILING_PCT of that window (`week`), the account walled until it resets. Its outcome
   *  is 'quota' or 'handoff' for what follows; it is not a limit hit. `onArrival`: its first reading
   *  was already past the ceiling (pastOnArrival), so it was placed on a stale or missing reading
   *  and did no work; absent on stops recorded before 2026-10-02 until the load backfills it. */
  ceiling?: {
    pct: number
    week: boolean
    resetsAt: number | null
    onArrival?: boolean
    /** The ceiling it was stopped at when the owner's cap set one under CEILING_PCT (ceilingPct). */
    line?: number
  }
  /** Asked to hand off to `path`. `pct`: the usage reading that called for it; null on request, and
   *  null with `reason: 'context'` when its conversation's size did (CONTEXT_HANDOFF_TOKENS). */
  windDown?: { at: number; pct: number | null; path: string; reason?: 'context' }
  tokens?: CliMayteTokens // this attempt's own tokens (attemptSpend); absent on attempts before 2026-09-30
  /** Its cost at API prices and its model requests, from its transcript when it ended, and `reread`:
   *  on an attempt after one that ran, its first request's input and cache writes, the conversation
   *  read again into a cold cache after a move, a limit, a handoff or a gap. That is restart
   *  overhead, not work (rereadUnits). null: its transcript could not be read. Absent until set. */
  spend?: { costUsd: number; turns: number; reread: CliMayteTokens | null } | null
  /** Set when the attempt was charged before the analytics kit had ingested all of its transcript:
   *  the cost charged then. settleSpends reads it again once the kit catches up, then clears this. */
  spendOpen?: number
  /** When settleSpends last read the kit for this open attempt (it reads at most once a minute). */
  spendReadAt?: number
  /** True when the kit never covered this attempt's files within SPEND_SETTLE_CAP_MS: its spend is
   *  whatever the kit held then and may be short. */
  spendCapped?: true
  /** The session this attempt ran in. A planned handoff starts a new one, so the worker's current
   *  `sessionId` is not every attempt's. null: the log names none (the CLI never started). */
  sessionId?: string | null
  /** The prompt cache it ran with ('5m' since 49e6ab1, '1h' for a manager; absent: the 1-hour default). */
  cacheTtl?: '5m' | '1h'
  /** The conversation's size when it ended: what its newest request read (contextTokens). A
   *  manager past MANAGER_CONTEXT_TOKENS starts its next wake in a fresh session. */
  context?: number | null
  /** The account's 5-hour usage when it started (placement measures what running work spent). */
  startPct?: number | null
  /** The highest 5-hour usage its account reported while it ran (the CLI's rate_limit_event), with
   *  that window's reset (epoch ms): the test metric for "stop at 85-90%, never the limit". null: no
   *  reading in its log. Absent until set. */
  peak?: { pct: number; resetsAt: number | null } | null
  /** What it was launched with (`--model`, `--effort`; null: the CLI's default). Absent before 2026-10-01. */
  requested?: { model: string | null; effort: string | null }
  /** The model the CLI reported in its system/init event: what really ran. */
  model?: string
  /* Run under a runner outside the daemon (climayte-runner.ts), so a daemon restart leaves it running.
   *  `pid` is the runner's, filled from `pidFile` once it has claimed the spec; the CLI's own is the
   *  attempt's `pid`, filled once the CLI has started. Absent on attempts spawned by the daemon
   *  directly (before 2026-09-30). `killOnStart`: a stop came before the runner wrote its pid but
   *  after it claimed the spec, so the tick kills it as soon as its pid file appears (killLateStarts
   *  in climayte.ts); absent otherwise. */
  /** What the session left running when it ended (a background job, a dev server): ended with it,
   *  so whatever it was waiting on did not finish (cleanUpRunner). Absent: nothing. */
  left?: string[]
  /** The most processes its worker's tree had alive at once (Windows, the runner's job; console
   *  hosts included): what one worker really costs. Absent off Windows or before 2026-10-04. */
  peakProcesses?: number
  runner?: {
    pid: number | null
    pidFile: string
    exitFile: string
    launchedAt: number
    killOnStart?: boolean
  }
}

/** Tokens a CliMayte session ran, from its transcript: what CliMayte took off the orchestrating chat
 *  (owner, 2026-09-30: record each session's tokens, and count the total offloaded). */
export interface CliMayteTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const noTokens = (): CliMayteTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function addTokens(a: CliMayteTokens | undefined, b: CliMayteTokens): CliMayteTokens {
  const t = a ?? noTokens()
  return {
    input: t.input + b.input,
    output: t.output + b.output,
    cacheRead: t.cacheRead + b.cacheRead,
    cacheWrite: t.cacheWrite + b.cacheWrite,
  }
}

/** A task's size, all in % of a Pro 5-hour window (a Max 5x window is 475): its expected cost and
 *  what that is based on, the biggest window it may use (FIT_PCT of it), and the most room any of
 *  those accounts has (`room`, counting what the work running there will still use; null with no
 *  account to place on) on `roomOn`. */
export interface CliMayteSizing {
  expected: number
  basis: string
  window: number
  room: number | null
  roomOn: string | null
}

/** A sealed task's launch (docs/CLIMAYTE.md, "Sealed tasks"): the CLI gets this system prompt in
 *  place of its own, this MCP config and no other server, no built-in tool, and no settings source. */
export interface CliMayteSealed {
  systemPromptFile: string
  mcpConfig: string
  allowedTools: string[]
}

export interface CliMayteWorker {
  id: string // short id, e.g. 'w-' + 8 hex chars
  group: string // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string // short label (caller's or the first 60 chars of the prompt)
  cwd: string
  /** A folder a message asked to move it to (climayte_send `cwd`); the next launch carries the session
   *  there, sets `cwd` and clears this. Absent: none. */
  pendingCwd?: string
  prompt: string // the task as given
  pending: string[] // follow-up messages not yet delivered (FIFO)
  model: string | null
  effort: string | null
  accounts: string[] | null // restrict to these CLI instance ids (null = every signed-in one)
  status: CliMayteStatus
  sessionId: string | null // minted by CliMayte before the first launch (`--session-id`)
  accountId: string | null // the account holding the session now
  attempts: CliMayteAttempt[]
  result: string | null // the report: `results` joined (joinResults), oldest turn first
  /** Each turn's closing text for the current message, oldest first (addResults caps it). A repo's
   *  Stop hook can force extra turns after the report (field note 13); each one is kept here. Absent
   *  on tasks recorded before 2026-10-01. */
  results?: string[]
  /** The reports of earlier messages, oldest first (MAX_REPORTS): a delivered follow-up starts a new
   *  `results`, and the previous one moves here. Field note 13 regression (2026-10-01): a follow-up
   *  queued while the first turn ran was delivered the second that turn ended, so the task never
   *  rested at done and its first report (two commits' worth) was wiped before anyone read it. */
  reports?: Array<{ at: number; message: string; results: string[] }>
  /** The first line of the message the current `results` answer (the task, or a follow-up). */
  message?: string
  error: string | null
  lastActivity: string | null // one line: the newest event summarised (summarizeEvent)
  costUsd: number // summed over every attempt's own spend (attemptSpend), from the kit
  tokens?: CliMayteTokens // summed the same way; absent on tasks recorded before 2026-09-30
  turns: number // summed `result.num_turns`
  moves: number // how many times the session changed account
  retries: number // transient or interrupted retries used in the current turn
  notBefore: number | null // epoch ms; a transient retry waits until then
  /** While waiting: when it expects to start (ISO, UTC), the first account's limit or reset that
   *  lets it; absent or null when not known. A waiter reads this, never the error text's local time. */
  waitUntil?: string | null
  /** When it was first held for another account's refill or for room this turn (ISO): the hold ends
   *  one RESUME_WAIT_MS later however many refills come (waitsForCooldown, waitsForRoom). Cleared
   *  at launch. */
  heldForResetSince?: string | null
  revived?: boolean // a message revived it after it stopped: deliver that message next
  sessions?: string[] // earlier sessions of this task, oldest first (each handoff starts a new one)
  /** The kind of work (climayte-scorecard CLIMAYTE_KINDS): the scorecard learns what each kind needs. */
  kind?: string | null
  /** CliMayte chose `model` and `effort` from the scorecard (dispatched with model `auto`). */
  auto?: boolean
  /** One of the owner's own interactive chats, run headless (docs/CLIMAYTE.md, "Chat workers"):
   *  launched like his own `claude` in the folder, with no worker brief, his full instructions and
   *  skills, and Opus xhigh unless the task names its own. Absent: an ordinary delegated worker. */
  chat?: boolean
  /** A Desk chat's add-ons (only with `chat`): its appended system text and connector MCP servers.
   *  Every launch of the worker, continuations and account moves included, carries them. */
  desk?: { append: string; mcpServers: Record<string, object> }
  /** A sealed worker (CliMayteSealed): nothing of the owner's or of CliMayte's in its context, and
   *  an empty temp folder as `cwd`. Absent: an ordinary delegated worker. */
  sealed?: CliMayteSealed
  /** Each judgement of its result, oldest first (climayteVerdict). */
  verdicts?: CliMayteVerdict[]
  /** A shell command that proves the task is done (exit 0). CliMayte runs it in `cwd` after the worker
   *  reports, records the verdict itself and sends a fail back one rung up (climayte.ts startCheck). */
  check?: string | null
  /** How many times `check` has run. */
  checkRuns?: number
  /** The check running now, under a runner outside the daemon like an attempt's CLI (climayte.ts
   *  startCheck): its output `log`, and the runner's pid and files. Absent when none runs. */
  checkRunner?: {
    log: string
    pid: number | null
    pidFile: string
    exitFile: string
    launchedAt: number
    /** The times this round's runner was started again after it never started or ended without
     *  an exit file (pollChecks; CHECK_RELAUNCHES). Absent: none. */
    relaunches?: number
  } | null
  /** Earlier rounds' checks still being stopped when a new round's check started (startCheck): each
   *  goes once its runner is killed or its spec voided (stopStaleChecks). Absent: none. */
  staleChecks?: NonNullable<CliMayteWorker['checkRunner']>[]
  /** Its size at dispatch (climayte.ts sizeTasks); `room` and `roomOn` are refreshed when it starts
   *  waiting for room. */
  size?: CliMayteSizing
  /** Queued and waiting work starts highest first, then oldest first (dueOrder). Absent: 0. */
  priority?: number
  /** A move found the transcript on no account (field note 30): the last handoff note, which the
   *  next message continues from in a fresh session. */
  handoffNote?: string | null
  /** The wave this worker belongs to (a task in a wave, or the manager worker). */
  wave?: string | null
  /** A manager with a live, unreported wave is held: no new attempt starts until the wave reports. */
  hold?: 'wave' | null
  /** A manager whose last turn ended with nothing of its wave running and no report was sent "report
   *  or dispatch"; a second such turn in a row fails it (docs/CLIMAYTE.md, "Report"). */
  waveNudged?: boolean
  /** Who dispatched it, so its news is pinged back there (climayte-ping.ts): the calling chat as
   *  the MCP route resolved it, or the worker that dispatched it. Absent: nobody is pinged (work
   *  dispatched before 2026-10-03, a wave task, or `notify: false`). */
  origin?: CliMayteOrigin
  /** What it asked with climayte_ask and waits on (its turn ends after asking). Cleared when the
   *  answer arrives through climayteSend. Absent: it asks nothing. */
  question?: CliMayteQuestion
  /** How long it said the current message would take (its `ETA:` line, climayte-eta.ts), and once
   *  that turn ended done, how long it took. Absent: it has said nothing yet (or is a chat). */
  eta?: CliMayteEta
  /** The settled estimates of its earlier messages, oldest first (MAX_PAST_ETAS). */
  pastEtas?: CliMayteEta[]
  createdAt: number
  updatedAt: number
}

/** A worker's question to the one that started it (docs/CLIMAYTE.md, "Questions from a worker"). */
export interface CliMayteQuestion {
  text: string
  options?: string[]
  context?: string
  at: number
}

export interface CliMayteWave {
  id: string // 'wv-' + 6 hex
  group: string // the workers' group; the manager's is 'mgr-' + id
  managerId: string // the manager worker
  plan: string // absolute path of the plan file (the manager reads it as needed)
  cwd: string // the repository the wave works in
  branch: string // the branch commits must land on (default: cwd's current branch)
  verify: string | null // the command the orchestrator runs on the merged result, carried to the report
  tasks: Array<{
    key: string // stable name from the plan ('t1', 'api-routes'), survives re-dispatch
    prompt: string
    title: string
    kind: string
    check: string | null
    paths: string[] // globs the diff may touch; [] = must not commit
    after: string[] // keys that must pass first (rounds)
    workerId: string | null // the current worker for this key
    dispatches?: number // workers started for this key (wave_dispatch); absent on older records = 0
    state: 'pending' | 'running' | 'passed' | 'failed' | 'escalated'
    proof: { check: boolean | null; commits: string[]; paths: boolean | null; note: string } | null
  }>
  escalations: Array<{ key: string; reason: string; at: number }>
  notes: string // the manager's scratch, capped at 2,000 chars
  rounds: number
  maxRounds: number // re-dispatches per key, default 3
  batch: { size: number; settleS: number; held: string[]; since: number | null }
  status: 'running' | 'reported' | 'verified' | 'rejected' | 'failed' | 'cancelled'
  report: string | null // the short report the orchestrator is woken with
  createdAt: number
  updatedAt: number
}

export interface CliMayteAccount {
  id: string
  num: number | null
  name: string
  configDir: string
  sessionPct: number | null
  weekPct: number | null
  /** How many Pro windows its 5-hour window holds (climayte-placement planFactor): Pro 1, Max 5x 4.75. */
  planFactor?: number
  /** When the 5-hour window `sessionPct` was read from resets (epoch ms); null when unknown. */
  sessionResetsAt?: number | null
  /** When the 7-day window `weekPct` was read from resets (epoch ms); null when unknown. */
  weekResetsAt?: number | null
  /** The linked Claude Code login has expired: `renewing` while the desktop side can refresh it,
   *  `open-once` when its desktop app must be opened once (desktop-cli-renew.ts loginExpiryState). */
  loginExpired?: 'renewing' | 'open-once'
  /** When `sessionPct` was read (epoch ms): the usage check's capture, or a worker's stream. Past
   *  READING_STALE_MS no task starts there until it is read again (readingPending). Absent: not
   *  known. */
  readAt?: number | null
  /** Its usage is being read again now (climayte-core refreshReading). */
  refreshing?: boolean
  /** When its usage was last asked to be read again for placement (epoch ms; null: not since the
   *  daemon started). */
  readTriedAt?: number | null
  /** Someone else is on this account now (climayte-core.ts signedInAccounts): how long ago a hand
   *  used its desktop app (core/hands-on.ts; null: not in the last ten minutes), and how many Claude
   *  sessions that are not CliMayte's run in its folder. */
  handsOnAgoMs?: number | null
  otherSessions?: number
  /** The owner's priority for it (AccountPlacement): new work goes to a higher one first among the
   *  accounts it fits (rankAccounts). Absent: 0, Normal. */
  priority?: number
  /** The owner's caps for it (AccountPlacement): its stop lines in place of the fleet's
   *  (sessionStopPct, accountWeekStopPct, ceilingPct). Absent or null: the fleet's. */
  maxSessionPct?: number | null
  maxWeekPct?: number | null
}

/** The owner's caps on one account (CliMayteAccount maxSessionPct / maxWeekPct). */
export type AccountCaps = Pick<CliMayteAccount, 'maxSessionPct' | 'maxWeekPct'>

/** Someone else's account right now (owner, 2026-10-02: CliMayte must not "step on the toes of
 *  other accounts running"): a person used its desktop app in the last ten minutes, or Claude
 *  sessions that are not CliMayte's run in its folder, the calling chat's own among them. */
export function accountInUse(a: CliMayteAccount): boolean {
  return a.handsOnAgoMs != null || (a.otherSessions ?? 0) > 0
}

/** `cred` (signed-out walls only): the mtime of the account's `.credentials.json` when it was
 *  walled, so a sign-in that rewrites the file is noticed before the wall runs out. */
export type CliMayteWalls = Record<string, { until: number; reason: string; cred?: number | null }>

/** A usage reading counts only while its window is open. Once `resetsAt` has passed, the
 *  percentage describes a window that no longer exists, and an old 99% would keep an account
 *  that has since refilled out of the pool until someone happened to check its usage again. */
export function livePct(
  limit: { pct: number; resetsAt?: string | null } | null | undefined,
  now: number,
): number | null {
  if (!limit || typeof limit.pct !== 'number') return null
  const ends = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return Number.isFinite(ends) && ends <= now ? null : limit.pct
}

/** An account's live usage as a running CLI streamed it (liveUsage): percentages 0..100, resets
 *  and `at` (when it was read) in epoch ms. A window the event did not carry is null. */
export interface CliMayteLiveUsage {
  sessionPct: number | null
  sessionResetsAt: number | null
  weekPct: number | null
  weekResetsAt: number | null
  /** The account has paid extra usage switched on (`overageStatus: "allowed"`): past its limit it bills. */
  overageAllowed: boolean
  at: number
}

/** The usage every main-agent `rate_limit_event` carries, measured in real logs:
 *  `{"status":"allowed","rateLimitType":"five_hour","resetsAt":1790803800,"overageStatus":"allowed",
 *  "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.52,"resetsAt":1790803800},
 *  "seven_day":{"utilization":0.03,"resetsAt":1791356400}}}` (utilization 0..1, resetsAt epoch
 *  seconds). Null for any other event, or one with neither window. */
export function liveUsage(raw: unknown, at: number): CliMayteLiveUsage | null {
  const ev = raw as any
  if (ev?.type !== 'rate_limit_event' || ev.parent_tool_use_id) return null
  const windows = ev.rate_limit_info?.unifiedWindows
  if (!windows || typeof windows !== 'object') return null
  const read = (w: any): { pct: number | null; resetsAt: number | null } => {
    const u = w?.utilization
    const secs = Number(w?.resetsAt)
    return {
      pct: typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 1000) / 10 : null,
      resetsAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
    }
  }
  const session = read(windows.five_hour)
  const week = read(windows.seven_day)
  if (session.pct === null && week.pct === null) return null
  return {
    sessionPct: session.pct,
    sessionResetsAt: session.pct === null ? null : session.resetsAt,
    weekPct: week.pct,
    weekResetsAt: week.pct === null ? null : week.resetsAt,
    overageAllowed: ev.rate_limit_info?.overageStatus === 'allowed',
    at,
  }
}

/** The line an account that can bill (paid extra usage switched on) is stopped at: 98% of its
 *  5-hour window or 99% of its week. CliMayte's workers and the extra-usage guard (extra-usage.ts)
 *  both use it, so every kind of session stops at the same place. */
export const BILL_GUARD_SESSION_PCT = 98
export const BILL_GUARD_WEEK_PCT = 99

/** A turn on an account that can bill (paid extra usage switched on) is stopped at 98% of its
 *  5-hour window or 99% of its week, BEFORE a request can run into overage: waiting for the
 *  'rejected' event would already have billed that request. Measured 2026-09-30: of the four CLI
 *  accounts only #90 reports `overageStatus: "allowed"`; the others stop at their limit and cannot
 *  bill. Null when the reading says nothing needs stopping. */
export function aboutToBill(live: CliMayteLiveUsage | null): { resetsAt: number | null } | null {
  if (!live?.overageAllowed) return null
  if (live.sessionPct !== null && live.sessionPct >= BILL_GUARD_SESSION_PCT)
    return { resetsAt: live.sessionResetsAt }
  if (live.weekPct !== null && live.weekPct >= BILL_GUARD_WEEK_PCT)
    return { resetsAt: live.weekResetsAt }
  return null
}

/** The percentage to route on: a worker's live reading when it is newer than the snapshot (taken
 *  at `snapshotAt`, epoch ms), else the snapshot. Either one counts only while its window is open
 *  (livePct's rule), so a live reading whose window has reset gives null. */
export function freshestPct(
  snapshot: { pct: number; resetsAt?: string | null } | null | undefined,
  snapshotAt: number,
  live: { pct: number; resetsAt: number | null; at: number } | null,
  now: number,
): number | null {
  if (live && live.at > snapshotAt)
    return live.resetsAt !== null && live.resetsAt <= now ? null : live.pct
  return livePct(snapshot, now)
}

/** The worker minus the long prompt and the log paths, plus what a reader wants at a glance. */
export type CliMayteWorkerView = Omit<CliMayteWorker, 'prompt' | 'attempts' | 'verdicts'> & {
  prompt: string // first 300 chars
  /** Its verdicts, with what each judged stretch of work cost as a share of a Pro 5-hour window. */
  verdicts?: Array<Omit<CliMayteVerdict, 'units'> & { pct: number | null }>
  account: string | null // `#<num> <name>`
  ranS: number // seconds its CLI sessions actually ran, summed over every attempt
  /** The model the CLI reported at init on its newest attempt that got that far (`model` and
   *  `effort` are what was asked for). */
  reportedModel: string | null
  attempts: Array<{
    account: CliMayteAccountRef
    outcome: AttemptOutcome
    notice: string | null
    requested?: { model: string | null; effort: string | null }
    model?: string
    /** Stopped at CliMayte's ceiling (not the account's limit). */
    ceiling?: boolean
    tokens?: CliMayteTokens
    /** Its cost at API prices and its model requests; null when not measured. */
    costUsd: number | null
    turns: number | null
    /** What it used, and of that its re-read (restart overhead), in % of a Pro 5-hour window. */
    pct: number | null
    rereadPct: number | null
    /** Why this attempt started when the one before it ended done (attemptCause). */
    because?: AttemptCause
    /** What its session left running, ended with it (CliMayteAttempt.left). */
    left?: string[]
    /** The most processes its worker had alive at once (CliMayteAttempt.peakProcesses). */
    peakProcesses?: number
  }>
  /** What the task used over every attempt, in % of a Pro 5-hour window: `rereadPct` re-reading its
   *  conversation into a cold cache after a move, a limit, a handoff or a gap, `workPct` the rest. */
  used: { pct: number; workPct: number; rereadPct: number }
  /** Finished, and a verdict (a check's, the orchestrator's or the owner's) covers its newest work:
   *  nothing ran since. A follow-up or a sent-back fail makes it unjudged again. The waiter's
   *  `--unjudged` wakes an orchestrator only for finished work that is not. */
  judged: boolean
}

/** One row of the report view (`GET /api/corch/workers?report=1`, `climayte_status { report }`): what
 *  an orchestrator needs to judge a worker in one read, and nothing it wrote itself. Run 2
 *  (2026-10-01): each finished worker cost the orchestrator its own read, its own verdict call and
 *  a line in a hand-kept list, 8 requests a wake at 437k tokens of context each. */
export interface CliMayteWorkerReport {
  id: string
  group: string
  title: string
  status: CliMayteWorker['status']
  account: string | null
  kind: CliMayteWorker['kind']
  model: string | null
  effort: string | null
  lastActivity: string | null
  waitUntil?: string | null
  error: string | null
  /** The question it waits on (its text, cut), answered with climayte_send. Absent: none. */
  question?: string
  /** Its own estimate for the current message in minutes, and while it runs, the minutes left by
   *  that estimate (negative: over it). Absent: it gave none. */
  etaMin?: number
  etaLeftMin?: number
  /** Once the message finished: the minutes it really worked. */
  tookMin?: number
  judged: boolean
  /** Its newest verdict and who gave it; null when it has none. */
  verdict: 'pass' | 'fail' | null
  by: CliMayteVerdict['by'] | null
  /** % of a Pro 5-hour window over every attempt, and of that the restart re-reading. */
  usedPct: number
  rereadPct: number
  /** How many runs it took, and how each ended (`handoff, done`). */
  attempts: number
  outcomes: string
  /** What its newest session left running and was ended with it (a background deploy, a server):
   *  whatever its report says it was waiting on did not finish. Absent: nothing. */
  leftRunning?: string
  /** The report to judge: the recap of its first turn when it wrote one (from "## What I did"), else
   *  that turn from the top, cut to the asked length. `reportCut` counts the characters of every
   *  turn not shown; the whole text is `climayte_status { id }`. */
  report: string
  reportCut: number
}

/** How much of a report the report view shows by default. Run 2's median report was 2,337
 *  characters; the recap most of them end with is under 700. */
export const REPORT_CHARS = 1500

export function toReport(
  v: CliMayteWorkerView,
  chars = REPORT_CHARS,
  now = Date.now(),
): CliMayteWorkerReport {
  const turns = v.results?.length ? v.results : v.result ? [v.result] : []
  const main = turns[0] ?? ''
  const recap = main.lastIndexOf('## What I did')
  const report = (recap >= 0 ? main.slice(recap) : main).slice(0, Math.max(0, chars))
  const last = v.verdicts?.at(-1)
  const eta = v.eta
  const etaFields = !eta
    ? {}
    : eta.tookS !== undefined
      ? { etaMin: eta.minutes, tookMin: Math.round(eta.tookS / 6) / 10 }
      : {
          etaMin: eta.minutes,
          ...(isLive(v)
            ? { etaLeftMin: Math.round((eta.at + eta.minutes * 60_000 - now) / 60_000) }
            : {}),
        }
  return {
    id: v.id,
    group: v.group,
    title: v.title,
    status: v.status,
    account: v.account,
    kind: v.kind,
    model: v.model ?? null,
    effort: v.effort ?? null,
    lastActivity: v.lastActivity ? v.lastActivity.slice(0, 120) : null,
    ...(v.waitUntil !== undefined ? { waitUntil: v.waitUntil } : {}),
    error: v.error,
    ...(v.question ? { question: v.question.text.slice(0, 400) } : {}),
    ...etaFields,
    judged: v.judged,
    verdict: last?.verdict ?? null,
    by: last?.by ?? null,
    usedPct: v.used.pct,
    rereadPct: v.used.rereadPct,
    attempts: v.attempts.length,
    outcomes: v.attempts.map((a) => a.outcome).join(', '),
    ...(v.attempts.at(-1)?.left?.length
      ? { leftRunning: v.attempts.at(-1)?.left?.join('; ') }
      : {}),
    report,
    reportCut: turns.reduce((n, t) => n + t.length, 0) - report.length,
  }
}

/** The models a worker may run (owner, 2026-09-30: Opus 5.5 or Sonnet 5.5; 2026-10-07: Haiku 5.5,
 *  tried first), by the names the CLI accepts for them (`claude --help`: an alias or the full name).
 *  CliMayte passes the full id, so a later alias move cannot change what a recorded task asked for. */
export const CLIMAYTE_MODELS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  'opus-5.5': 'claude-opus-5-5',
  'opus-5-5': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  'sonnet-5.5': 'claude-sonnet-5-5',
  'sonnet-5-5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  'haiku-5.5': 'claude-haiku-5-5',
  'haiku-5-5': 'claude-haiku-5-5',
  'claude-haiku-5-5': 'claude-haiku-5-5',
}
/** Haiku 4.5 by any of its names, dated ids included: refused, never mapped to 5.5, so a sender
 *  learns the name it used no longer runs. */
const HAIKU_45 = /^(?:claude-)?haiku-4[.-]5(?:-\d{8})?$/
export const HAIKU_45_REFUSED =
  'Haiku 4.5 is retired here (owner, 2026-10-07): use haiku (Haiku 5.5)'
/** `claude --effort <level>` (2.1.284): how hard the model thinks on every turn. */
export const CLIMAYTE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const blank = (v: unknown): boolean => v === undefined || v === null || v === ''

/** The full model id for `v`, null when none was asked for. Throws on anything else, naming the
 *  valid values: junk must never reach the CLI. */
export function climayteModel(v: unknown): string | null {
  if (blank(v)) return null
  const name = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (HAIKU_45.test(name)) throw new Error(HAIKU_45_REFUSED)
  const id = CLIMAYTE_MODELS[name]
  if (!id)
    throw new Error(
      `unknown model '${String(v)}': use auto, haiku, sonnet or opus (or claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5)`,
    )
  return id
}

/** The effort level for `v`, null when none was asked for. Throws on anything else. */
export function climayteEffort(v: unknown): string | null {
  if (blank(v)) return null
  const level = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!(CLIMAYTE_EFFORTS as readonly string[]).includes(level))
    throw new Error(`unknown effort '${String(v)}': use ${CLIMAYTE_EFFORTS.join(', ')}`)
  return level
}

export const WORKER_BRIEF =
  "You are a CliMayte worker: a Claude Code CLI session AgentHydra started on one of the owner's accounts, at the owner's request, to do one task for an orchestrating chat. Do all of it yourself, in this session. " +
  ETA_INSTRUCTION +
  " Nobody watches live: make the reasonable call and say which you made. Your session ends with your turn, and nothing wakes it for a background job: never end your turn to wait for a build, test or run; wait inside the turn, looping on its output with a time limit, and end the turn only with your final report or after climayte_ask. Only when blocked on a real decision the task does not settle, where a wrong guess would cost real work, call climayte_ask (question, options, context) and end your turn: whoever started you answers by message, and this session resumes with the answer. Never ask what you can find out or decide yourself. Follow the repository's rules: commit only the files you changed, and push if they say to. Never read or print a secret value. Your context is small: never Read more than 120 lines at once; grep -n first, then Read with offset and limit, and pipe command output through tail -40. Do not deploy, publish or release unless the task says to: the orchestrator ships finished work. If a repository hook asks about deploying, answer in one line that the orchestrator deploys, and do not explain how. End with a short report: what you did, the proof you saw (a command and what it printed), and anything left undone with the reason."

export const HANDOFF_PROMPT =
  'This session was moved to another account because the previous one reached its usage limit or was signed out. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const PAUSED_PROMPT =
  'This session was paused because its account reached its usage limit or was signed out, and it can continue now on the same account. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const INTERRUPTED_PROMPT =
  'This session was interrupted before it finished: its process was stopped (AgentHydra restarted), not by anything you did. Continue the task exactly where you left off. Do not redo steps that are already finished; run a command again only if its result is missing.'

export const TRANSIENT_PROMPT =
  'The API was overloaded and this turn stopped part-way. Continue the task exactly where you left off. Do not redo steps that are already finished.'

/** A planned handoff starts when a worker's own stream says its account is this far into a window.
 *  Early enough for the session to finish the step it is on and write a handoff before the wall;
 *  a Pro 5-hour window lasts about ten minutes of heavy work, so 15% is roughly a minute and a half. */
export const WIND_DOWN_SESSION_PCT = 85
/** 85 like the 5-hour line (owner, 2026-10-01: "85 with a max of 90 ... on both the five-hour and
 *  the total usage"); it was 95. */
export const WIND_DOWN_WEEK_PCT = 85

/** The hard ceiling on both windows (owner, 2026-10-01, the same words). The stop line at 85 asks a
 *  session to hand off; one still working at 90 is stopped there, whatever it is doing, and its
 *  account walled until that window resets (climayte.ts stopAtCeiling). */
export const CEILING_PCT = 90

/** How close to its weekly reset an account may work past WIND_DOWN_WEEK_PCT. */
export const WEEK_END_MS = 5 * 3_600_000

/** The weekly stop line in a week's last WEEK_END_MS: one point under the ceiling, so a session
 *  still has about a minute and a half of heavy Pro work to write its handoff (a Pro 5-hour window
 *  is about 7.7 weekly points). At 85 there, up to 5 points of the week expired unused at a reset
 *  that was already due (owner, 2026-10-02: "Up to 90% near reset"). */
export const WEEK_END_STOP_PCT = CEILING_PCT - 1

/** The weekly stop line for an account whose week resets at `weekResetsAt`, as of `now`. */
export function weekStopPct(weekResetsAt: number | null | undefined, now: number): number {
  return weekResetsAt != null && weekResetsAt > now && weekResetsAt - now <= WEEK_END_MS
    ? WEEK_END_STOP_PCT
    : WIND_DOWN_WEEK_PCT
}

/** How far above an owner's cap a session still working is stopped: the fleet's own gap, 85 to 90. */
const CAP_CEILING_GAP = CEILING_PCT - WIND_DOWN_SESSION_PCT

/** One account's 5-hour stop line: the owner's cap for it (AccountPlacement), never above the fleet's. */
export function sessionStopPct(caps: AccountCaps | null | undefined): number {
  return Math.min(WIND_DOWN_SESSION_PCT, caps?.maxSessionPct ?? WIND_DOWN_SESSION_PCT)
}

/** One account's weekly stop line: the owner's cap for it, else the fleet's (weekStopPct, 89 near a
 *  reset). A cap is the owner's own number, so it does not move near the reset. */
export function accountWeekStopPct(
  caps: AccountCaps | null | undefined,
  weekResetsAt: number | null | undefined,
  now: number,
): number {
  const fleet = weekStopPct(weekResetsAt, now)
  return caps?.maxWeekPct != null ? Math.min(caps.maxWeekPct, fleet) : fleet
}

/** The ceiling over one window with an owner's cap `cap` on it: CAP_CEILING_GAP above the cap, never
 *  above CEILING_PCT; CEILING_PCT with none. */
function ceilingPct(cap: number | null | undefined): number {
  return cap == null ? CEILING_PCT : Math.min(CEILING_PCT, cap + CAP_CEILING_GAP)
}

/** The reading a running session is judged by: its own stream's, or the account's newest from any
 *  of its workers when that is newer and its 5-hour window has not reset. A session's own stream
 *  says nothing while it sits in a long tool call. 2026-10-01 on #102: three workers saw 85% at
 *  08:28 and handed off; the fourth's own stream went from 76% to 87% across one tool call six
 *  minutes later, was asked then, and reached the 90% ceiling writing its handoff. */
export function sessionReading(
  own: CliMayteLiveUsage | null,
  account: CliMayteLiveUsage | null,
  now: number,
): CliMayteLiveUsage | null {
  if (!account || (own && own.at >= account.at)) return own
  if (account.sessionResetsAt !== null && account.sessionResetsAt <= now) return own
  return account
}

/** Where a reading has reached CEILING_PCT, if it has: the 5-hour window first. `account` and
 *  `now`: the account's newest reading from any worker (sessionReading). `caps`: the owner's caps on
 *  the account, which lower its ceiling (ceilingPct); `line` says where one did. */
export function atCeiling(
  own: CliMayteLiveUsage | null,
  account: CliMayteLiveUsage | null = null,
  now = Date.now(),
  caps: AccountCaps | null = null,
): { pct: number; week: boolean; resetsAt: number | null; line?: number } | null {
  const live = sessionReading(own, account, now)
  const at = (line: number) => (line < CEILING_PCT ? { line } : {})
  const session = ceilingPct(caps?.maxSessionPct)
  if (live?.sessionPct != null && live.sessionPct >= session)
    return { pct: live.sessionPct, week: false, resetsAt: live.sessionResetsAt, ...at(session) }
  const week = ceilingPct(caps?.maxWeekPct)
  if (live?.weekPct != null && live.weekPct >= week)
    return { pct: live.weekPct, week: true, resetsAt: live.weekResetsAt, ...at(week) }
  return null
}

/** Whether a ceiling stop came at the run's first reading, already past CEILING_PCT in the window
 *  that stopped it (`first`: the first reading its stream carried). Then the account was full when
 *  the run arrived and the reading it was placed on was stale or missing; the stop line did not come
 *  too late. 2026-10-02: #120 had no reading and its first request was refused at 129%; #118 was
 *  placed at 82%, a reading half an hour old, and read 95%; #119 at 79% read 100%. All three were
 *  counted as ceiling stops and as CliMayte's peaks. */
export function pastOnArrival(
  first: CliMayteLiveUsage | null,
  c: { week: boolean; line?: number },
): boolean {
  const pct = c.week ? first?.weekPct : first?.sessionPct
  return pct != null && pct >= (c.line ?? CEILING_PCT)
}

/** What a turn stopped at the ceiling says (its attempt's notice, the account's wall). */
export const ceilingNotice = (c: {
  pct: number
  week: boolean
  onArrival?: boolean
  line?: number
}): string => {
  const window = `${Math.round(c.pct)}% of its ${c.week ? 'weekly' : '5-hour'} usage`
  const ceiling =
    c.line == null
      ? `CliMayte's ceiling of ${CEILING_PCT}%`
      : `the ceiling of ${c.line}% its owner's cap sets`
  if (c.onArrival)
    return `Found at ${window} on its first request, past ${ceiling}: the reading it was placed on was old or missing. The account rests until that window resets.`
  return `Stopped at ${window}, ${ceiling}${c.pct < 100 ? ', well short of the limit' : ''}. The account rests until that window resets.`
}

/** A usage reading older than this may be far behind the account: it can be in use outside
 *  CliMayte (a person's chats, the orchestrating chats), and the background usage check runs only
 *  every 30 minutes. 2026-10-02: #118 read 82% at 07:59 and 95% at 08:29, #119 78% at 08:40 and
 *  100% at 09:04, with no CliMayte run on either in between. */
export const READING_STALE_MS = 10 * 60_000

/** The account's reading is older than READING_STALE_MS (readAt). */
export const readingStale = (a: Pick<CliMayteAccount, 'readAt'>, now: number): boolean =>
  a.readAt != null && now - a.readAt > READING_STALE_MS

/** No task starts on this account until its usage is read again (climayte-schedule startOn): the
 *  read is running, or its reading is missing (`readAt` null) or older than READING_STALE_MS and no
 *  re-read was tried in that time. One that was tried and failed lets a worker go on the old
 *  reading (takesNewWork: one at a time), so a login whose check keeps failing still gets work.
 *  2026-10-03: #116 read 69% about 21 minutes earlier and #152 24% 70 minutes earlier; each took a
 *  task in the second it became due, before any re-read began, and was found at 110% and 101%. A
 *  follow-up went home to #147 on an 89% about 14 minutes old and hit the limit 3 s later. */
export function readingPending(
  a: Pick<CliMayteAccount, 'readAt' | 'refreshing' | 'readTriedAt'>,
  now: number,
): boolean {
  if (a.refreshing) return true
  if (a.readAt === undefined) return false
  const due = a.readAt === null || now - a.readAt > READING_STALE_MS
  return due && !(a.readTriedAt != null && now - a.readTriedAt < READING_STALE_MS)
}

/** The conversation size at which a session is asked to hand off to a fresh one: every request
 *  re-reads the whole conversation. Measured over all logs, 2026-10-02: 3,135 of 8,370 requests ran
 *  with more than 150k of context and carried 61% of all cache-read tokens (the largest: 442k). The
 *  saving is small and not proven: since 2026-10-01 15:00Z, 27.6% of a Pro window when the fresh
 *  session (40.6k to start, the median of only 2) re-reads nothing, about 7% when it re-reads 30k,
 *  and close to break-even over all logs. Measured on the first 91 such handoffs (2026-10-02,
 *  06:24-17:00Z, 40 tasks): 15 tasks handed off on size twice or more (8 five or more); their 47
 *  fresh continuations started at 26-45k, and 37% of what each read with Read, Grep or Glob the
 *  session before had read too, the rest of their growth was new test and log output. Code tasks
 *  in such chains failed their verdict 4 of 12, against 53 of 183 code verdicts that day, so the
 *  line stays; a task that does not converge is stopped by notConverging (w-6ba9a4ea, a CI debug:
 *  8 handoffs, 82% of a Pro window).
 *  Raised from 150k to 200k on 2026-10-06 from the analytics meter over 3 days (1,070 tasks, 621
 *  measured handoffs): a handoff at 150k cost more than it saved. The old session's calls after
 *  the ask plus the fresh session's cold first request (47k median) came to 0.51B units, and the
 *  smaller conversation saved 0.43B of reads; 258 of 621 paid back, the break-even being about 40
 *  calls of the fresh session against a median of 38. Replaying every task's conversation under
 *  other lines, 200k was cheapest or within 0.03B of it whatever the fresh session re-reads (0k:
 *  -0.016B, 13k: -0.086B, 26k: -0.191B against 150k; 7 days: -0.109B), with 40% fewer handoffs;
 *  past 250k the reads cost more again. */
export const CONTEXT_HANDOFF_TOKENS = 200_000

/** The conversation's size in tokens: what the newest main-agent request in `events` read (input,
 *  cache reads and cache writes). Null when they hold no such request. */
export function contextTokens(events: unknown[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as any
    const u =
      ev?.type === 'assistant' && !ev.parent_tool_use_id ? readTurnUsage(ev.message?.usage) : null
    if (u) return contextOf(u)
  }
  return null
}

/** Why a session is asked to hand off: a usage window at its stop line (`week`: which one), its
 *  conversation's size, or the orchestrator's request. */
export type WindDownWhy =
  | { reason: 'usage'; pct: number; week: boolean }
  | { reason: 'context'; tokens: number }
  | { reason: 'request' }

/** What calls for a wind-down now, or null: a usage window at its stop line first, then the
 *  conversation's size (`ctx`: contextTokens). `account`, `now` and `caps` as for atCeiling: an
 *  owner's cap is the account's stop line (sessionStopPct, accountWeekStopPct). */
export function windDownAt(
  own: CliMayteLiveUsage | null,
  account: CliMayteLiveUsage | null = null,
  now = Date.now(),
  ctx: number | null = null,
  caps: AccountCaps | null = null,
): WindDownWhy | null {
  const live = sessionReading(own, account, now)
  if (live?.sessionPct != null && live.sessionPct >= sessionStopPct(caps))
    return { reason: 'usage', pct: live.sessionPct, week: false }
  if (live?.weekPct != null && live.weekPct >= accountWeekStopPct(caps, live.weekResetsAt, now))
    return { reason: 'usage', pct: live.weekPct, week: true }
  if (ctx !== null && ctx >= CONTEXT_HANDOFF_TOKENS) return { reason: 'context', tokens: ctx }
  return null
}

/** The first words of windDownMessage: why this session hands off. */
function windDownCause(why: WindDownWhy): string {
  if (why.reason === 'request')
    return 'the orchestrator asked this session to hand the task to a fresh session'
  if (why.reason === 'context')
    return `this session's conversation has grown to about ${Math.round(why.tokens / 1000)}k tokens and every further request reads all of it again, so the rest of the task goes to a fresh session that starts small from a handoff`
  return `this account is at ${Math.round(why.pct)}% of its ${why.week ? 'weekly' : '5-hour'} usage, past the line where CliMayte stops work so it never reaches the limit, so this session must hand the task to a fresh session (on another account with room, or on this one once that window resets)`
}

/** What a winding-down worker is told after its next tool call (a PostToolUse hook shows it). The
 *  session that has the whole context writes the handoff, while its own cache is warm; the next
 *  account then starts a small fresh session from it instead of re-reading the whole conversation
 *  (a move re-reads it all uncached: 219k tokens cost $1.77 on one live move, 2026-09-30). */
export function windDownMessage(why: WindDownWhy, path: string): string {
  // The handoff comes FIRST: the hard stop at 90% is a few points away, about 30 seconds of heavy
  // work, and a session stopped before its note is written moves by re-reading everything cold
  // (stress review, 2026-10-02). A task two or three calls from done finishes instead.
  return `AgentHydra: ${windDownCause(why)}. If you can finish the whole task in two or three more tool calls, do that and give your final report instead of a handoff. Otherwise write the handoff NOW, before anything else, with the Write tool to ${path}, for the session that continues this task; then finish or safely stop the step you are on, start nothing new, and update the handoff if that changed anything. The next session sees only the original task, your handoff and your transcript, so include, in under 800 words: the goal as you understand it; what is done (files changed, commits, results, with paths); what is in progress and its exact state (if you were about to commit, land or push: the exact commit message, subject and body verbatim, and the exact paths); the next steps in order; the facts, decisions and gotchas you learned, carrying forward everything still true from any handoff you started from; and the commands or checks that prove the work, with their results. After writing the handoff, end your turn with one line saying the handoff is written.`
}

/** The first prompt of the session that continues a task from a handoff. `transcripts`: the earlier
 *  sessions', newest first. `from`: whether that session ran on the account this one starts on, and
 *  why it handed off (2 of 36 continuations on record ran on the same account and were told
 *  "another account"). */
export function continuationPrompt(
  task: string,
  handoff: string,
  handoffPath: string,
  transcripts: string[],
  messages: string[],
  from: { sameAccount: boolean; why: WindDownWhy['reason']; chat?: boolean },
): string {
  const more = messages.length
    ? `\n\nThe orchestrator also sent these messages, which the earlier session did not get to:\n${messages.map((m) => `- ${m}`).join('\n')}`
    : ''
  const [newest, ...older] = transcripts
  const before = older.length ? ` (the sessions before it, newest first: ${older.join(', ')})` : ''
  const where = newest
    ? ` Its full transcript is at ${newest}${before} if you need a detail the handoff left out (read it with the Read or Grep tools; it is JSON lines).`
    : ''
  const account = from.sameAccount ? 'on this account' : 'on another account'
  const ended =
    from.why === 'context'
      ? 'handed off because its conversation had grown large'
      : from.why === 'request'
        ? 'handed off when the orchestrator asked it to'
        : 'wound down before its usage limit'
  // A chat's heir is told who it is right after the note Hydra Desk reads (continuationOf), which
  // stays as it is.
  const main = from.chat
    ? " That session was this chat's main agent before you: you continue as the main agent of the owner's Desk chat, he reads every reply you write, and you orchestrate the work and report to him."
    : ''
  return `${task}\n\n---\nAn earlier session already worked on this task ${account} and ${ended}. Continue from its handoff below (also saved at ${handoffPath}).${main}${where} Do not redo steps it reports finished. Check its claims with cheap commands (git status, git log -3, reading a file); do not re-run a test suite or build it reports passing unless you change what it covers. If it gives a commit message for work in progress, commit with that message verbatim.${more}\n\n--- HANDOFF ---\n${handoff}`
}

export const PRE_OVERAGE_NOTICE =
  'The account reached 98% of its limit and has paid extra usage switched on, so CliMayte stopped the turn before it could bill and moved the session to an account with free quota.'

export const OVERAGE_NOTICE =
  "The account's 5-hour limit ran out and it started spending paid extra usage, so CliMayte stopped the turn and moved the session to an account with free quota."

/** The CLI's own sign that an account ran out and PAID EXTRA USAGE took over: a main-agent
 *  `rate_limit_event` with status 'rejected' whose overage is in use. Measured live on #90,
 *  2026-09-30: `{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790803800,
 *  "overageStatus":"allowed","isUsingOverage":true,"overageInUse":true,…}`, and the turn went on,
 *  on credits: a Pro account with extra usage switched on never hits the wall, it bills. That test
 *  ran $3.82 of a $4.67 turn on overage before anything noticed. Null for any other event. */
export function overageStart(raw: unknown): { resetsAt: number | null } | null {
  const ev = raw as any
  if (ev?.type !== 'rate_limit_event' || ev.parent_tool_use_id) return null
  const info = ev.rate_limit_info
  if (info?.status !== 'rejected' || !(info.isUsingOverage === true || info.overageInUse === true))
    return null
  const secs = Number(info.resetsAt)
  return { resetsAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null }
}

export const INTERRUPTED_NOTICE =
  'Interrupted: the CLI process ended with no result and no error (AgentHydra restarted or the process was killed). Resumed automatically.'

/** Env keys a worker must never inherit: it bills its OWN login, never a borrowed key or token. */
export const ENV_SCRUB =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_\w+|ENTRYPOINT|SSE_PORT|SESSION\w*)|CLAUDECODE|CLAUDE_CONFIG_DIR)$/

// "disabled claude subscription access": the account's organization turned off subscription access
// for Claude Code (`error:"oauth_org_not_allowed"`). It is the account's problem, not the task's,
// so the task moves on and the account is walled like a signed-out one. "identity verification is
// required": the same for an account Anthropic asks to verify (IDENTITY_WALL).
const AUTH_RE =
  /please run \/login|not logged in|invalid api key|failed to authenticate|oauth (?:token|session) (?:has )?(?:expired|been revoked)|authentication_error|disabled claude subscription access|identity verification is required/i

/** The wall reason for an account whose organization turned Claude Code off. `claude auth status`
 *  still says such a login works, so the 30-minute signed-out recheck lifted its wall every time,
 *  and each lift sent every waiting task at it at once (run 1: #91, 7 failed attempts, 4 in one
 *  second). Only a different login (its credential file changing) lifts this one. */
export const ORG_DISABLED_WALL = 'organization disabled Claude Code'
const ORG_DISABLED_RE = /disabled claude subscription access|oauth_org_not_allowed/i
export const isOrgDisabled = (notice: string | null): boolean =>
  !!notice && ORG_DISABLED_RE.test(notice)
/** The account's identity must be verified again (400 "Identity verification is required to
 *  continue"): an account problem like a disabled organization, lifted only by a new login. */
export const IDENTITY_WALL = 'identity verification required'
const IDENTITY_RE = /identity verification is required/i
export const isIdentityRequired = (notice: string | null): boolean =>
  !!notice && IDENTITY_RE.test(notice)
/** A wall about the login, not the usage: its `until` is a recheck time, never when it frees up. */
export const isLoginWall = (reason: string | undefined): boolean =>
  reason === 'signed out' || reason === ORG_DISABLED_WALL || reason === IDENTITY_WALL
/** The account takes no work now: a usage wall until it ends, a login wall until its recheck lifts
 *  it (climayte.ts recheckSignedOut, on a new credential file only). 2026-10-03
 *  00:53Z: #135's wall lapsed while no tick ran, and a handoff placed before the tick's recheck sent
 *  a worker to the dead login. */
export const isWalledNow = (
  wall: { reason: string; until: number } | undefined,
  now: number,
): boolean => !!wall && (isLoginWall(wall.reason) || wall.until > now)

export function scrubbedEnv(configDir: string, workerId?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  }
  env.CLAUDE_CONFIG_DIR = configDir
  // No self-update from inside a worker (config.ts): an interrupted one broke every launch.
  env.DISABLE_AUTOUPDATER = '1'
  if (workerId) env.AGENTHYDRA_CLIMAYTE_WORKER = workerId
  // The CLI's own small-model calls and Explore agents run on Haiku 5.5, never 4.5 (core/haiku-pin).
  return pinHaikuModel(env)
}

export interface AttemptVerdict {
  outcome: AttemptOutcome
  notice: string | null
  result: string | null
  /** The closing text of every turn this attempt ended, oldest first: the text before each Stop
   *  hook's feedback, then the terminal result's when the attempt finished cleanly. */
  turnTexts: string[]
  turns: number
  /** A quota wall's end from the CLI's own `rate_limit_event` (epoch ms), else null. */
  resetsAt: number | null
  /** Which window that event named, else null. */
  window: 'session' | 'weekly' | null
  /** A quota notice's "resets …" phrase, read from the full text before it was compacted. */
  resets: string | null
}

type RejectedWall = { resetsAt: number | null; window: 'session' | 'weekly' | null }

/** What the main agent's events say, read once in order (classifyAttempt). */
interface AttemptScan {
  tracker: ReturnType<typeof createLimitStopTracker>
  /** CLI-reported API-error events of the main agent. */
  apiErrors: string[]
  /** The terminal `result` event. */
  last: any
  /** The CLI's structured wall ({"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
   *  "rateLimitType":"seven_day","resetsAt":<epoch s>}}), until something shows the turn went on. */
  rejected: RejectedWall | null
  /** A turn's closing text: the assistant text since the last user event. A Stop hook that refuses
   *  the stop answers with a user message, and the session goes on in a new turn (field note 13). */
  turnTexts: string[]
  /** The assistant text of the turn being read. */
  said: string[]
}

function noteTurnText(scan: AttemptScan, ev: any): void {
  if (ev?.type === 'assistant') {
    for (const b of ev.message?.content ?? [])
      if (b?.type === 'text' && typeof b.text === 'string') {
        // The answer to the Stop hook's ETA question is not part of the report (stripReview).
        const text = stripReview(b.text)
        if (text) scan.said.push(text)
      }
  } else if (ev?.type === 'user') {
    if (scan.said.length && isStopHookFeedback(ev)) scan.turnTexts.push(scan.said.join('\n\n'))
    scan.said = []
  }
}

/** The wall a rejected `rate_limit_event` names: when it ends and which window it is. */
function rejectedWall(info: any): RejectedWall {
  const secs = Number(info.resetsAt)
  const type = String(info.rateLimitType ?? '')
  return {
    resetsAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
    window: type.startsWith('seven_day') ? 'weekly' : type === 'five_hour' ? 'session' : null,
  }
}

/** The events that decide how the turn ended: its result, the CLI's wall, an API error, or
 *  output that shows the turn went on after a wall. */
function noteOutcomeEvent(scan: AttemptScan, ev: any): void {
  if (ev?.type === 'result') {
    scan.last = ev
    if (ev.is_error !== true) scan.rejected = null
  } else if (ev?.type === 'rate_limit_event') {
    const info = ev.rate_limit_info
    scan.rejected = info?.status !== 'rejected' ? null : rejectedWall(info)
  } else if (isApiErrorEvent(ev)) scan.apiErrors.push(limitEventText(ev))
  else if (ev?.type === 'assistant') scan.rejected = null // real output after it: the turn went on
}

function scanAttempt(events: unknown[]): AttemptScan {
  const scan: AttemptScan = {
    tracker: createLimitStopTracker(),
    apiErrors: [],
    last: null,
    rejected: null,
    turnTexts: [],
    said: [],
  }
  for (const raw of events) {
    const ev = raw as any
    if (ev?.parent_tool_use_id) continue
    scan.tracker.observe(ev)
    noteTurnText(scan, ev)
    noteOutcomeEvent(scan, ev)
  }
  return scan
}

type VerdictBase = Pick<
  AttemptVerdict,
  'result' | 'turnTexts' | 'turns' | 'resetsAt' | 'window' | 'resets'
>

const verdictOf = (
  base: VerdictBase,
  outcome: AttemptOutcome,
  notice: string | null,
): AttemptVerdict => ({
  ...base,
  outcome,
  notice: notice ? compactNotice(notice) : null,
})

/** A quota verdict: the wall's end and window from the CLI's own event, and the notice's
 *  "resets …" phrase, read before the notice is compacted. */
const quotaVerdict = (
  base: VerdictBase,
  rejected: RejectedWall | null,
  notice: string | null,
): AttemptVerdict => ({
  ...verdictOf(base, 'quota', notice),
  resetsAt: rejected?.resetsAt ?? null,
  window: rejected?.window ?? null,
  resets:
    notice
      ?.replace(/\s+/g, ' ')
      .trim()
      .match(/\bresets\s+(.+?)\s*$/i)?.[1] ?? null,
})

/** The verdict for a turn that did not finish cleanly: a limit first, then a dead login, a
 *  passing error, a kill from outside, and last a plain error. */
function unfinishedVerdict(
  base: VerdictBase,
  scan: AttemptScan,
  stop: ReturnType<AttemptScan['tracker']['verdict']>,
  texts: { errText: string; stderrLines: string[]; trusted: string[] },
  stderr: string,
  started: boolean,
): AttemptVerdict {
  const { rejected, apiErrors, last } = scan
  const { errText, stderrLines, trusted } = texts
  // The errored result carries the same notice uncut; the tracker's copy is already compacted.
  if (stop?.pending)
    return quotaVerdict(base, rejected, classifyLimit(errText) === 'quota' ? errText : stop.notice)
  const quotaText = [errText, ...stderrLines].find((t) => t && classifyLimit(t) === 'quota')
  if (quotaText !== undefined) return quotaVerdict(base, rejected, quotaText)
  if (rejected)
    return quotaVerdict(base, rejected, errText || apiErrors[apiErrors.length - 1] || null)
  const auth = trusted.find((t) => AUTH_RE.test(t))
  if (auth !== undefined) return verdictOf(base, 'auth', auth)
  const transient = trusted.find((t) => classifyLimit(t) === 'transient')
  if (transient !== undefined) return verdictOf(base, 'transient', transient)
  // No result and no API error: the process was killed from outside. On Windows a daemon restart
  // does exactly this to every worker (they sit in the daemon's kill-on-close job), and the
  // transcript on disk is intact, so the session is resumed rather than failed. Stderr need not be
  // empty once the CLI started: a normal run can print a harmless warning there (measured: an MCP
  // OAuth 'issuer' stamp notice). One that wrote to stderr before system/init failed to start (an
  // unknown option, a missing session), and that is an error, not a restart.
  if (!last && !apiErrors.length && (started || !stderr.trim()))
    return verdictOf(base, 'interrupted', INTERRUPTED_NOTICE)
  return verdictOf(base, 'error', null)
}

/** An attempt that died within INSTANT_DEATH_MS with nothing on stdout, nothing on stderr and no
 *  runner pid file: the shape of a CLI that cannot execute at all (a placeholder or truncated
 *  claude.exe, 2026-10-06), not of a daemon restart, which leaves the CLI's own output behind. */
export const INSTANT_DEATH_MS = 10_000
export function isInstantEmptyDeath(a: {
  livedMs: number
  events: unknown[]
  stderr: string
  hadRunnerPid: boolean
}): boolean {
  return (
    a.livedMs < INSTANT_DEATH_MS && a.events.length === 0 && !a.stderr.trim() && !a.hadRunnerPid
  )
}

/** `started`: the CLI logged system/init (the caller may know it when the events list was cut).
 *
 *  A clean terminal `result` is the CLI saying the turn completed, so it is 'done' before anything
 *  else is looked at: a wall word on stderr (an MCP server's token refresh answering 429) or in an
 *  earlier API error the CLI recovered from must not throw a finished task away. Stderr is read
 *  only when there is no terminal result, one line at a time: the notice is the line that says it,
 *  not a 4 KB tail whose first 200 characters are some unrelated warning. A subagent's events
 *  (`parent_tool_use_id` set) are its own business and do not judge the main turn. */
export function classifyAttempt(
  events: unknown[],
  stderr: string,
  started: boolean = events.some(
    (ev) => (ev as any)?.type === 'system' && (ev as any)?.subtype === 'init',
  ),
): AttemptVerdict {
  const scan = scanAttempt(events)
  const { last, rejected, apiErrors, turnTexts } = scan
  const errored = last?.is_error === true
  const rawResult = typeof last?.result === 'string' ? last.result : null
  // A last turn that only answers the Stop hook's ETA question leaves the report before it as the
  // result (stripReview): the earlier turn's text was already kept when the hook's feedback came.
  const stripped = rawResult === null ? null : stripReview(rawResult)
  const reviewOnly = !errored && !!rawResult?.trim() && !stripped
  const resultText = reviewOnly
    ? (turnTexts.at(-1) ?? null)
    : stripped !== null && stripped !== rawResult?.trim()
      ? stripped
      : rawResult
  if (last && !errored && stripped) turnTexts.push(stripped)
  const errText = errored ? (resultText ?? '') : ''
  const stderrLines = last
    ? []
    : stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse() // the last line that says it wins
  const trusted = [...apiErrors, errText, ...stderrLines] // the only places a wall can be read from
  const base: VerdictBase = {
    result: resultText,
    turnTexts,
    turns: Number(last?.num_turns) || 0,
    resetsAt: null,
    window: null,
    resets: null,
  }

  const stop = scan.tracker.verdict()
  // A clean result clears both the tracker's stop and `rejected`, so either one still set here
  // came after the last clean result: the turn did not finish.
  if (last && !errored && !stop?.pending && !rejected) return verdictOf(base, 'done', null)
  return unfinishedVerdict(base, scan, stop, { errText, stderrLines, trusted }, stderr, started)
}

/** The user message a Stop hook sends when it refuses the stop: `Stop hook feedback:\n[...]`. */
function isStopHookFeedback(ev: any): boolean {
  const c = ev?.message?.content
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.find((b: any) => b?.type === 'text')?.text
        : null
  return typeof text === 'string' && /^\s*Stop hook feedback:/.test(text)
}

export const MAX_RESULTS = 12 // turns kept per message; the oldest go first
export const MAX_RESULT_CHARS = 20_000 // per turn; the report's head is kept
export const MAX_REPORTS = 10 // earlier messages' reports kept per task; the oldest go first

/** `reports` with the current message's turns added, when it has any (a delivered follow-up is
 *  about to start a new `results`). */
export function keepReport(
  w: Pick<CliMayteWorker, 'reports' | 'results' | 'message' | 'prompt'>,
  at: number,
): CliMayteWorker['reports'] {
  if (!w.results?.length) return w.reports
  const message = w.message ?? w.prompt.split(/\r?\n/)[0]!.trim().slice(0, 200)
  return [...(w.reports ?? []), { at, message, results: w.results }].slice(-MAX_REPORTS)
}
/** The recap header a worker's report ends with (the climayte skill's three headers). */
export const RECAP_HEADER = '## What I did'

/** The turns a reader of the status sees: the current message's turns, and, when none of them holds
 *  the recap but an earlier message's report does (a follow-up like "repeat your report" or a short
 *  steer started a new `results`), the newest such earlier turn first, so the work's proof is not
 *  replaced by the follow-up's reply. Unchanged when the current turns carry the recap, or no
 *  earlier report does. */
export function statusTurns(w: Pick<CliMayteWorker, 'result' | 'results' | 'reports'>): string[] {
  const now = w.results?.length ? w.results : w.result ? [w.result] : []
  if (now.some((t) => t.includes(RECAP_HEADER))) return now
  for (const r of [...(w.reports ?? [])].reverse()) {
    const turn = [...r.results].reverse().find((t) => t.includes(RECAP_HEADER))
    if (turn)
      return [
        `[Earlier report, for: ${r.message}]
${turn}`,
        ...now,
      ]
  }
  return now
}

export const RESULT_SEPARATOR = '\n\n---\n\n'

/** `results` with `texts` appended, capped. A text equal to the last one is not repeated. */
export function addResults(results: string[] | undefined, texts: string[]): string[] {
  const out = [...(results ?? [])]
  for (const t of texts) {
    const text = t.length > MAX_RESULT_CHARS ? `${t.slice(0, MAX_RESULT_CHARS)}…` : t
    if (out[out.length - 1] !== text) out.push(text)
  }
  return out.slice(-MAX_RESULTS)
}

/** The full report: every turn's text, oldest first, newest last. */
export const joinResults = (results: string[]): string | null =>
  results.length ? results.join(RESULT_SEPARATOR) : null

/** A wall ends this long after its reset, not on it: the relaunch must not reach Anthropic before
 *  its window has flipped. */
export const WALL_MARGIN_MS = 60_000
/** The wall for a reset that has just passed: the window flipped a moment after the notice. */
export const WALL_RETRY_MS = 2 * 60_000
/** The wall when nothing says when the limit resets. */
export const WALL_FALLBACK_MS = 60 * 60_000

/** When a quota wall ends (epoch ms). The CLI's own `resetsAt` wins; the notice's "resets …"
 *  text is parsed only without it, against a clock 10 minutes earlier, because a relaunch that
 *  reaches Anthropic a moment before its window flips is told "resets 4:30pm" at 4:30:04pm, and
 *  read against the current clock that is tomorrow: a whole day's wall for a few seconds' skew. A
 *  reset that has just passed gets a short retry wall instead. `fallback` (for a weekly notice,
 *  the account's own weekly reset) is used only when nothing parses. `parse` is usage.ts's
 *  parseResetTime, passed in so this file stays pure. */
export function wallUntil(
  now: number,
  reset: { resetsAt: number | null; resets: string | null },
  parse: (resets: string, now: Date) => string | null,
  fallback: number | null = null,
): number {
  let at = reset.resetsAt ?? Number.NaN
  if (!Number.isFinite(at) && reset.resets) {
    const iso = parse(reset.resets, new Date(now - 10 * 60_000))
    at = iso ? Date.parse(iso) : Number.NaN
  }
  if (!Number.isFinite(at) && fallback !== null && fallback > now) at = fallback
  if (!Number.isFinite(at)) return now + WALL_FALLBACK_MS
  return at > now ? at + WALL_MARGIN_MS : now + WALL_RETRY_MS
}

/** What one attempt spent: the analytics kit's figures (tokens, calls, cost_usd) for the attempt's
 *  session on the instance it ran on between its start and its end. The kit prices every call, so
 *  CliMayte prices nothing itself. The CLI's `result.total_cost_usd` cannot be: on a resumed session it is
 *  the WHOLE session's cost so far (measured 2026-09-30: a one-turn follow-up after a $4.67 turn
 *  reported $6.44 = $4.67 + $1.77), so adding it per attempt counted every earlier turn again on
 *  every follow-up, handoff and resume. A killed or stopped attempt writes no result at all, and
 *  its stream-json log under-reports output; the transcript, which the kit ingests, has both right
 *  (this reproduces the CLI's own figures to the cent). Turns copied in from another account keep their older
 *  timestamps, so they are not counted again. 0 when the transcript is not there. A subagent's
 *  requests bill the same account and sit in their own files under `<session>/subagents/`, so
 *  those are counted too. */
export function attemptSpend(
  configDir: string,
  instance: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
  store?: KitStore,
): AttemptSpend {
  const root = join(configDir, 'projects')
  let files: string[] = []
  const none: AttemptSpend = {
    costUsd: 0,
    tokens: noTokens(),
    turns: 0,
    first: null,
    found: false,
    settled: true,
  }
  try {
    for (const d of readdirSync(root)) {
      const file = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(file)) {
        files = [file, ...jsonlUnder(join(root, d, sessionId, 'subagents'), 3)]
        break
      }
    }
  } catch {
    return none
  }
  if (!files.length) return none
  // One query on the session (a subagent's calls carry its parent's session) and the instance it ran
  // on, over the attempt's window, both ends in. Turns copied in from another account keep their
  // older timestamps and a copy of the session in another dir does not own the call, so neither counts.
  const t = usageQuery(
    {
      window: { from: startedAt, to: endedAt },
      filter: { session: sessionId, instance },
      measures: ['input', 'output', 'cache_read', 'cache_write', 'calls', 'cost_usd'],
    },
    { store, coverage: false },
  ).totals
  const tokens: CliMayteTokens = {
    input: t.input ?? 0,
    output: t.output ?? 0,
    cacheRead: t.cache_read ?? 0,
    cacheWrite: t.cache_write ?? 0,
  }
  // The kit has no per-call read, so the first request is the one thing still read from the file.
  let first: CliMayteTokens | null = null
  try {
    first = firstRequest(readFileSync(files[0] as string, 'utf8'), startedAt, endedAt)
  } catch {
    // unreadable: no first request
  }
  return {
    costUsd: t.cost_usd ?? 0,
    tokens,
    turns: t.calls ?? 0,
    first,
    found: true,
    settled: kitHolds(store ?? sharedKitStore(), files, endedAt),
  }
}

/** Whether the kit has read all of an attempt's transcript files. It reads them on a 60 s sweep, so
 *  one that just ended can be a minute short. Each file's ingest cursor says how far the sweep got:
 *  it holds the file when it reached the file's size now, or when it was taken at or after `endedAt`
 *  (a session that went on in a later attempt has grown since, but every line up to `endedAt` was
 *  already there). No cursor, or a cursor that stopped short, means not yet. */
function kitHolds(store: KitStore, files: string[], endedAt: number): boolean {
  try {
    return files.every((file) => {
      const cur = store.getCursor(file)
      return cur !== null && (cur.size >= statSync(file).size || cur.mtime >= endedAt)
    })
  } catch {
    return false
  }
}

/** What attemptSpend read: the kit's figures for an attempt's session, and its first request. */
export interface AttemptSpend {
  costUsd: number
  tokens: CliMayteTokens
  /** Model requests in the attempt, its sub-agents' included. */
  turns: number
  /** The session's first request in the attempt: on any attempt after the task's first, the whole
   *  conversation read again into a cache that does not hold it. null with no request. It stays a
   *  transcript read: the kit holds no per-call rows to ask for it. */
  first: CliMayteTokens | null
  /** False when no transcript was there: nothing measured, which is not a measured zero. */
  found: boolean
  /** True when the kit had ingested every transcript file of the attempt (kitHolds), so the figures
   *  are final. False: the sweep is behind and the attempt is charged again once it catches up. */
  settled: boolean
}

/** The first assistant request's usage in [startedAt, endedAt] of a transcript, or null. */
function firstRequest(text: string, startedAt: number, endedAt: number): CliMayteTokens | null {
  for (const line of text.split('\n')) {
    const turn = parseUsageLine(line)
    if (!turn || !(turn.ts >= startedAt && turn.ts <= endedAt)) continue
    const u = turn.usage
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheCreation }
  }
  return null
}

/** Every `*.jsonl` under `dir`, at most `depth` folders down; none when it does not exist. */
function jsonlUnder(dir: string, depth: number): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) =>
    e.isDirectory()
      ? depth > 1
        ? jsonlUnder(join(dir, e.name), depth - 1)
        : []
      : e.name.endsWith('.jsonl')
        ? [join(dir, e.name)]
        : [],
  )
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

export function summarizeEvent(raw: unknown): string | null {
  const ev = raw as any
  if (ev?.type === 'result') {
    const turns = Number(ev.num_turns) || 0
    // total_cost_usd is the whole session's cost so far on a resumed session, not this turn's.
    return `finished (${turns} ${turns === 1 ? 'turn' : 'turns'}; session so far $${(Number(ev.total_cost_usd) || 0).toFixed(2)})`
  }
  if (ev?.type === 'system' && ev.subtype === 'init') return `started (${ev.model ?? 'unknown'})`
  if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null
  for (const b of ev.message.content) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return `said: ${oneLine(b.text, 140)}`
    }
    if (b?.type === 'tool_use') {
      const i = b.input ?? {}
      const arg = [i.file_path, i.command, i.pattern, i.description].find(
        (v) => typeof v === 'string' && v,
      )
      return `${b.name} ${arg ? oneLine(arg, 100) : ''}`.trim()
    }
  }
  return null
}

/** The most workers one Pro window runs at once, over every group (maxPerAccount scales it). */
export const MAX_PER_ACCOUNT = 4

/** The most workers any one account runs at once, whatever its plan (owner ruling, 2026-10-03). */
export const ACCOUNT_WORKERS_CEILING = 8

/** How many workers an account runs at once, over every group: MAX_PER_ACCOUNT per Pro window its
 *  5-hour window holds, up to ACCOUNT_WORKERS_CEILING (Pro 4, Max 5x 8, Max 20x 8). 2026-10-03
 *  11:05: the Max 20x #35 at 26% ran 4 workers and was refused a fifth by a flat 4, while seven
 *  tasks waited. */
export function maxPerAccount(a: Pick<CliMayteAccount, 'planFactor'>): number {
  return Math.min(MAX_PER_ACCOUNT * (a.planFactor ?? 1), ACCOUNT_WORKERS_CEILING)
}

/** What one worker already running on an account (from ANY group) adds to its score: a full usage
 *  window's worth, so an idle account wins over a busy one unless it is near its limit. Field note 8
 *  (2026-09-30): at 25 a worker, a busy account at 5% scored 30 against an idle one whose usage was
 *  unknown (50), so eight workers from four dispatches stacked two each on four accounts while #83
 *  and #91 sat idle, draining four accounts together instead of spreading over six. */
export const ACTIVE_WEIGHT = 100

/** A group's workers on one Pro account when its dispatcher named no cap. */
export const DEFAULT_PER_ACCOUNT = 2

/** How many of one group's workers an account takes at once. A cap the dispatcher set
 *  (`perAccount`) holds as given (and spills past it when nothing within it takes the task, unless
 *  the group is per_account_strict: climayte-schedule scheduleWorker). The default counts Pro
 *  windows, not workers: 2 for each Pro window the account's 5-hour window holds (planFactor).
 *  2026-10-02 04:36: the Max 5x #103 sat at 0-12% with room for 425 Pro-points and ran 2 tasks at a
 *  time, like each Pro, while 24 waited. It was halved on an account ahead of its weekly pace until
 *  the owner ruled on 2026-10-03 ("distribute the load"): that held priority work back while the
 *  account had room; the weekly pace still orders the accounts (placedRank). maxPerAccount still
 *  holds above it. */
export function groupCap(
  a: Pick<CliMayteAccount, 'planFactor'>,
  perAccount: number | null,
): number {
  return perAccount ?? DEFAULT_PER_ACCOUNT * (a.planFactor ?? 1)
}

/** An account's rank with a placement (climayte-placement.ts), lowest first, and the projection
 *  that breaks a tie. Where the task is projected to finish under FIT_PCT comes first: accounts at
 *  or behind their weekly pace (within PACE_BAND), most behind first, since that is room lost at
 *  the weekly reset; then accounts ahead of it (usage is usage, wherever it runs). Where it does
 *  not fit comes last, lowest projection first. 2026-10-02 05:09: the score added only a POSITIVE
 *  gap, so #90 (+7.5) beat #95 (-20.6) on a lower 5-hour projection, and #95 sat without a worker
 *  for 14 minutes while 8 tasks waited. A chat (a person waits on it) goes where it has the most
 *  room (chatRoom) instead. */
function placedRank(
  a: CliMayteAccount,
  placement: CliMaytePlacement,
  now: number,
  chat: boolean,
): [number, number] {
  const projected = projectedPct(
    a,
    placement.running.get(a.id) ?? [],
    placement.expected,
    placement.finishedSince?.get(a.id) ?? 0,
  )
  if (projected > fitPct(a)) return [NO_FIT_SCORE + projected, projected]
  if (chat) return [0, -chatRoom(a, projected, now)]
  const gap = paceGap(a, now) ?? 0
  return [gap > PACE_BAND ? 100 + gap : gap, projected]
}

/** How much a chat has before the account is asked to stop, in Pro windows' points: the smaller of
 *  the 5-hour room under FIT_PCT and the weekly room under its stop line, times the plan. A chat has
 *  no cost estimate, so by pace alone a Pro at 80% beat a Max 20x at 10% and the owner's chat wound
 *  down there minutes later (owner, 2026-10-05: "My chat should be prioritized in like a 20x account.
 *  Not one that has to change every 10 seconds"). */
function chatRoom(a: CliMayteAccount, projected: number, now: number): number {
  const week = accountWeekStopPct(a, a.weekResetsAt, now) - (a.weekPct ?? 50)
  return Math.max(0, Math.min(fitPct(a) - projected, week)) * (a.planFactor ?? 1)
}

/** The best account for the worker (rankAccounts' first), or null when none takes it now. */
export function pickAccount(
  worker: Pick<CliMayteWorker, 'accounts' | 'accountId' | 'attempts' | 'chat'>,
  accounts: CliMayteAccount[],
  walls: CliMayteWalls,
  active: Map<string, number>,
  perAccount: number | null,
  now: number,
  groupActive: Map<string, number> = active,
  allowFull = false,
  placement?: CliMaytePlacement,
): CliMayteAccount | null {
  const ranked = rankAccounts(
    worker,
    accounts,
    walls,
    active,
    perAccount,
    now,
    groupActive,
    allowFull,
    placement,
  )
  return ranked[0] ?? null
}

/** An account at or above the paid-usage caps (BILL_GUARD_*). */
function accountIsFull(a: CliMayteAccount): boolean {
  return (
    (a.sessionPct !== null && a.sessionPct >= BILL_GUARD_SESSION_PCT) ||
    (a.weekPct !== null && a.weekPct >= BILL_GUARD_WEEK_PCT)
  )
}

/** An account past its wind-down line (sessionStopPct, accountWeekStopPct: the owner's caps or the
 *  fleet's lines). */
function accountIsNear(a: CliMayteAccount, now: number): boolean {
  return (
    (a.sessionPct !== null && a.sessionPct >= sessionStopPct(a)) ||
    (a.weekPct !== null && a.weekPct >= accountWeekStopPct(a, a.weekResetsAt, now))
  )
}

/** A score at or above this in rankAccounts is an account the task does not fit (placedRank) or one
 *  near its line, full, or the one it just failed on (rankPenalty): below every account it fits. */
const NO_FIT_SCORE = 300

/** What rankAccounts adds to an account's score for being full, near the line, the one a handoff
 *  left, or the one a last attempt failed on. */
function rankPenalty(
  a: CliMayteAccount,
  nudgedFrom: string | null,
  failedId: string | null,
  now: number,
): number {
  return (
    (accountIsFull(a) ? 500 : 0) +
    (accountIsNear(a, now) ? NO_FIT_SCORE : 0) +
    (a.id === nudgedFrom ? 100 : 0) +
    (a.id === failedId ? 1000 : 0)
  )
}

/** What a worker's last attempt says about where it goes next (rankAccounts). */
interface LastAttemptIds {
  /** The account of a last quota/auth attempt: tried last. */
  failedId: string | null
  /** The account a handoff left: no home to keep. */
  handedOffFrom: string | null
  /** The account a handoff left, unless it handed off on conversation size: nudged away. */
  nudgedFrom: string | null
}

function lastAttemptIds(worker: Pick<CliMayteWorker, 'attempts'>): LastAttemptIds {
  const lastAttempt = worker.attempts[worker.attempts.length - 1]
  const failedId =
    lastAttempt && (lastAttempt.outcome === 'quota' || lastAttempt.outcome === 'auth')
      ? lastAttempt.account.id
      : null
  // After a handoff the next session is a fresh one: no home to keep, and the account it left is
  // only nudged back (it may well be the one with the most room: a handoff on request).
  const handedOffFrom = lastAttempt?.outcome === 'handoff' ? lastAttempt.account.id : null
  // A handoff on conversation size says nothing against its account: nudged away, every one of a
  // long task's handoffs would change account and run it into the moves cap (notConverging).
  const nudgedFrom = lastAttempt?.windDown?.reason === 'context' ? null : handedOffFrom
  return { failedId, handedOffFrom, nudgedFrom }
}

/** What rankAccounts' eligibility test reads for every account. */
interface RankInputs {
  worker: Pick<CliMayteWorker, 'accounts' | 'accountId'>
  walls: CliMayteWalls
  active: Map<string, number>
  groupActive: Map<string, number>
  perAccount: number | null
  now: number
  allowFull: boolean
  ids: LastAttemptIds
}

/** An account at its ceiling (CEILING_PCT, or lower under the owner's cap: ceilingPct) on either
 *  window. */
function accountAtCeiling(a: CliMayteAccount): boolean {
  return (
    (a.sessionPct !== null && a.sessionPct >= ceilingPct(a.maxSessionPct)) ||
    (a.weekPct !== null && a.weekPct >= ceilingPct(a.maxWeekPct))
  )
}

/** The worker's session already lives on this account and may carry on there (its home), past the
 *  stop line too (it is asked to hand off there), but not at the ceiling: a session going on there
 *  is stopped on its first request. 2026-10-03: a manager's wake went home to #129 at 92% and was
 *  found past the ceiling at once. */
function keepsHome(a: CliMayteAccount, r: RankInputs): boolean {
  return (
    !r.ids.handedOffFrom &&
    a.id === r.worker.accountId &&
    a.id !== r.ids.failedId &&
    (r.allowFull || !accountAtCeiling(a))
  )
}

/** The account may take the worker at all: one it may use, not walled, not full (unless
 *  allowFull), and under its worker cap (maxPerAccount). */
function accountAdmits(a: CliMayteAccount, r: RankInputs): boolean {
  return (
    (!r.worker.accounts || r.worker.accounts.includes(a.id)) &&
    !isWalledNow(r.walls[a.id], r.now) &&
    (r.allowFull || !accountIsFull(a)) &&
    (r.active.get(a.id) ?? 0) < maxPerAccount(a)
  )
}

/** The account takes NEW work: everything here is waived for the session already on it
 *  (keepsHome). */
function takesNewWork(a: CliMayteAccount, r: RankInputs): boolean {
  const load = r.active.get(a.id) ?? 0
  // Past the wind-down line, new work there would be asked to hand off again at once (measured
  // live: a continuation placed on #84 at 91% wound down immediately, while #83 sat at 58%).
  // Past the line an account takes no NEW work: a new task, a handoff's continuation or a moved
  // session is told to hand off within a few calls, or hits the limit on its first. Run 1, 19:32
  // to 19:36: twenty such hops at 89-97%, about 290k tokens and $0.75 each, and seven tasks ended up
  // waiting anyway. Only the session already on it carries on there (its home); the rest wait.
  if (!r.allowFull && accountIsNear(a, r.now)) return false
  // An account with no reading in its current 5-hour window (unread since its last reset, or a
  // login whose usage check keeps failing), or only a stale one (readingStale), takes one worker
  // until that worker's stream reads it: the first request tells whether the login works and how
  // full the account really is, within seconds. 2026-10-01 09:31: #88's last reading was four hours
  // old, it counted as half full and roomy, and one tick sent it four tasks; all four failed
  // sign-in together.
  if ((a.sessionPct === null || readingStale(a, r.now)) && load > 0) return false
  // An account whose usage is due to be read again keeps its rank: the start waits for the reading
  // (readingPending), so the task neither goes on the old number nor passes the account over.
  // New work goes around an account someone else is using; a task that names the account is a
  // person's word.
  if (accountInUse(a) && !r.worker.accounts?.includes(a.id)) return false
  return (r.groupActive.get(a.id) ?? 0) < groupCap(a, r.perAccount)
}

/** Every account that takes the worker now, best first; the session's own account alone when it
 *  is one of them. `perAccount` caps this group's workers (`groupActive`, default `active`) on an
 *  account (groupCap; null: the default); a session going back to its own account is not held to
 *  it (2026-10-02 05:13: a new task took #102's slot while a finished task's check ran, the check
 *  failed, and the 33-turn session moved to #94, about 170k cache-write tokens more than resuming
 *  at home). `active` counts every group's, is held under maxPerAccount, and is what the score
 *  spreads by (ACTIVE_WEIGHT). The account of a last
 *  quota/auth attempt is not excluded (its wall keeps it out while the wall is real), only tried
 *  last, so a worker restricted to it resumes once the limit resets or the login works again.
 *  `allowFull` (the owner allowed paid extra usage): accounts at or above the 98% session / 99%
 *  weekly caps stay eligible, but only after every account below them. */
export function rankAccounts(
  worker: Pick<CliMayteWorker, 'accounts' | 'accountId' | 'attempts' | 'chat'>,
  accounts: CliMayteAccount[],
  walls: CliMayteWalls,
  active: Map<string, number>,
  perAccount: number | null,
  now: number,
  groupActive: Map<string, number> = active,
  allowFull = false,
  placement?: CliMaytePlacement,
): CliMayteAccount[] {
  const ids = lastAttemptIds(worker)
  const { failedId, handedOffFrom, nudgedFrom } = ids
  const r: RankInputs = { worker, walls, active, groupActive, perAccount, now, allowFull, ids }
  const load = (a: CliMayteAccount): number => active.get(a.id) ?? 0
  const full = accountIsFull
  const eligible = accounts.filter(
    (a) => accountAdmits(a, r) && (keepsHome(a, r) || takesNewWork(a, r)),
  )
  // A full home is kept only when every other choice is full too.
  const home = handedOffFrom
    ? undefined
    : eligible.find(
        (a) => a.id === worker.accountId && a.id !== failedId && (!full(a) || eligible.every(full)),
      )
  if (home) return [home]
  // With a placement: placedRank; else the flat ACTIVE_WEIGHT spread.
  const flat = (a: CliMayteAccount): [number, number] => [
    Math.max(a.sessionPct ?? 50, a.weekPct ?? 50) + ACTIVE_WEIGHT * load(a),
    0,
  ]
  const byNum = (a: CliMayteAccount): number => a.num ?? Number.MAX_SAFE_INTEGER
  const unread = (a: CliMayteAccount): number =>
    a.sessionPct === null && a.weekPct === null ? 1 : 0
  const scored = eligible.map((a) => {
    const [base, tie] = placement ? placedRank(a, placement, now, worker.chat === true) : flat(a)
    const penalty = rankPenalty(a, nudgedFrom, failedId, now)
    // The owner's priority (owner, 2026-10-09: "set certain accounts as priority") orders the
    // accounts the task fits that are not past their line, full or just failed on, ahead of the score;
    // it never lifts one the task does not fit above one it does.
    const fits = penalty < NO_FIT_SCORE && (!placement || base < NO_FIT_SCORE)
    return { a, score: base + penalty, tie, unread: unread(a), fits: fits ? 0 : 1 }
  })
  const priority = (a: CliMayteAccount): number => a.priority ?? 0
  scored.sort(
    (x, y) =>
      x.unread - y.unread ||
      x.fits - y.fits ||
      priority(y.a) - priority(x.a) ||
      x.score - y.score ||
      x.tie - y.tie ||
      byNum(x.a) - byNum(y.a),
  )
  return scored.map((s) => s.a)
}

/** A task's priority: a whole number, higher starts first; absent is 0. */
export function climaytePriority(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > 1000)
    throw new Error(`priority must be a whole number from -1000 to 1000 (got ${String(v)})`)
  return n
}

/** The order queued and waiting work starts in: highest priority first, then oldest first. Field
 *  note 20 (run 1, 19:45): with every account full, the owner's ASAP item (the Events deploy) waited
 *  behind sweep follow-ups for the 23:21 reset, because waiting work started strictly oldest-first.
 *  One dispatch's tasks share a createdAt (all 31 of odin-w1, 2026-10-02): among those the largest
 *  expected cost goes first, so a task only a fresh window holds is placed before small ones fill it.
 *  A chat goes before all of them: a person is waiting on its answer (owner, 2026-10-05: "prioritize
 *  the Hydra desk"). */
export function dueOrder(
  a: Pick<CliMayteWorker, 'priority' | 'createdAt' | 'size' | 'chat'>,
  b: Pick<CliMayteWorker, 'priority' | 'createdAt' | 'size' | 'chat'>,
): number {
  return (
    Number(b.chat === true) - Number(a.chat === true) ||
    (b.priority ?? 0) - (a.priority ?? 0) ||
    a.createdAt - b.createdAt ||
    (b.size?.expected ?? 0) - (a.size?.expected ?? 0)
  )
}

/** Who gets a launch slot first (climayte-pacing): 0 a turn a person just sent (a chat's follow-up),
 *  1 any other work, 2 a resume after the CLI was killed (a daemon restart), which waits for the rest. */
export function launchRank(w: Pick<CliMayteWorker, 'chat' | 'attempts'>): 0 | 1 | 2 {
  if (w.attempts?.at(-1)?.outcome === 'interrupted') return 2
  return w.chat === true ? 0 : 1
}

/** Of `candidates` (each an account's config dir), the one holding the newest copy of a session's
 *  transcript (by its file's mtime), or null when none holds it. A tie goes to the earlier one.
 *  Field note 30: a move copied from the account last TRIED, where a refused login had written
 *  nothing (and whose folder was later gone), so five sessions that sat intact on #83, #95, #88 and
 *  #98 failed as "not found". */
export function newestTranscript<T extends { configDir: string }>(
  candidates: T[],
  sessionId: string,
): (T & { mtimeMs: number }) | null {
  let best: (T & { mtimeMs: number }) | null = null
  for (const c of candidates) {
    const root = join(c.configDir, 'projects')
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      let mtimeMs: number
      try {
        mtimeMs = statSync(join(root, d, `${sessionId}.jsonl`)).mtimeMs
      } catch {
        continue
      }
      if (!best || mtimeMs > best.mtimeMs) best = { ...c, mtimeMs }
      break
    }
  }
  return best
}

/** Copy a session transcript (and its sibling dir) between config dirs so `--resume` finds it.
 *  The copy keeps the source's mtime, so newestTranscript still tells which account last wrote it.
 *  False when the source does not exist: nothing was recorded, so start fresh. */
export function copySessionTranscript(
  fromConfigDir: string,
  toConfigDir: string,
  sessionId: string,
): boolean {
  const root = join(fromConfigDir, 'projects')
  if (!existsSync(root)) return false
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, d.name, `${sessionId}.jsonl`)
    if (!d.isDirectory() || !existsSync(file)) continue
    const dest = join(toConfigDir, 'projects', d.name)
    mkdirSync(dest, { recursive: true })
    cpSync(file, join(dest, `${sessionId}.jsonl`), { preserveTimestamps: true })
    const dir = join(root, d.name, sessionId)
    if (existsSync(dir))
      cpSync(dir, join(dest, sessionId), { recursive: true, preserveTimestamps: true })
    // No memory folder comes along: workers run with the CLI's auto-memory off, and memory lives in
    // the Connections store, which every account reads (2026-10-03).
    return true
  }
  return false
}

export const isLive = (w: Pick<CliMayteWorker, 'status'>): boolean =>
  w.status === 'queued' ||
  w.status === 'running' ||
  w.status === 'waiting' ||
  w.status === 'checking'

/** How many finished workers a list with no id or group shows beside the active ones. */
export const RECENT_FINISHED = 20

/** Every active worker plus the `limit` most recently finished ones (by their last change), newest
 *  first by creation. Field note 1 (2026-09-30): an unscoped climayte_status answered all 141 workers
 *  ever recorded, 51k characters, and overflowed the tool result. `limit` undefined keeps them all. */
export function recentWorkers<T extends Pick<CliMayteWorker, 'status' | 'createdAt' | 'updatedAt'>>(
  ws: T[],
  limit: number | undefined,
): T[] {
  const keep =
    limit === undefined
      ? ws
      : [
          ...ws.filter(isLive),
          ...ws
            .filter((w) => !isLive(w))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, Math.max(0, limit)),
        ]
  return [...keep].sort((a, b) => b.createdAt - a.createdAt)
}

/** A list row for an orchestrator deciding what to do next: the report row (toReport) without the
 *  report text, plus what it may act on. Nothing it wrote itself and nothing climayte_status { id }
 *  answers in full: the old row carried the whole report, three full attempts, the prompt's first
 *  line, UUIDs and the size's prose, 96 KB for a default call of 28 workers (stress review,
 *  2026-10-02). Empty values are left out. */
export type CliMayteWorkerBrief = Omit<CliMayteWorkerReport, 'report' | 'reportCut'> & {
  costUsd?: number
  moves?: number
  priority?: number
  pending?: number
  /** Characters of its report(s); read them with `report: true` or `{ id }`. */
  resultChars?: number
}
export function toBrief(v: CliMayteWorkerView): CliMayteWorkerBrief {
  const { report: _report, reportCut: _cut, ...row } = toReport(v, 0)
  const resultChars = (v.results?.length ? v.results : v.result ? [v.result] : []).reduce(
    (n, r) => n + r.length,
    0,
  )
  const extra = {
    costUsd: v.costUsd ? Math.round(v.costUsd * 100) / 100 : undefined,
    moves: v.moves || undefined,
    priority: v.priority || undefined,
    pending: v.pending?.length || undefined,
    resultChars: resultChars || undefined,
  }
  const out: Record<string, unknown> = { ...row, ...extra }
  for (const k of Object.keys(out))
    if (out[k] === undefined || out[k] === null || out[k] === '') delete out[k]
  return out as CliMayteWorkerBrief
}

/** Caps for one turn (the attempts since its newest finished one): past any of them a task that
 *  keeps moving, handing off or spending stops and asks its orchestrator instead of going on. The
 *  worst task on record ran 12 attempts and 6 moves for $18.77 and failed anyway (stress review,
 *  2026-10-02). Sign-in refusals cost nothing and do not count. */
export const TURN_CAPS = { attempts: 8, moves: 4, handoffs: 3, overrun: 3, overrunFloorPct: 50 }

/** Why a task should stop and ask, or null while it is converging. Pure: the attempts and the size
 *  it was dispatched at. */
export function notConverging(
  w: Pick<CliMayteWorker, 'attempts' | 'model' | 'chat'> & { size?: { expected: number } | null },
): string | null {
  // A chat is the owner's own conversation, not a sized task: it moves accounts at a limit and
  // hands off, but is never stopped for size, spend, moves or attempts.
  if (w.chat) return null
  let lastDone = -1
  w.attempts.forEach((a, i) => {
    if (a.outcome === 'done') lastDone = i
  })
  const turn = w.attempts
    .slice(lastDone + 1)
    .filter((a) => a.outcome !== 'auth' && a.outcome !== 'running')
  if (!turn.length) return null
  // A handoff on conversation size is the plan working, not a task going in circles: a long task
  // makes one every CONTEXT_HANDOFF_TOKENS, and its fresh session starts wherever there is most
  // room, so neither it nor the account change after it counts. Nor does a move off a limit, or a
  // handoff the usage stop line asked for (owner, 2026-10-03: "When a worker hits a five-hour or
  // weekly limit, CliMayte moves it to another account and resumes it"): that is the rule working.
  // The attempts and spend caps still bound it.
  const planned = (a: CliMayteAttempt): boolean =>
    a.outcome === 'quota' ||
    (a.outcome === 'handoff' && (a.windDown?.reason === 'context' || a.windDown?.pct != null))
  let moves = 0
  for (let i = 1; i < turn.length; i++)
    if (turn[i]!.account.id !== turn[i - 1]!.account.id && !planned(turn[i - 1]!)) moves++
  const handoffs = turn.filter((a) => a.outcome === 'handoff' && !planned(a)).length
  const pct = turn.reduce(
    (s, a) => s + pctOf(attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl)),
    0,
  )
  const cap = Math.max(TURN_CAPS.overrun * (w.size?.expected ?? 0), TURN_CAPS.overrunFloorPct)
  const why =
    turn.length >= TURN_CAPS.attempts
      ? `${turn.length} attempts`
      : moves >= TURN_CAPS.moves
        ? `${moves} moves between accounts`
        : handoffs >= TURN_CAPS.handoffs
          ? `${handoffs} handoffs`
          : pct > cap
            ? `${Math.round(pct)}% of a Pro window spent, over ${Math.round(cap)}% (3 times its estimate)`
            : null
  return why
    ? `Not converging: ${why} in this turn, so CliMayte stopped it to ask. Split the task, or continue it as it is with climayte_send.`
    : null
}

/** Why an attempt started: the task's check failed (`detail`: how, and the last line it printed), a
 *  verdict sent it back (`detail`: its note's first line), or a follow-up message reached it.
 *  Owner, 2026-10-02, on a task listed as #94, #103, #103, #103, #103: "Why? Is that some sort of
 *  previously broken one that's stuck?" Each was the same session, sent back for another round. */
export interface AttemptCause {
  cause: 'check' | 'sent-back' | 'follow-up'
  detail: string | null
}

/** Why attempt `i` started, when the one before it ended done (a handoff or a limit says why in that
 *  attempt's own notice): the newest fail verdict between the two starts, else a follow-up. */
export function attemptCause(w: CliMayteWorker, i: number): AttemptCause | undefined {
  const prev = w.attempts[i - 1]
  const at = w.attempts[i]
  if (!prev || !at || prev.outcome !== 'done') return undefined
  const fail = [...(w.verdicts ?? [])]
    .reverse()
    .find((v) => v.verdict === 'fail' && v.at >= prev.startedAt && v.at <= at.startedAt)
  if (!fail) return { cause: 'follow-up', detail: null }
  const lines = (fail.note ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (fail.by === 'check') {
    const how = /failed \(([^)]*)\)/.exec(lines[0] ?? '')?.[1] ?? null
    const last = lines.length > 1 ? lines[lines.length - 1] : null
    const tail = last && !last.endsWith('output:') ? last.slice(0, 200) : null
    return { cause: 'check', detail: [how, tail].filter(Boolean).join(': ') || null }
  }
  return { cause: 'sent-back', detail: lines[0]?.slice(0, 200) ?? null }
}

/** Seconds the worker's CLI sessions actually ran, summed over every attempt: working time, not
 *  time since it was created (hours waiting for an account, or a day between a finished task and its
 *  follow-up, are not time it ran). */
export function ranSeconds(w: CliMayteWorker, now: number): number {
  const live = isLive(w)
  return Math.round(
    w.attempts.reduce(
      (sum, a) => sum + Math.max(0, (a.endedAt ?? (live ? now : a.startedAt)) - a.startedAt),
      0,
    ) / 1000,
  )
}

/** `result` and `results` as the view shows them (statusTurns); nothing when they stay as stored. */
function keptReport(w: CliMayteWorker): Pick<CliMayteWorker, 'result' | 'results'> | undefined {
  const turns = statusTurns(w)
  if (turns.length === (w.results?.length || (w.result ? 1 : 0))) return undefined
  return { results: turns, result: joinResults(turns) }
}

export function toView(w: CliMayteWorker, now: number): CliMayteWorkerView {
  const ref = [...w.attempts].reverse().find((a) => a.account.id === w.accountId)?.account
  const live = isLive(w)
  return {
    ...w,
    prompt: w.prompt.slice(0, 300),
    ...keptReport(w),
    waitUntil: w.status === 'waiting' ? (w.waitUntil ?? null) : undefined,
    account: ref ? (ref.num === null ? ref.name : `#${ref.num} ${ref.name}`) : null,
    // Working time, not time since it was created: hours spent waiting for an account, or a day
    // between a finished task and its follow-up, are not time it ran.
    ranS: ranSeconds(w, now),
    reportedModel: [...w.attempts].reverse().find((a) => a.model)?.model ?? null,
    verdicts: w.verdicts?.map(({ units, ...v }) => ({
      ...v,
      pct: units > 0 ? Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10 : null,
    })),
    attempts: w.attempts.map((a, i) => ({
      account: { id: a.account.id, num: a.account.num, name: a.account.name },
      outcome: a.outcome,
      notice: a.notice,
      requested: a.requested,
      model: a.model,
      ...(a.ceiling ? { ceiling: true } : {}),
      tokens: a.tokens,
      costUsd: a.spend ? a.spend.costUsd : null,
      turns: a.spend ? a.spend.turns : null,
      pct: a.tokens ? pctOf(attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl)) : null,
      rereadPct: a.spend ? pctOf(rereadUnits(a, w.model)) : null,
      ...(attemptCause(w, i) ? { because: attemptCause(w, i) } : {}),
      ...(a.left?.length ? { left: a.left } : {}),
      ...(a.peakProcesses ? { peakProcesses: a.peakProcesses } : {}),
    })),
    used: (() => {
      const all = w.attempts.reduce(
        (s, a) => s + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl),
        0,
      )
      const reread = w.attempts.reduce((s, a) => s + rereadUnits(a, w.model), 0)
      return { pct: pctOf(all), workPct: pctOf(all - reread), rereadPct: pctOf(reread) }
    })(),
    judged: !live && verdictCoversNewestWork(w),
  }
}

/** Weighted units as % of a Pro 5-hour window, to one decimal. */
const pctOf = (units: number): number => Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10
