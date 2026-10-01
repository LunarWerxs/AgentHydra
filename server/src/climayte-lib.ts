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
import { type CliMaytePlacement, FIT_PCT, projectedPct } from './climayte-placement'
import { type CliMayteVerdict, UNITS_PER_PRO_PERCENT } from './climayte-scorecard'
import { priceTokens } from './pricing'
import {
  classifyLimit,
  compactNotice,
  createLimitStopTracker,
  isApiErrorEvent,
  limitEventText,
} from './rate-limit-signal'
import { sumTranscriptTokens } from './usage-tokens'

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
  windDown?: { at: number; pct: number | null; path: string } // asked to hand off to `path` (pct null: on request)
  tokens?: CliMayteTokens // this attempt's own tokens (attemptSpend); absent on attempts before 2026-09-30
  /** The session this attempt ran in. A planned handoff starts a new one, so the worker's current
   *  `sessionId` is not every attempt's. null: the log names none (the CLI never started). */
  sessionId?: string | null
  /** The prompt cache it ran with ('5m' since 49e6ab1; absent: the 1-hour default). */
  cacheTtl?: '5m'
  /** The account's 5-hour usage when it started (placement measures what running work spent). */
  startPct?: number | null
  /** What it was launched with (`--model`, `--effort`; null: the CLI's default). Absent before 2026-10-01. */
  requested?: { model: string | null; effort: string | null }
  /** The model the CLI reported in its system/init event: what really ran. */
  model?: string
  /** Run under a runner outside the daemon (climayte-runner.ts), so a daemon restart leaves it running.
   *  `pid` is the runner's, filled from `pidFile` once it has started the CLI; the CLI's own is the
   *  attempt's `pid`. Absent on attempts spawned by the daemon directly (before 2026-09-30). */
  runner?: { pid: number | null; pidFile: string; exitFile: string; launchedAt: number }
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

/** A task's size, all in % of a Pro 5-hour window (a Max 5x window is 500): its expected cost and
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

export interface CliMayteWorker {
  id: string // short id, e.g. 'w-' + 8 hex chars
  group: string // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string // short label (caller's or the first 60 chars of the prompt)
  cwd: string
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
  costUsd: number // summed over every attempt's own spend (attemptSpend), from the transcript
  tokens?: CliMayteTokens // summed the same way; absent on tasks recorded before 2026-09-30
  turns: number // summed `result.num_turns`
  moves: number // how many times the session changed account
  retries: number // transient or interrupted retries used in the current turn
  notBefore: number | null // epoch ms; a transient retry waits until then
  /** While waiting: when it expects to start (ISO, UTC), the first account's limit or reset that
   *  lets it; absent or null when not known. A waiter reads this, never the error text's local time. */
  waitUntil?: string | null
  revived?: boolean // a message revived it after it stopped: deliver that message next
  sessions?: string[] // earlier sessions of this task, oldest first (each handoff starts a new one)
  /** The kind of work (climayte-scorecard CLIMAYTE_KINDS): the scorecard learns what each kind needs. */
  kind?: string | null
  /** CliMayte chose `model` and `effort` from the scorecard (dispatched with model `auto`). */
  auto?: boolean
  /** Each judgement of its result, oldest first (climayteVerdict). */
  verdicts?: CliMayteVerdict[]
  /** A shell command that proves the task is done (exit 0). CliMayte runs it in `cwd` after the worker
   *  reports, records the verdict itself and sends a fail back one rung up (climayte.ts startCheck). */
  check?: string | null
  /** How many times `check` has run. */
  checkRuns?: number
  /** Its size at dispatch (climayte.ts sizeTasks); `room` and `roomOn` are refreshed when it starts
   *  waiting for room. */
  size?: CliMayteSizing
  /** Queued and waiting work starts highest first, then oldest first (dueOrder). Absent: 0. */
  priority?: number
  /** A move found the transcript on no account (field note 30): the last handoff note, which the
   *  next message continues from in a fresh session. */
  handoffNote?: string | null
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
  /** How many Pro windows its 5-hour window holds (climayte-placement planFactor): Pro 1, Max 5x 5. */
  planFactor?: number
  /** When the 5-hour window `sessionPct` was read from resets (epoch ms); null when unknown. */
  sessionResetsAt?: number | null
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
  }>
}

