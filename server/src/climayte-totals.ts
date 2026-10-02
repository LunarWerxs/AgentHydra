// climayteTotals: what CliMayte has taken off the chats that handed it work, summed over the
// record (or since a moment). Split out of climayte.ts so each file can be read whole; it reads
// climayte-core.ts's workers.
import { acctLabel, lastThatRan, load, pct1, workers } from './climayte-core'
import { addTokens, type CliMayteTokens, type CliMayteWorker, noTokens } from './climayte-lib'
import { attemptUnits, rereadUnits } from './climayte-scorecard'

type TotalsAttempt = CliMayteWorker['attempts'][number]

type CeilingStop = {
  id: string
  title: string
  account: string
  at: string
  pct: number
  askedPct: number | null
  workers: number
  t: number
}

type LimitHit = {
  id: string
  title: string
  account: string
  at: string
  pct: number | null
  t: number
}

type WindowPeak = {
  account: string
  resetsAt: number | null
  peakPct: number
  runs: number
  t: number
}

type SizedTask = { id: string; title: string; expected: number; used: number; work: number }

/** climayteTotals' running sums. With `since`, every figure covers only runs that ended after it
 *  (or are running); without, the whole record, as the CliMayte view's counter shows it. */
interface TotalsTally {
  since: number
  sessions: number
  costUsd: number
  tokens: CliMayteTokens
  used: number
  reread: number
  unmeasured: number
  byCause: Partial<Record<TotalsAttempt['outcome'], number>>
  ceilingStops: number
  ceilings: CeilingStop[]
  /** Every attempt on record: a ceiling stop says how many runs were on its account then. */
  allAttempts: TotalsAttempt[]
  tasksInScope: Set<string>
  hits: LimitHit[]
  peaks: Map<string, WindowPeak>
  runsByOutcome: Partial<Record<TotalsAttempt['outcome'] | 'ceiling', number>>
  distinct: Set<string>
}

/** How many runs were on an account at a moment, the one that asks included. */
const runsOnAccount = (all: TotalsAttempt[], accountId: string, t: number): number =>
  all.filter(
    (a) =>
      a.account.id === accountId && a.startedAt <= t && (a.endedAt ?? Number.MAX_SAFE_INTEGER) >= t,
  ).length

/** Over the whole record a task counts with its own sums; with `since` it only counts as a task
 *  when it was created after it (its runs are counted one by one, tallyRecentRun). */
function tallyTask(tally: TotalsTally, w: CliMayteWorker): void {
  if (!tally.since) {
    tally.sessions += w.attempts.length
    tally.costUsd += w.costUsd
    if (w.tokens) tally.tokens = addTokens(tally.tokens, w.tokens)
    tally.tasksInScope.add(w.id)
  } else if (w.createdAt >= tally.since) tally.tasksInScope.add(w.id)
}

function tallyRecentRun(tally: TotalsTally, w: CliMayteWorker, at: TotalsAttempt): void {
  if (!tally.since) return
  tally.sessions++
  tally.costUsd += at.spend?.costUsd ?? 0
  if (at.tokens) tally.tokens = addTokens(tally.tokens, at.tokens)
  tally.tasksInScope.add(w.id)
}

/** A run stopped at CliMayte's ceiling, or one that ran into the account's own limit. */
function tallyStops(tally: TotalsTally, w: CliMayteWorker, at: TotalsAttempt): void {
  if (at.ceiling) {
    tally.ceilingStops++
    const t = at.endedAt ?? Date.now()
    tally.ceilings.push({
      id: w.id,
      title: w.title,
      account: acctLabel(at.account),
      at: new Date(t).toISOString(),
      pct: at.ceiling.pct,
      askedPct: at.windDown ? at.windDown.pct : null,
      workers: runsOnAccount(tally.allAttempts, at.account.id, t),
      t,
    })
  }
  if (at.outcome === 'quota' && !at.ceiling)
    tally.hits.push({
      id: w.id,
      title: w.title,
      account: acctLabel(at.account),
      at: new Date(at.endedAt ?? at.startedAt).toISOString(),
      pct: at.peak?.pct ?? null,
      t: at.endedAt ?? at.startedAt,
    })
}

