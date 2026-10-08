// server/src/climayte-view.ts — CliMayte read from outside: capacity, the journal, the worker list
// and its lean views, reports, one worker (climayteGet), waiting on one (climayteWait), a handoff's
// text, the model pick and the scorecard. Split from climayte.ts on 2026-10-08; nothing here
// imports it.

import { installStatusView } from './claude-install-guard'
import { accountsProvider, isActive, JOURNAL_PATH, listeners, load, workers } from './climayte-core'
import {
  type EtaBandCalibration,
  type EtaCalibration,
  type EtaPromptStats,
  etaBandCalibrations,
  etaCalibration,
  etaNote,
  etaPromptStats,
  etaRewriteDue,
} from './climayte-eta'
import { allEtaSamples, etaReport } from './climayte-eta-ledger'
import {
  appendJournal,
  type CliMayteJournalEntry,
  formatJournalLine,
  type JournalFilter,
  readJournal,
} from './climayte-journal'
import {
  type CliMayteAccount,
  type CliMayteWave,
  type CliMayteWorker,
  type CliMayteWorkerBrief,
  type CliMayteWorkerReport,
  type CliMayteWorkerView,
  recentWorkers,
  toBrief,
  toReport,
  toView,
} from './climayte-lib'
import { roomNow, tickState } from './climayte-schedule'
import {
  CLIMAYTE_LADDER,
  type CliMayteKind,
  climayteKind,
  ladderIndex,
  ladderModel,
  pickedRung,
  scoreOf,
  scoreRows,
  UNITS_PER_PRO_PERCENT,
} from './climayte-scorecard'
import { attemptExited, finishedLines, readLog, signalWindDown } from './climayte-stops'

/** The room CliMayte has right now, for an agent deciding whether to hand work over (check_my_usage
 *  and list_usage say it): `idle`, the accounts running no CliMayte worker that placement would
 *  start an ordinary new task on right now (roomNow), and `waiting`, the tasks already queued or
 *  waiting, with the earliest time one of them is due to start. Owner, 2026-10-02: ten accounts sat
 *  idle for six hours while every chat did its own work. The same day at 04:58 it answered idle 9
 *  with 24 tasks waiting: it counted every account under the stop lines, and placement held them
 *  all. */
export function climayteCapacity(now = Date.now()): {
  idle: number
  accounts: number
  running: number
  waiting: number
  waitUntil: string | null
  /** Whether a Claude Code CLI can be started: false holds every task (claude-install-guard.ts). */
  claudeInstall: ReturnType<typeof installStatusView>
} {
  load()
  let accounts: CliMayteAccount[] = []
  try {
    accounts = accountsProvider()
  } catch {
    // no readable pool: no room to report
  }
  const busy = new Set<string>()
  const until: string[] = []
  let running = 0
  let waiting = 0
  for (const w of workers.values()) {
    if (w.status === 'queued' || w.status === 'waiting') {
      waiting++
      if (w.status === 'waiting' && w.waitUntil) until.push(w.waitUntil)
    }
    if (w.status !== 'running') continue
    running++
    if (w.accountId) busy.add(w.accountId)
  }
  const idle = roomNow(tickState(accounts, now)).filter((a) => !busy.has(a.id)).length
  return {
    idle,
    accounts: accounts.length,
    running,
    waiting,
    waitUntil: until.sort()[0] ?? null,
    claudeInstall: installStatusView(),
  }
}

/** The journal in scope, oldest first (the newest `limit`, default 100). */
export function climayteJournal(filter: JournalFilter = {}): CliMayteJournalEntry[] {
  return readJournal(JOURNAL_PATH, filter)
}

/** The same entries as readable one-line strings (formatJournalLine), newest last. */
export function climayteJournalLines(filter: JournalFilter = {}): string[] {
  const now = new Date()
  return climayteJournal(filter).map((e) => formatJournalLine(e, now))
}

/** A journal line about an account rather than a worker: the keepalive's nudges (usage-refresh.ts),
 *  under id and group 'keepalive', so `climayte_log { group: 'keepalive' }` lists them and a run's
 *  log shows when an idle account's window was started beside the work placed on it. */
export function climayteJournalNudge(
  details: Omit<Partial<CliMayteJournalEntry>, 'ts' | 'id' | 'group' | 'title' | 'event'>,
): void {
  appendJournal(JOURNAL_PATH, {
    ts: new Date().toISOString(),
    id: 'keepalive',
    group: 'keepalive',
    title: 'Start the 5-hour window',
    event: 'nudged',
    ...details,
  })
}