/** The models a worker may run (owner, 2026-09-30: Opus 5.5 or Sonnet 5.5), by the names the CLI
 *  accepts for them (`claude --help`: an alias or the full name). CliMayte passes the full id, so a
 *  later alias move cannot change what a recorded task asked for. */
export const CLIMAYTE_MODELS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  'opus-5.5': 'claude-opus-5-5',
  'opus-5-5': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  'sonnet-5.5': 'claude-sonnet-5-5',
  'sonnet-5-5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
}
/** `claude --effort <level>` (2.1.284): how hard the model thinks on every turn. */
export const CLIMAYTE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const blank = (v: unknown): boolean => v === undefined || v === null || v === ''

/** The full model id for `v`, null when none was asked for. Throws on anything else, naming the
 *  valid values: junk must never reach the CLI. */
export function climayteModel(v: unknown): string | null {
  if (blank(v)) return null
  const id = typeof v === 'string' ? CLIMAYTE_MODELS[v.trim().toLowerCase()] : undefined
  if (!id)
    throw new Error(
      `unknown model '${String(v)}': use opus or sonnet (or claude-opus-5-5, claude-sonnet-5-5)`,
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
  "You are a CliMayte worker: a Claude Code CLI session that AgentHydra started on one of the owner's accounts, at the owner's request, to do one delegated task for an orchestrating chat. Do the whole task yourself, in this session. Nobody is watching to answer questions, so make the reasonable call and say which call you made. Follow the repository's own rules. Commit only the files you changed, and push if the repository's rules say to. Never read or print a secret value. End with a short report: what you did, the proof you saw (a command and what it printed), and anything left undone with the reason."

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
export const WIND_DOWN_WEEK_PCT = 95

/** The percentage that calls for a wind-down now, or null. */
export function windDownAt(live: CliMayteLiveUsage | null): number | null {
  if (live?.sessionPct != null && live.sessionPct >= WIND_DOWN_SESSION_PCT) return live.sessionPct
  if (live?.weekPct != null && live.weekPct >= WIND_DOWN_WEEK_PCT) return live.weekPct
  return null
}

/** What a winding-down worker is told after its next tool call (a PostToolUse hook shows it). The
 *  session that has the whole context writes the handoff, while its own cache is warm; the next
 *  account then starts a small fresh session from it instead of re-reading the whole conversation
 *  (a move re-reads it all uncached: 219k tokens cost $1.77 on one live move, 2026-09-30). */
export function windDownMessage(pct: number | null, path: string): string {
  const why =
    pct === null
      ? 'the orchestrator asked this session to hand the task to a fresh session'
      : `this account is at ${Math.round(pct)}% of its usage limit, so this session must hand the task to a fresh session on another account`
  return `AgentHydra: ${why}. Wrap up now: finish or safely stop the step you are on and do not start anything new. Then write a handoff with the Write tool to ${path} for the session that continues this task. It sees only the original task, your handoff and your transcript, so include: the goal as you understand it; what is done (files changed, commits, results, with paths); what is in progress and its exact state (if you were about to commit, land or push: the exact commit message, subject and body verbatim, and the exact paths); the next steps in order; the facts, decisions and gotchas you learned; and the commands or checks that prove the work. If the whole task is already complete, do not write a handoff: finish normally with your final report. After writing the handoff, end your turn with one line saying the handoff is written.`
}

/** The first prompt of the session that continues a task from a handoff. */
export function continuationPrompt(
  task: string,
  handoff: string,
  handoffPath: string,
  transcript: string | null,
  messages: string[],
): string {
  const more = messages.length
    ? `\n\nThe orchestrator also sent these messages, which the earlier session did not get to:\n${messages.map((m) => `- ${m}`).join('\n')}`
    : ''
  const where = transcript
    ? ` Its full transcript is at ${transcript} if you need a detail the handoff left out (read it with the Read or Grep tools; it is JSON lines).`
    : ''
  return `${task}\n\n---\nAn earlier session already worked on this task on another account and wound down before its usage limit. Continue from its handoff below (also saved at ${handoffPath}).${where} Do not redo steps it reports finished; check its claims where a command can. If it gives a commit message for work in progress, commit with that message verbatim.${more}\n\n--- HANDOFF ---\n${handoff}`
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
// so the task moves on and the account is walled like a signed-out one.
const AUTH_RE =
  /please run \/login|not logged in|invalid api key|failed to authenticate|oauth (?:token|session) (?:has )?(?:expired|been revoked)|authentication_error|disabled claude subscription access/i

/** The wall reason for an account whose organization turned Claude Code off. `claude auth status`
 *  still says such a login works, so the 30-minute signed-out recheck lifted its wall every time,
 *  and each lift sent every waiting task at it at once (run 1: #91, 7 failed attempts, 4 in one
 *  second). Only a different login (its credential file changing) lifts this one. */
export const ORG_DISABLED_WALL = 'organization disabled Claude Code'
const ORG_DISABLED_RE = /disabled claude subscription access|oauth_org_not_allowed/i
export const isOrgDisabled = (notice: string | null): boolean =>
  !!notice && ORG_DISABLED_RE.test(notice)
/** A wall about the login, not the usage: its `until` is a recheck time, never when it frees up. */
export const isLoginWall = (reason: string | undefined): boolean =>
  reason === 'signed out' || reason === ORG_DISABLED_WALL

export function scrubbedEnv(configDir: string, workerId?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  }
  env.CLAUDE_CONFIG_DIR = configDir
  if (workerId) env.AGENTHYDRA_CLIMAYTE_WORKER = workerId
  return env
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
  const tracker = createLimitStopTracker()
  const apiErrors: string[] = [] // CLI-reported API-error events of the main agent
  let last: any = null // the terminal `result` event
  // The CLI's structured wall ({"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
  // "rateLimitType":"seven_day","resetsAt":<epoch s>}}), until something shows the turn went on.
  let rejected: { resetsAt: number | null; window: 'session' | 'weekly' | null } | null = null
  // A turn's closing text: the assistant text since the last user event. A Stop hook that refuses
  // the stop answers with a user message, and the session goes on in a new turn (field note 13).
  const turnTexts: string[] = []
  let said: string[] = []
  for (const raw of events) {
    const ev = raw as any
    if (ev?.parent_tool_use_id) continue
    tracker.observe(ev)
    if (ev?.type === 'assistant') {
      for (const b of ev.message?.content ?? [])
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
          said.push(b.text.trim())
    } else if (ev?.type === 'user') {
      if (said.length && isStopHookFeedback(ev)) turnTexts.push(said.join('\n\n'))
      said = []
    }
    if (ev?.type === 'result') {
      last = ev
      if (ev.is_error !== true) rejected = null
    } else if (ev?.type === 'rate_limit_event') {
      const info = ev.rate_limit_info
      if (info?.status !== 'rejected') rejected = null
      else {
        const secs = Number(info.resetsAt)
        const type = String(info.rateLimitType ?? '')
        rejected = {
          resetsAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
          window: type.startsWith('seven_day') ? 'weekly' : type === 'five_hour' ? 'session' : null,
        }
      }
    } else if (isApiErrorEvent(ev)) apiErrors.push(limitEventText(ev))
    else if (ev?.type === 'assistant') rejected = null // real output after it: the turn went on
  }
  const errored = last?.is_error === true
  const resultText = typeof last?.result === 'string' ? last.result : null
  if (last && !errored && resultText?.trim()) turnTexts.push(resultText.trim())
  const errText = errored ? (resultText ?? '') : ''
  const stderrLines = last
    ? []
    : stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse() // the last line that says it wins
  const trusted = [...apiErrors, errText, ...stderrLines] // the only places a wall can be read from
  const base = {
    result: resultText,
    turnTexts,
    turns: Number(last?.num_turns) || 0,
    resetsAt: null,
    window: null,
    resets: null,
  }
  const out = (outcome: AttemptOutcome, notice: string | null): AttemptVerdict => ({
    ...base,
    outcome,
    notice: notice ? compactNotice(notice) : null,
  })
  const quota = (notice: string | null): AttemptVerdict => ({
    ...out('quota', notice),
    resetsAt: rejected?.resetsAt ?? null,
    window: rejected?.window ?? null,
    resets:
      notice
        ?.replace(/\s+/g, ' ')
        .trim()
        .match(/\bresets\s+(.+?)\s*$/i)?.[1] ?? null,
  })

  const stop = tracker.verdict()
  // A clean result clears both the tracker's stop and `rejected`, so either one still set here
  // came after the last clean result: the turn did not finish.
  if (last && !errored && !stop?.pending && !rejected) return out('done', null)
  // The errored result carries the same notice uncut; the tracker's copy is already compacted.
  if (stop?.pending) return quota(classifyLimit(errText) === 'quota' ? errText : stop.notice)
  const quotaText = [errText, ...stderrLines].find((t) => t && classifyLimit(t) === 'quota')
  if (quotaText !== undefined) return quota(quotaText)
  if (rejected) return quota(errText || apiErrors[apiErrors.length - 1] || null)
  const auth = trusted.find((t) => AUTH_RE.test(t))
  if (auth !== undefined) return out('auth', auth)
  const transient = trusted.find((t) => classifyLimit(t) === 'transient')
  if (transient !== undefined) return out('transient', transient)
  // No result and no API error: the process was killed from outside. On Windows a daemon restart
  // does exactly this to every worker (they sit in the daemon's kill-on-close job), and the
  // transcript on disk is intact, so the session is resumed rather than failed. Stderr need not be
  // empty once the CLI started: a normal run can print a harmless warning there (measured: an MCP
  // OAuth 'issuer' stamp notice). One that wrote to stderr before system/init failed to start (an
  // unknown option, a missing session), and that is an error, not a restart.
  if (!last && !apiErrors.length && (started || !stderr.trim()))
    return out('interrupted', INTERRUPTED_NOTICE)
  return out('error', null)
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

/** What one attempt spent: the turns its session transcript recorded on that attempt's account
 *  between its start and its end, priced through the product's one per-turn parser. This is the
 *  only pricing CliMayte uses. The CLI's `result.total_cost_usd` cannot be: on a resumed session it is
 *  the WHOLE session's cost so far (measured 2026-09-30: a one-turn follow-up after a $4.67 turn
 *  reported $6.44 = $4.67 + $1.77), so adding it per attempt counted every earlier turn again on
 *  every follow-up, handoff and resume. A killed or stopped attempt writes no result at all, and
 *  its stream-json log under-reports output; the transcript has both right (this reproduces the
 *  CLI's own figures to the cent). Turns copied in from another account keep their older
 *  timestamps, so they are not counted again. 0 when the transcript is not there. A subagent's
 *  requests bill the same account and sit in their own files under `<session>/subagents/`, so
 *  those are counted too. */
export function attemptSpend(
  configDir: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
): { costUsd: number; tokens: CliMayteTokens } {
  const root = join(configDir, 'projects')
  let files: string[] = []
  try {
    for (const d of readdirSync(root)) {
      const file = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(file)) {
        files = [file, ...jsonlUnder(join(root, d, sessionId, 'subagents'), 3)]
        break
      }
    }
  } catch {
    return { costUsd: 0, tokens: noTokens() }
  }
  let costUsd = 0
  let tokens = noTokens()
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Everything from the start, minus everything after the end: pricing is linear per model.
    const from = sumTranscriptTokens(text, startedAt)
    const after = sumTranscriptTokens(text, endedAt + 1)
    const cost = (s: typeof from) => priceTokens(s.byModel, startedAt).costUsd ?? 0
    const less = (a: number, b: number) => Math.max(0, a - b)
    costUsd += less(cost(from), cost(after))
    tokens = addTokens(tokens, {
      input: less(from.input, after.input),
      output: less(from.output, after.output),
      cacheRead: less(from.cacheRead, after.cacheRead),
      cacheWrite: less(from.cacheCreation, after.cacheCreation),
    })
  }
  return { costUsd, tokens }
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

/** The most workers any one account runs at once, over every group. */
export const MAX_PER_ACCOUNT = 4

/** What one worker already running on an account (from ANY group) adds to its score: a full usage
 *  window's worth, so an idle account wins over a busy one unless it is near its limit. Field note 8
 *  (2026-09-30): at 25 a worker, a busy account at 5% scored 30 against an idle one whose usage was
 *  unknown (50), so eight workers from four dispatches stacked two each on four accounts while #83
 *  and #91 sat idle, draining four accounts together instead of spreading over six. */
export const ACTIVE_WEIGHT = 100

/** `perAccount` caps this group's workers (`groupActive`, default `active`) on an account;
 *  `active` counts every group's, is held under MAX_PER_ACCOUNT, and is what the score spreads by
 *  (ACTIVE_WEIGHT). The account of a last
 *  quota/auth attempt is not excluded (its wall keeps it out while the wall is real), only tried
 *  last, so a worker restricted to it resumes once the limit resets or the login works again.
 *  `allowFull` (the owner allowed paid extra usage): accounts at or above the 98% session / 99%
 *  weekly caps stay eligible, but only after every account below them. */
export function pickAccount(
  worker: Pick<CliMayteWorker, 'accounts' | 'accountId' | 'attempts'>,
  accounts: CliMayteAccount[],
  walls: CliMayteWalls,
  active: Map<string, number>,
  perAccount: number,
  now: number,
  groupActive: Map<string, number> = active,
  allowFull = false,
  placement?: CliMaytePlacement,
): CliMayteAccount | null {
  const lastAttempt = worker.attempts[worker.attempts.length - 1]
  const failedId =
    lastAttempt && (lastAttempt.outcome === 'quota' || lastAttempt.outcome === 'auth')
      ? lastAttempt.account.id
      : null
  // After a handoff the next session is a fresh one: no home to keep, and the account it left is
  // only nudged back (it may well be the one with the most room: a handoff on request).
  const handedOffFrom = lastAttempt?.outcome === 'handoff' ? lastAttempt.account.id : null
  const load = (a: CliMayteAccount): number => active.get(a.id) ?? 0
  const full = (a: CliMayteAccount): boolean =>
    (a.sessionPct !== null && a.sessionPct >= BILL_GUARD_SESSION_PCT) ||
    (a.weekPct !== null && a.weekPct >= BILL_GUARD_WEEK_PCT)
  // Past the wind-down line, new work there would be asked to hand off again at once (measured
  // live: a continuation placed on #84 at 91% wound down immediately, while #83 sat at 58%).
  const near = (a: CliMayteAccount): boolean =>
    (a.sessionPct !== null && a.sessionPct >= WIND_DOWN_SESSION_PCT) ||
    (a.weekPct !== null && a.weekPct >= WIND_DOWN_WEEK_PCT)
  // Past the line an account takes no NEW work: a new task, a handoff's continuation or a moved
  // session is told to hand off within a few calls, or hits the limit on its first. Run 1, 19:32
  // to 19:36: twenty such hops at 89-97%, about 290k tokens and $0.75 each, and seven tasks ended up
  // waiting anyway. Only the session already on it carries on there (its home); the rest wait.
  const keepsHome = (a: CliMayteAccount): boolean =>
    !handedOffFrom && a.id === worker.accountId && a.id !== failedId
  const eligible = accounts.filter(
    (a) =>
      (!worker.accounts || worker.accounts.includes(a.id)) &&
      !((walls[a.id]?.until ?? 0) > now) &&
      (allowFull || !full(a)) &&
      (allowFull || !near(a) || keepsHome(a)) &&
      (groupActive.get(a.id) ?? 0) < perAccount &&
      load(a) < MAX_PER_ACCOUNT,
  )
  // A full home is kept only when every other choice is full too.
  const home = handedOffFrom
    ? undefined
    : eligible.find(
        (a) => a.id === worker.accountId && a.id !== failedId && (!full(a) || eligible.every(full)),
      )
  if (home) return home
  // With a placement (climayte-placement.ts): where the task is projected to finish under FIT_PCT,
  // counting what the work already running there still owes; else the flat ACTIVE_WEIGHT spread.
  const base = (a: CliMayteAccount): number => {
    if (!placement) return Math.max(a.sessionPct ?? 50, a.weekPct ?? 50) + ACTIVE_WEIGHT * load(a)
    const projected = projectedPct(
      a,
      placement.running.get(a.id) ?? [],
      placement.expected,
      placement.finishedSince?.get(a.id) ?? 0,
    )
    return Math.max(projected, a.weekPct ?? 50) + (projected <= FIT_PCT ? 0 : 200)
  }
  const score = (a: CliMayteAccount): number =>
    base(a) +
    (full(a) ? 500 : 0) +
    (near(a) ? 300 : 0) +
    (a.id === handedOffFrom ? 100 : 0) +
    (a.id === failedId ? 1000 : 0)
  const byNum = (a: CliMayteAccount): number => a.num ?? Number.MAX_SAFE_INTEGER
  eligible.sort((a, b) => score(a) - score(b) || byNum(a) - byNum(b))
  return eligible[0] ?? null
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
 *  behind sweep follow-ups for the 23:21 reset, because waiting work started strictly oldest-first. */
export function dueOrder(
  a: Pick<CliMayteWorker, 'priority' | 'createdAt'>,
  b: Pick<CliMayteWorker, 'priority' | 'createdAt'>,
): number {
  return (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt
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
    // The CLI's auto-memory lives beside the transcripts, per account: `projects/<project>/memory/`.
    // A note the session saved there on the old account would be missing on the new one, so the
    // project's memory comes along too, newer file wins, nothing on the destination is removed.
    const memory = join(root, d.name, 'memory')
    if (existsSync(memory)) mergeNewer(memory, join(dest, 'memory'))
    return true
  }
  return false
}

/** Copy every file of `from` into `to` that is missing there or older there, keeping mtimes (so the
 *  next merge compares like with like). Files only in `to` are left alone. */
function mergeNewer(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name)
    const dst = join(to, e.name)
    if (e.isDirectory()) mergeNewer(src, dst)
    else if (e.isFile() && (!existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs))
      cpSync(src, dst, { preserveTimestamps: true })
  }
}

const isLive = (w: Pick<CliMayteWorker, 'status'>): boolean =>
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

/** A list row for an orchestrator: no prompt (it wrote it) and only the last 3 attempts, the bulk
 *  of the stored record after results (measured on 142 real workers: attempts 82k characters,
 *  results 44k, prompts 21k). The full record is climayte_status { id }. */
export type CliMayteWorkerBrief = Omit<CliMayteWorkerView, 'prompt' | 'results' | 'reports'> & {
  attemptCount: number
}
export function toBrief(v: CliMayteWorkerView): CliMayteWorkerBrief {
  const { prompt: _prompt, results: _results, reports: _reports, ...rest } = v
  return { ...rest, attempts: v.attempts.slice(-3), attemptCount: v.attempts.length }
}

export function toView(w: CliMayteWorker, now: number): CliMayteWorkerView {
  const ref = [...w.attempts].reverse().find((a) => a.account.id === w.accountId)?.account
  const live = isLive(w)
  return {
    ...w,
    prompt: w.prompt.slice(0, 300),
    waitUntil: w.status === 'waiting' ? (w.waitUntil ?? null) : undefined,
    account: ref ? (ref.num === null ? ref.name : `#${ref.num} ${ref.name}`) : null,
    // Working time, not time since it was created: hours spent waiting for an account, or a day
    // between a finished task and its follow-up, are not time it ran.
    ranS: Math.round(
      w.attempts.reduce(
        (sum, a) => sum + Math.max(0, (a.endedAt ?? (live ? now : a.startedAt)) - a.startedAt),
        0,
      ) / 1000,
    ),
    reportedModel: [...w.attempts].reverse().find((a) => a.model)?.model ?? null,
    verdicts: w.verdicts?.map(({ units, ...v }) => ({
      ...v,
      pct: units > 0 ? Math.round((units / UNITS_PER_PRO_PERCENT) * 10) / 10 : null,
    })),
    attempts: w.attempts.map((a) => ({
      account: a.account,
      outcome: a.outcome,
      notice: a.notice,
      requested: a.requested,
      model: a.model,
    })),
  }
}