/** An account's highest 5-hour reading per window, over the runs CliMayte had on it. */
function tallyPeak(tally: TotalsTally, at: TotalsAttempt): void {
  if (!at.peak) return
  const key = `${at.account.id}|${at.peak.resetsAt ?? ''}`
  const p = tally.peaks.get(key) ?? {
    account: acctLabel(at.account),
    resetsAt: at.peak.resetsAt,
    peakPct: 0,
    runs: 0,
    t: 0,
  }
  p.peakPct = Math.max(p.peakPct, at.peak.pct)
  p.runs++
  p.t = Math.max(p.t, at.endedAt ?? Date.now())
  tally.peaks.set(key, p)
}

function tallyUsage(tally: TotalsTally, w: CliMayteWorker, at: TotalsAttempt): void {
  const shown = at.ceiling && at.outcome === 'quota' ? 'ceiling' : at.outcome
  tally.runsByOutcome[shown] = (tally.runsByOutcome[shown] ?? 0) + 1
  tally.used += attemptUnits(at.tokens, at.model ?? w.model, at.cacheTtl)
  if (at.endedAt !== null && !at.spend) tally.unmeasured++
  const r = rereadUnits(at, w.model)
  // What stopped the last run that ran: a refused sign-in in between re-read nothing itself.
  const cause = lastThatRan(w, at)?.outcome
  if (r > 0 && cause) {
    tally.reread += r
    tally.byCause[cause] = (tally.byCause[cause] ?? 0) + r
  }
}

function tallyConversation(tally: TotalsTally, w: CliMayteWorker, at: TotalsAttempt): void {
  // A run the account refused before the CLI started holds no conversation.
  const spent = at.tokens ? at.tokens.cacheRead + at.tokens.cacheWrite + at.tokens.input : 0
  if (!at.started && spent === 0) return
  const sid = at.sessionId ?? w.sessionId
  if (sid) tally.distinct.add(sid)
}

function tallyAttempt(tally: TotalsTally, w: CliMayteWorker, at: TotalsAttempt): void {
  const recent = (at.endedAt ?? Date.now()) >= tally.since
  if (!recent) return
  tallyRecentRun(tally, w, at)
  tallyStops(tally, w, at)
  tallyPeak(tally, at)
  tallyUsage(tally, w, at)
  tallyConversation(tally, w, at)
}

/** Finished tasks that were sized, since `since`: what each was expected to cost against what it
 *  used, with and without its re-reads. */
function sizedTasks(since: number): SizedTask[] {
  const sized: SizedTask[] = []
  for (const w of workers.values()) {
    if (w.status !== 'done' || !w.size || w.createdAt < since) continue
    const all = w.attempts.reduce(
      (s, a) => s + attemptUnits(a.tokens, a.model ?? w.model, a.cacheTtl),
      0,
    )
    const rr = w.attempts.reduce((s, a) => s + rereadUnits(a, w.model), 0)
    sized.push({
      id: w.id,
      title: w.title,
      expected: w.size.expected,
      used: pct1(all),
      work: pct1(all - rr),
    })
  }
  return sized
}

function sizingOf(sized: SizedTask[]): ReturnType<typeof climayteTotals>['sizing'] {
  const sum = (k: 'expected' | 'used' | 'work'): number =>
    Math.round(sized.reduce((s, x) => s + x[k], 0) * 10) / 10
  return {
    tasks: sized.length,
    expectedPct: sum('expected'),
    usedPct: sum('used'),
    workPct: sum('work'),
    ratio: sum('expected') > 0 ? Math.round((sum('used') / sum('expected')) * 100) / 100 : null,
    list: sized.slice(-50),
  }
}

/** What CliMayte has taken off the chats that handed it work: tasks, the CLI sessions they ran
 *  (attempts), their tokens and cost (the CliMayte view's counter), over every task on record, or
 *  with `since` over the runs that ended after it (a night's re-read share, not the record's). */