export function onCliMayteChange(cb: (w: CliMayteWorker) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function matches(
  w: CliMayteWorker,
  f: { group?: string; id?: string; ids?: string[]; active?: boolean },
): boolean {
  return (
    (!f.id || w.id === f.id) &&
    (!f.ids || f.ids.includes(w.id)) &&
    (!f.group || w.group === f.group) &&
    (!f.active || isActive(w))
  )
}

/** `limit`: keep every active worker and only the `limit` most recently finished ones
 *  (recentWorkers); `brief`: rows without the prompt and with the last 3 attempts (toBrief);
 *  `ids`: only these workers. */
export interface CliMayteListFilter {
  group?: string
  id?: string
  ids?: string[]
  active?: boolean
  limit?: number
  brief?: boolean
  /** With `brief`: also list finished work a verdict already covers (left out by default). */
  all?: boolean
}

export function climayteList(filter: CliMayteListFilter & { brief: true }): CliMayteWorkerBrief[]

export function climayteList(filter?: CliMayteListFilter): CliMayteWorkerView[]

export function climayteList(
  filter: CliMayteListFilter = {},
): CliMayteWorkerView[] | CliMayteWorkerBrief[] {
  load()
  const now = Date.now()
  const views = recentWorkers(
    [...workers.values()].filter((w) => matches(w, filter)),
    filter.limit,
  ).map((w) => toView(w, now))
  if (!filter.brief) return views
  // An orchestrator's default list is what it may act on: live work and unjudged results. Judged
  // finished rows were 80 KB of a 96 KB default answer (stress review, 2026-10-02).
  const keep =
    filter.all || filter.id || filter.ids?.length
      ? views
      : views.filter((v) => isLiveStatus(v.status) || !v.judged)
  return keep.map(toBrief)
}

/** `lean=1` on the workers list (Desk 2's server and pane): the same rows without the long text no list
 *  row shows. `result`, `results` and `reports` become `resultChars` (the detail route has them);
 *  each attempt keeps its account, outcome, ceiling flag and tokens; each verdict keeps who, what and
 *  the first line of its note (the row's hover). Everything else, the 300-character prompt included,
 *  stays. */
export function climayteLeanWorker(v: CliMayteWorkerView): Omit<
  CliMayteWorkerView,
  'results' | 'reports' | 'attempts' | 'verdicts'
> & {
  attempts: Array<
    Pick<CliMayteWorkerView['attempts'][number], 'account' | 'outcome' | 'tokens'> & {
      ceiling?: true
    }
  >
  verdicts?: Array<
    Omit<NonNullable<CliMayteWorkerView['verdicts']>[number], 'note'> & { note: string | null }
  >
  resultChars: number
} {
  const { results, reports: _reports, ...row } = v
  const text = results?.length ? results : v.result ? [v.result] : []
  return {
    ...row,
    result: null,
    resultChars: text.reduce((n, r) => n + r.length, 0),
    attempts: v.attempts.map((a) => ({
      account: a.account,
      outcome: a.outcome,
      tokens: a.tokens,
      ...(a.ceiling ? { ceiling: true as const } : {}),
    })),
    verdicts: v.verdicts?.map((x) => ({
      ...x,
      note: x.note ? (x.note.split('\n', 1)[0] ?? '').slice(0, 200) : null,
    })),
  }
}

/** `lean=1` on the waves list: each task without its `prompt` and `check` command (the wave's `notes`
 *  scratch too); the keys, titles, states, paths, proof, escalations and report a list shows stay. */
export function climayteLeanWave(w: CliMayteWave): CliMayteWave {
  return {
    ...w,
    notes: '',
    tasks: w.tasks.map((t) => ({ ...t, prompt: '', check: null })),
  }
}

const isLiveStatus = (s: CliMayteWorker['status']): boolean =>
  s === 'queued' || s === 'running' || s === 'waiting' || s === 'checking'

/** The report view of the same list (toReport): one compact row per worker, `chars` of its report. */
export function climayteReports(
  filter: CliMayteListFilter = {},
  chars?: number,
): CliMayteWorkerReport[] {
  return climayteList({ ...filter, brief: false }).map((v) => toReport(v, chars))
}

/** `fullPrompt`: the whole brief instead of the views' first 300 characters, for a window showing the
 *  task (Desk 2's CliMayte pane). Off by default, so a chat reading a task over MCP is not handed back
 *  the brief it wrote. */
export function climayteGet(
  id: string,
  opts: { fullPrompt?: boolean } = {},
): (CliMayteWorkerView & { events: string[] }) | null {
  load()
  const w = workers.get(id)
  if (!w) return null
  // Every attempt's summary lines, oldest first, each under one separator line, so the work before
  // a move or a restart stays visible. A finished attempt keeps only its summary lines
  // (finishedLines), never its parsed events; attempts older than the newest 60 lines are not read.
  const events: string[] = []
  for (let i = w.attempts.length - 1; i >= 0 && events.length < 60; i--) {
    const a = w.attempts[i]!
    const who = a.account.num === null ? a.account.name : `#${a.account.num} ${a.account.name}`
    const lines = a.outcome === 'running' ? readLog(a).recent : finishedLines(a.log)
    events.unshift(`— attempt ${i + 1} on ${who}: ${a.outcome} —`, ...lines)
  }
  return {
    ...toView(w, Date.now()),
    ...(opts.fullPrompt ? { prompt: w.prompt } : {}),
    events: events.slice(-60),
  }
}

export function climayteWait(
  filter: CliMayteListFilter,
  timeoutMs: number,
): Promise<CliMayteWorkerView[] | CliMayteWorkerBrief[]> {
  load()
  if (![...workers.values()].some((w) => matches(w, filter) && isActive(w)))
    return Promise.resolve(climayteList(filter))
  return new Promise((resolve) => {
    const off = onCliMayteChange((w) => {
      if (!matches(w, filter)) return
      done()
    })
    const t = setTimeout(() => done(), Math.max(0, timeoutMs))
    let settled = false
    function done(): void {
      if (settled) return
      settled = true
      clearTimeout(t)
      off()
      resolve(climayteList(filter))
    }
  })
}

/** Hand a running task to a fresh session now, the same way a worker near its limit does: it
 *  finishes the step it is on, writes a handoff, and the task goes on from that handoff in a new
 *  session (on the account with the most room). For freeing an account, or giving a task whose
 *  conversation has grown huge a clean start without losing where it was. */
export function climayteHandoff(id: string): { ok: boolean; message: string } {
  load()
  const w = workers.get(id)
  if (!w) return { ok: false, message: 'No such worker.' }
  const at = w.attempts[w.attempts.length - 1]
  if (w.status !== 'running' || !at || attemptExited(w, at))
    return { ok: false, message: 'Only a running worker can hand off; this one is not running.' }
  if (at.windDown) return { ok: true, message: 'It is already winding down.' }
  if (w.sealed)
    return {
      ok: false,
      message: 'A sealed worker has no Write tool, so it cannot write a handoff.',
    }
  signalWindDown(w, at, { reason: 'request' })
  return {
    ok: true,
    message:
      'Asked to wrap up after its current step and write a handoff; the task then continues in a fresh session.',
  }
}

/** The model an auto task of `kind` runs on now (the scorecard's pick, the Haiku trial's while it runs). The
 *  cost router prices CliMayte work at it: work on a signed-in account costs the plan's share of what that model
 *  lists at, never another model's list price (owner, 2026-10-07: CliMayte gets the plan's discounted rate). */
export function climaytePickModel(kind: CliMayteKind): string {
  load()
  return CLIMAYTE_LADDER[pickedRung(kind, scoreRows(workers.values()))]!.model
}

/** What works, per kind of task: every verdict on record summed by setting, with what a task cost
 *  on average as a share of a Pro 5-hour window, and the setting an `auto` task of that kind gets
 *  next (`pick`; an exploring pick one rung cheaper is not marked). */
export function climayteScorecard(): {
  unitsPerPercent: number
  rows: Array<{
    kind: string
    model: string | null
    effort: string | null
    pass: number
    fail: number
    slip: number
    rework: number
    failed: number
    excluded: number
    /** Credit over scored verdicts (scoreOf); null with none scored. */
    score: number | null
    pctPerTask: number | null
    pick: boolean
  }>
  /** How the workers' own time estimates compared with the time they took (climayte-eta.ts): every
   *  kind's, each kind's with enough samples, and the note the next brief carries. */
  estimates: {
    all: EtaCalibration | null
    byKind: EtaCalibration[]
    byBand: EtaBandCalibration[]
    byPrompt: EtaPromptStats[]
    rewriteDue: { version: number; why: string } | null
    note: string | null
  } & ReturnType<typeof etaReport>
} {
  load()
  const rows = scoreRows(workers.values())
  const samples = allEtaSamples(workers.values())
  const all = etaCalibration(samples, null)
  const byBand = etaBandCalibrations(samples)
  const byPrompt = etaPromptStats(samples)
  const byKind = [...new Set(samples.map((s) => s.kind).filter((k): k is string => !!k))]
    .map((k) => etaCalibration(samples, k))
    .filter((c): c is EtaCalibration => c?.kind != null)
  const picks = new Map<string, number>()
  for (const r of rows) {
    if (picks.has(r.kind)) continue
    try {
      const k = climayteKind(r.kind)
      if (k) picks.set(r.kind, pickedRung(k, rows))
    } catch {
      // a kind no longer on the list: shown, never picked
    }
  }
  return {
    unitsPerPercent: UNITS_PER_PRO_PERCENT,
    rows: rows.map((r) => {
      const n = r.pass + r.fail
      const best = picks.get(r.kind)
      return {
        kind: r.kind,
        model: r.model,
        effort: r.effort,
        pass: r.pass,
        fail: r.fail,
        slip: r.slip,
        rework: r.rework,
        failed: r.failed,
        excluded: r.excluded,
        score: scoreOf(r),
        pctPerTask: n ? Math.round((r.units / n / UNITS_PER_PRO_PERCENT) * 10) / 10 : null,
        pick:
          best !== undefined &&
          ladderIndex({ model: ladderModel(r.model), effort: r.effort }) === best,
      }
    }),
    estimates: {
      all,
      byKind,
      byBand,
      byPrompt,
      rewriteDue: etaRewriteDue(byPrompt),
      note: etaNote(all, samples, byBand),
      ...etaReport(samples),
    },
  }
}
