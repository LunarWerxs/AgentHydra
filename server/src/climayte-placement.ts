// server/src/climayte-placement.ts — start a task where it can finish without moving (docs/CLIMAYTE.md
// "Placement"). Pure: climayte.ts gathers the numbers, pickAccount (climayte-lib.ts) scores with them.
//
// WHY (owner, 2026-09-30: "a maximally efficient CliMayte"). Run 1: of 101 attempts only 23 ended
// done; 48 moves, 23 handoffs, 24 limits. A move re-writes the whole conversation into the next
// account's cold cache (a 200k conversation is about 4% of a Pro 5-hour window) and a handoff starts
// a fresh session; cache writes were about a third of what filled the meter. The old score added a
// flat 100 per worker already running on an account, so an idle account at 60% beat one at 10% with
// a worker on it, and 12 workers went four to an account onto three Pro accounts at once: each of
// those tasks costs about a quarter of a Pro window, so they could never all finish there.
//
// The projection: the account's 5-hour usage now, plus what the tasks already running there are
// still expected to spend, plus this task's expected cost. A task goes where it fits; when nowhere
// fits it still goes where the projection is lowest, because waiting hours for a reset is worse
// than finishing part of the work and handing off.

import type { CliMayteAccount } from './climayte-lib'
import { type ScoreRow, UNITS_PER_PRO_PERCENT } from './climayte-scorecard'

/** A task fits on an account when its projected 5-hour usage stays at or under this. */
export const FIT_PCT = 95

/** A task's cost with nothing on record, in % of a Pro 5-hour window. Run 1: code on Opus high
 *  26.6% a task, a sweep on Opus high 35.9%, mechanical on Sonnet medium 0.8%. */
export const DEFAULT_TASK_PCT = 25

/** A worker running on an account: what its task is expected to cost, and the account's 5-hour
 *  usage when its attempt started (null when unknown). */
export interface RunningLoad {
  expected: number
  startPct: number | null
}

/** What pickAccount needs to place one task. */
export interface CliMaytePlacement {
  /** This task's expected cost (expectedPct). */
  expected: number
  /** Per account id, the workers running there now. */
  running: Map<string, RunningLoad[]>
  /** Per account id, what attempts that ended since its first running worker started spent there
   *  (% of a Pro window). */
  finishedSince?: Map<string, number>
}

/** Pro 1, Max 5x 5, Max 20x 20: how many Pro windows an account's 5-hour window holds. */
export function planFactor(planLabel: string | null | undefined): number {
  const m = /max\s*(\d+)/i.exec(planLabel ?? '')
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** The account's 5-hour usage once this task and the work already running there are done, in % of
 *  ITS window. What the running tasks still owe is their expected cost less what they have spent:
 *  the meter's rise since the first of them started, less what attempts that ENDED in that time
 *  spent (`finishedSince`, % of a Pro window, from their recorded tokens). Whatever is left of the
 *  rise is the running tasks' own, however staggered their starts; crediting each task with the
 *  whole rise since its own start would count every concurrent task's spend once per task. Costs
 *  are in % of a Pro window and shrink by the plan. Unknown usage counts as 50%. */
export function projectedPct(
  acct: Pick<CliMayteAccount, 'sessionPct'> & { planFactor?: number },
  running: RunningLoad[],
  expected: number,
  finishedSince = 0,
): number {
  const factor = acct.planFactor ?? 1
  const now = acct.sessionPct ?? 50
  const starts = running.map((r) => r.startPct).filter((p): p is number => p !== null)
  const spent = starts.length ? Math.max(0, now - Math.min(...starts) - finishedSince / factor) : 0
  const owed = Math.max(0, running.reduce((sum, r) => sum + r.expected, 0) / factor - spent)
  return now + owed + expected / factor
}

/** A task's expected cost, in % of a Pro 5-hour window: the scorecard's average for its kind and
 *  setting, else for its kind on any setting, else the average finished task of its model family,
 *  else DEFAULT_TASK_PCT. */
export function expectedPct(
  task: { kind?: string | null; model: string | null; effort: string | null },
  rows: ScoreRow[],
  finished: Array<{ model: string | null; pct: number }>,
): number {
  const avg = (rs: ScoreRow[]): number | null => {
    const n = rs.reduce((s, r) => s + r.pass + r.fail, 0)
    return n ? rs.reduce((s, r) => s + r.units, 0) / n / UNITS_PER_PRO_PERCENT : null
  }
  if (task.kind) {
    const mine = rows.filter((r) => r.kind === task.kind)
    const exact = avg(mine.filter((r) => r.model === task.model && r.effort === task.effort))
    if (exact !== null) return exact
    const kind = avg(mine)
    if (kind !== null) return kind
  }
  const family = (m: string | null): string => (m?.includes('sonnet') ? 'sonnet' : 'opus')
  const same = finished.filter((f) => family(f.model) === family(task.model))
  return same.length ? same.reduce((s, f) => s + f.pct, 0) / same.length : DEFAULT_TASK_PCT
}