export function climayteTotals(since = 0): {
  tasks: number
  /** Attempts ("runs"): every start of the CLI, retries, resumes and handoffs included. */
  sessions: number
  /** Those runs by how they ended (owner, 2026-09-30: "99 CLI sessions" read as 99 sessions when
   *  23 were handoffs, 21 stopped at a limit, 8 resumed after a restart and 7 never signed in). */
  runsByOutcome: Partial<Record<CliMayteWorker['attempts'][number]['outcome'] | 'ceiling', number>>
  /** Distinct CLI conversations: a resume, a follow-up or a move continues one; a handoff starts one. */
  cliSessions: number
  tokens: CliMayteTokens
  costUsd: number
  /** Usage over every attempt in % of a Pro 5-hour window, the part of it that re-read a
   *  conversation into a cold cache at the start of an attempt after one that ran (restart
   *  overhead), that part as a share of the whole (%), and by what ended the attempt before it
   *  (`done`: a follow-up after the task had finished). `unmeasured`: ended attempts whose
   *  transcript could not be read, so their re-read is not in these figures. */
  usedPct: number
  rereadPct: number
  rereadShare: number
  rereadByCause: Partial<Record<CliMayteWorker['attempts'][number]['outcome'], number>>
  unmeasured: number
  /** The test metrics (owner, 2026-10-01: the goal is to stop each account at 85-90% of its
   *  5-hour window, never at its limit), over attempts and tasks since `since` (epoch ms; 0 = all):
   *  `limitHits` runs that ended at a usage limit (target 0), with the newest ones listed; `peaks`
   *  each account's highest 5-hour usage per window while CliMayte ran on it (target 85-90, never
   *  100), newest first; `sizing` finished tasks' expected cost against what they used, both in %
   *  of a Pro window (`ratio` above 1: estimates run low). */
  since: string | null
  limitHits: number
  /** Runs stopped at CliMayte's ceiling (90%) instead: the stop line (85) was not enough. */
  ceilingStops: number
  /** The newest ceiling stops: the reading that stopped it, the reading it was asked to hand off at
   *  (null: never asked), and how many runs were on that account at that moment, itself included. */
  ceilingStopList: Array<{
    id: string
    title: string
    account: string
    at: string
    pct: number
    askedPct: number | null
    workers: number
  }>
  limitHitList: Array<{
    id: string
    title: string
    account: string
    at: string
    pct: number | null
  }>
  peaks: Array<{ account: string; resetsAt: string | null; peakPct: number; runs: number }>
  sizing: {
    tasks: number
    expectedPct: number
    usedPct: number
    workPct: number
    ratio: number | null
    list: Array<{ id: string; title: string; expected: number; used: number; work: number }>
  }
} {
  load()
  const tally: TotalsTally = {
    since,
    sessions: 0,
    costUsd: 0,
    tokens: noTokens(),
    used: 0,
    reread: 0,
    unmeasured: 0,
    byCause: {},
    ceilingStops: 0,
    ceilings: [],
    allAttempts: [...workers.values()].flatMap((w) => w.attempts),
    tasksInScope: new Set<string>(),
    hits: [],
    peaks: new Map<string, WindowPeak>(),
    runsByOutcome: {},
    distinct: new Set<string>(),
  }
  for (const w of workers.values()) {
    tallyTask(tally, w)
    for (const at of w.attempts) tallyAttempt(tally, w, at)
  }
  const sized = sizedTasks(since)
  return {
    tasks: tally.tasksInScope.size,
    sessions: tally.sessions,
    runsByOutcome: tally.runsByOutcome,
    cliSessions: tally.distinct.size,
    tokens: tally.tokens,
    costUsd: tally.costUsd,
    usedPct: pct1(tally.used),
    rereadPct: pct1(tally.reread),
    rereadShare: tally.used > 0 ? Math.round((tally.reread / tally.used) * 1000) / 10 : 0,
    rereadByCause: Object.fromEntries(
      Object.entries(tally.byCause).map(([k, v]) => [k, pct1(v ?? 0)]),
    ) as Partial<Record<CliMayteWorker['attempts'][number]['outcome'], number>>,
    unmeasured: tally.unmeasured,
    since: since ? new Date(since).toISOString() : null,
    limitHits: tally.hits.length,
    ceilingStops: tally.ceilingStops,
    ceilingStopList: tally.ceilings
      .sort((a, b) => b.t - a.t)
      .slice(0, 20)
      .map(({ t: _t, ...c }) => c),
    limitHitList: tally.hits
      .sort((a, b) => b.t - a.t)
      .slice(0, 20)
      .map(({ t: _t, ...h }) => h),
    peaks: [...tally.peaks.values()]
      .sort((a, b) => b.t - a.t)
      .map(({ t: _t, resetsAt, ...p }) => ({
        ...p,
        resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null,
      })),
    sizing: sizingOf(sized),
  }
}
