// server/src/corch-lib.ts — the PURE half of Corch (docs/CORCH.md): record types, the worker brief,
// and the decisions that must be testable without a process, a timer or the store: how an attempt
// ended, which account takes the next one, how a session moves between accounts. corch.ts (timers,
// store, spawning) imports from here; nothing here starts anything. The one impurity is
// copySessionTranscript, which copies files with node:fs.
//
// classifyAttempt leans on rate-limit-signal.ts and keeps its trusted-places rule: only the CLI's
// own API-error events, an errored terminal `result`, or stderr are evidence of a wall. Model prose
// and tool output never are, or a worker that merely TALKS about a session limit gets walled.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyLimit,
  compactNotice,
  createLimitStopTracker,
  isApiErrorEvent,
  limitEventText,
} from './rate-limit-signal'

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
  costUsd: number // summed over every attempt's `result.total_cost_usd`
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

export const INTERRUPTED_PROMPT =
  'This session was interrupted before it finished: its process was stopped (AgentHydra restarted), not by anything you did. Continue the task exactly where you left off. Do not redo steps that are already finished; run a command again only if its result is missing.'

export const TRANSIENT_PROMPT =
  'The API was overloaded and this turn stopped part-way. Continue the task exactly where you left off. Do not redo steps that are already finished.'

export const INTERRUPTED_NOTICE =
  'Interrupted: the CLI process ended with no result and no error (AgentHydra restarted or the process was killed). Resumed automatically.'

/** Env keys a worker must never inherit: it bills its OWN login, never a borrowed key or token. */
export const ENV_SCRUB =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_\w+|ENTRYPOINT|SSE_PORT|SESSION\w*)|CLAUDECODE|CLAUDE_CONFIG_DIR)$/

const AUTH_RE =
  /please run \/login|not logged in|invalid api key|failed to authenticate|oauth (?:token|session) (?:has )?(?:expired|been revoked)|authentication_error/i

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
  costUsd: number
  turns: number
}

export function classifyAttempt(events: unknown[], stderr: string): AttemptVerdict {
  const tracker = createLimitStopTracker()
  const apiErrors: string[] = [] // CLI-reported API-error events
  let last: any = null // the terminal `result` event
  for (const raw of events) {
    const ev = raw as any
    tracker.observe(ev)
    if (ev?.type === 'result') last = ev
    else if (isApiErrorEvent(ev)) apiErrors.push(limitEventText(ev))
  }
  const errored = last?.is_error === true
  const resultText = typeof last?.result === 'string' ? last.result : null
  const errText = errored ? (resultText ?? '') : ''
  const trusted = [...apiErrors, errText, stderr] // the only places a wall can be read from
  const base = {
    result: resultText,
    costUsd: Number(last?.total_cost_usd) || 0,
    turns: Number(last?.num_turns) || 0,
  }
  const out = (outcome: AttemptOutcome, notice: string | null): AttemptVerdict => ({
    outcome,
    notice: notice ? compactNotice(notice) : null,
    ...base,
  })

  const stop = tracker.verdict()
  if (stop?.pending) return out('quota', stop.notice)
  const quotaText = [errText, stderr].find((t) => classifyLimit(t) === 'quota')
  if (quotaText !== undefined) return out('quota', quotaText)
  const auth = trusted.find((t) => AUTH_RE.test(t))
  if (auth !== undefined) return out('auth', auth)
  const transient = trusted.find((t) => classifyLimit(t) === 'transient')
  if (transient !== undefined) return out('transient', transient)
  if (last && !errored) return out('done', null)
  // No result and no API error: the process was killed from outside. On Windows a daemon restart
  // does exactly this to every worker (they sit in the daemon's kill-on-close job), and the
  // transcript on disk is intact, so the session is resumed rather than failed. Stderr is not
  // required to be empty: a normal run can print a harmless warning there (measured: an MCP OAuth
  // 'issuer' stamp notice), and the retry is bounded at three per turn.
  if (!last && !apiErrors.length) return out('interrupted', INTERRUPTED_NOTICE)
  return out('error', null)
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

export function summarizeEvent(raw: unknown): string | null {
  const ev = raw as any
  if (ev?.type === 'result') {
    const turns = Number(ev.num_turns) || 0
    return `finished (${turns} ${turns === 1 ? 'turn' : 'turns'}, $${(Number(ev.total_cost_usd) || 0).toFixed(2)})`
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
 *  last, so a worker restricted to it resumes once the limit resets or the login works again. */
export function pickAccount(
  worker: Pick<CorchWorker, 'accounts' | 'accountId' | 'attempts'>,
  accounts: CorchAccount[],
  walls: CorchWalls,
  active: Map<string, number>,
  perAccount: number,
  now: number,
  groupActive: Map<string, number> = active,
): CorchAccount | null {
  const lastAttempt = worker.attempts[worker.attempts.length - 1]
  const failedId =
    lastAttempt && (lastAttempt.outcome === 'quota' || lastAttempt.outcome === 'auth')
      ? lastAttempt.account.id
      : null
  const load = (a: CorchAccount): number => active.get(a.id) ?? 0
  const eligible = accounts.filter(
    (a) =>
      (!worker.accounts || worker.accounts.includes(a.id)) &&
      !((walls[a.id]?.until ?? 0) > now) &&
      (a.sessionPct === null || a.sessionPct < 98) &&
      (a.weekPct === null || a.weekPct < 99) &&
      (groupActive.get(a.id) ?? 0) < perAccount &&
      load(a) < MAX_PER_ACCOUNT,
  )
  const home = eligible.find((a) => a.id === worker.accountId && a.id !== failedId)
  if (home) return home
  const score = (a: CorchAccount): number =>
    Math.max(a.sessionPct ?? 50, a.weekPct ?? 50) + 25 * load(a) + (a.id === failedId ? 1000 : 0)
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
