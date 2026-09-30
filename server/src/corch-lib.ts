// server/src/corch-lib.ts — the PURE half of Corch (docs/CORCH.md): record types, the worker brief,
// and the decisions that must be testable without a process, a timer or the store: how an attempt
// ended, which account takes the next one, how a session moves between accounts. corch.ts (timers,
// store, spawning) imports from here; nothing here starts anything. The one impurity is
// copySessionTranscript, which copies files with node:fs.
//
// classifyAttempt leans on rate-limit-signal.ts and keeps its trusted-places rule: only the CLI's
// own API-error events, an errored terminal `result`, or stderr are evidence of a wall. Model prose
// and tool output never are, or a worker that merely TALKS about a session limit gets walled.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceTokens } from './pricing'
import {
  classifyLimit,
  compactNotice,
  createLimitStopTracker,
  isApiErrorEvent,
  limitEventText,
} from './rate-limit-signal'
import { sumTranscriptTokens } from './usage-tokens'

export type CorchStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
// waiting = no eligible account right now (all at their limit or signed out); retried every tick
export type AttemptOutcome =
  | 'running'
  | 'done'
  | 'quota'
  | 'transient'
  | 'auth'
  | 'interrupted' // the CLI ended with no result and no error: killed (a daemon restart), not failed
  | 'error'
  | 'cancelled'

export interface CorchAccountRef {
  id: string
  num: number | null
  name: string
}

export interface CorchAttempt {
  account: CorchAccountRef
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
  overage?: { resetsAt: number | null } // its account ran out and started spending paid extra usage
}

export interface CorchWorker {
  id: string // short id, e.g. 'w-' + 8 hex chars
  group: string // caller-chosen or generated 'g-' + 6 hex; groups one orchestration
  title: string // short label (caller's or the first 60 chars of the prompt)
  cwd: string
  prompt: string // the task as given
  pending: string[] // follow-up messages not yet delivered (FIFO)
  model: string | null
  effort: string | null
  accounts: string[] | null // restrict to these CLI instance ids (null = every signed-in one)
  status: CorchStatus
  sessionId: string | null // minted by Corch before the first launch (`--session-id`)
  accountId: string | null // the account holding the session now
  attempts: CorchAttempt[]
  result: string | null // the final `result` text of the last completed turn
  error: string | null
  lastActivity: string | null // one line: the newest event summarised (summarizeEvent)
  costUsd: number // summed over every attempt's own spend (attemptSpend), from the transcript
  turns: number // summed `result.num_turns`
  moves: number // how many times the session changed account
  retries: number // transient or interrupted retries used in the current turn
  notBefore: number | null // epoch ms; a transient retry waits until then
  revived?: boolean // a message revived it after it stopped: deliver that message next
  createdAt: number
  updatedAt: number
}

export interface CorchAccount {
  id: string
  num: number | null
  name: string
  configDir: string
  sessionPct: number | null
  weekPct: number | null
}

/** `cred` (signed-out walls only): the mtime of the account's `.credentials.json` when it was
 *  walled, so a sign-in that rewrites the file is noticed before the wall runs out. */
export type CorchWalls = Record<string, { until: number; reason: string; cred?: number | null }>

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
export interface CorchLiveUsage {
  sessionPct: number | null
  sessionResetsAt: number | null
  weekPct: number | null
  weekResetsAt: number | null
  at: number
}

/** The usage every main-agent `rate_limit_event` carries, measured in real logs:
 *  `{"status":"allowed","rateLimitType":"five_hour","resetsAt":1790803800,"overageStatus":"allowed",
 *  "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.52,"resetsAt":1790803800},
 *  "seven_day":{"utilization":0.03,"resetsAt":1791356400}}}` (utilization 0..1, resetsAt epoch
 *  seconds). Null for any other event, or one with neither window. */
export function liveUsage(raw: unknown, at: number): CorchLiveUsage | null {
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
    at,
  }
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
export type CorchWorkerView = Omit<CorchWorker, 'prompt' | 'attempts'> & {
  prompt: string // first 300 chars
  account: string | null // `#<num> <name>`
  elapsedS: number
  attempts: Array<{ account: CorchAccountRef; outcome: AttemptOutcome; notice: string | null }>
}

export const WORKER_BRIEF =
  "You are a Corch worker: a Claude Code CLI session that AgentHydra started on one of the owner's accounts, at the owner's request, to do one delegated task for an orchestrating chat. Do the whole task yourself, in this session. Nobody is watching to answer questions, so make the reasonable call and say which call you made. Follow the repository's own rules. Commit only the files you changed, and push if the repository's rules say to. Never read or print a secret value. End with a short report: what you did, the proof you saw (a command and what it printed), and anything left undone with the reason."

export const HANDOFF_PROMPT =
  'This session was moved to another account because the previous one reached its usage limit or was signed out. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const PAUSED_PROMPT =
  'This session was paused because its account reached its usage limit or was signed out, and it can continue now on the same account. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const INTERRUPTED_PROMPT =
  'This session was interrupted before it finished: its process was stopped (AgentHydra restarted), not by anything you did. Continue the task exactly where you left off. Do not redo steps that are already finished; run a command again only if its result is missing.'

export const TRANSIENT_PROMPT =
  'The API was overloaded and this turn stopped part-way. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const OVERAGE_NOTICE =
  "The account's 5-hour limit ran out and it started spending paid extra usage, so Corch stopped the turn and moved the session to an account with free quota."

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

export function scrubbedEnv(configDir: string, workerId?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !ENV_SCRUB.test(k)) env[k] = v
  }
  env.CLAUDE_CONFIG_DIR = configDir
  if (workerId) env.AGENTHYDRA_CORCH_WORKER = workerId
  return env
}

export interface AttemptVerdict {
  outcome: AttemptOutcome
  notice: string | null
  result: string | null
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
  for (const raw of events) {
    const ev = raw as any
    if (ev?.parent_tool_use_id) continue
    tracker.observe(ev)
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
 *  only pricing Corch uses. The CLI's `result.total_cost_usd` cannot be: on a resumed session it is
 *  the WHOLE session's cost so far (measured 2026-09-30: a one-turn follow-up after a $4.67 turn
 *  reported $6.44 = $4.67 + $1.77), so adding it per attempt counted every earlier turn again on
 *  every follow-up, handoff and resume. A killed or stopped attempt writes no result at all, and
 *  its stream-json log under-reports output; the transcript has both right (this reproduces the
 *  CLI's own figures to the cent). Turns copied in from another account keep their older
 *  timestamps, so they are not counted again. 0 when the transcript is not there. */
export function attemptSpend(
  configDir: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
): number {
  const root = join(configDir, 'projects')
  let text = ''
  try {
    for (const d of readdirSync(root)) {
      const file = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(file)) {
        text = readFileSync(file, 'utf8')
        break
      }
    }
  } catch {
    return 0
  }
  if (!text) return 0
  // Everything from the start, minus everything after the end: pricing is linear per model.
  const cost = (since: number) =>
    priceTokens(sumTranscriptTokens(text, since).byModel, startedAt).costUsd ?? 0
  return Math.max(0, cost(startedAt) - cost(endedAt + 1))
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

/** `perAccount` caps this group's workers (`groupActive`, default `active`) on an account;
 *  `active` counts every group's and is held under MAX_PER_ACCOUNT. The account of a last
 *  quota/auth attempt is not excluded (its wall keeps it out while the wall is real), only tried
 *  last, so a worker restricted to it resumes once the limit resets or the login works again.
 *  `allowFull` (the owner allowed paid extra usage): accounts at or above the 98% session / 99%
 *  weekly caps stay eligible, but only after every account below them. */
export function pickAccount(
  worker: Pick<CorchWorker, 'accounts' | 'accountId' | 'attempts'>,
  accounts: CorchAccount[],
  walls: CorchWalls,
  active: Map<string, number>,
  perAccount: number,
  now: number,
  groupActive: Map<string, number> = active,
  allowFull = false,
): CorchAccount | null {
  const lastAttempt = worker.attempts[worker.attempts.length - 1]
  const failedId =
    lastAttempt && (lastAttempt.outcome === 'quota' || lastAttempt.outcome === 'auth')
      ? lastAttempt.account.id
      : null
  const load = (a: CorchAccount): number => active.get(a.id) ?? 0
  const full = (a: CorchAccount): boolean =>
    (a.sessionPct !== null && a.sessionPct >= 98) || (a.weekPct !== null && a.weekPct >= 99)
  const eligible = accounts.filter(
    (a) =>
      (!worker.accounts || worker.accounts.includes(a.id)) &&
      !((walls[a.id]?.until ?? 0) > now) &&
      (allowFull || !full(a)) &&
      (groupActive.get(a.id) ?? 0) < perAccount &&
      load(a) < MAX_PER_ACCOUNT,
  )
  // A full home is kept only when every other choice is full too.
  const home = eligible.find(
    (a) => a.id === worker.accountId && a.id !== failedId && (!full(a) || eligible.every(full)),
  )
  if (home) return home
  const score = (a: CorchAccount): number =>
    Math.max(a.sessionPct ?? 50, a.weekPct ?? 50) +
    25 * load(a) +
    (full(a) ? 500 : 0) +
    (a.id === failedId ? 1000 : 0)
  const byNum = (a: CorchAccount): number => a.num ?? Number.MAX_SAFE_INTEGER
  eligible.sort((a, b) => score(a) - score(b) || byNum(a) - byNum(b))
  return eligible[0] ?? null
}

/** Copy a session transcript (and its sibling dir) between config dirs so `--resume` finds it.
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
    cpSync(file, join(dest, `${sessionId}.jsonl`))
    const dir = join(root, d.name, sessionId)
    if (existsSync(dir)) cpSync(dir, join(dest, sessionId), { recursive: true })
    return true
  }
  return false
}

export function toView(w: CorchWorker, now: number): CorchWorkerView {
  const ref = [...w.attempts].reverse().find((a) => a.account.id === w.accountId)?.account
  const live = w.status === 'queued' || w.status === 'running' || w.status === 'waiting'
  return {
    ...w,
    prompt: w.prompt.slice(0, 300),
    account: ref ? (ref.num === null ? ref.name : `#${ref.num} ${ref.name}`) : null,
    elapsedS: Math.max(0, Math.round(((live ? now : w.updatedAt) - w.createdAt) / 1000)),
    attempts: w.attempts.map((a) => ({ account: a.account, outcome: a.outcome, notice: a.notice })),
  }
}
