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
import { modelMultiplier } from './usage-tokens'

/** A task fits on an account when its projected 5-hour usage stays at or under this: the stop line
 *  (climayte-lib WIND_DOWN_SESSION_PCT), so a task is started only where it is expected to finish
 *  before the account is asked to stop (owner, 2026-10-01: "The goal is to NOT hit 'limit' ... at
 *  85/90%"). It was 95, which started tasks that the line then stopped partway. */
export const FIT_PCT = 85

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

/** A task's expected cost and where the number came from. */
export interface CostEstimate {
  /** % of a Pro 5-hour window. */
  pct: number
  /** 'setting' (its kind on its model and effort), 'kind-model' (its kind on its model family at
   *  other efforts), 'kind' (its kind on other models, scaled to its model), 'model' (finished tasks
   *  of its model family) or 'default'. */
  basis: 'setting' | 'kind-model' | 'kind' | 'model' | 'default'
  /** How many finished tasks the average is over (0 for the default). */
  samples: number
}

/** A model's family; the CLI default (null) is Opus. */
export const modelFamily = (m: string | null): 'sonnet' | 'opus' =>
  m?.includes('sonnet') ? 'sonnet' : 'opus'

/** A finished task's work (its re-reads left out), in % of a Pro 5-hour window, and its setting. */
export interface FinishedCost {
  kind: string | null
  model: string | null
  effort: string | null
  pct: number
}

/** How many tasks' worth of weight the broader estimate keeps against a narrower one's record: one
 *  finished task moves the estimate a third of the way to it, ten nearly all the way. */
export const PRIOR_WEIGHT = 2

/** A task's expected cost, in % of a Pro 5-hour window, from finished tasks (judged or not: what a
 *  task cost needs no verdict). From the broadest record to the narrowest: DEFAULT_TASK_PCT, its
 *  model family's tasks of any kind, its kind on any model scaled to its own (modelMultiplier: an
 *  Opus token weighs twice a Sonnet one), its kind on its family, its kind on its exact model and
 *  effort. Each pulls the estimate toward its own average by how many tasks it has against
 *  PRIOR_WEIGHT, so a setting with a few tasks blends in instead of taking over at once.
 *  (2026-10-01: Sonnet medium code ran 3.9-6.1% while its estimate stayed at 13.7, the scaled
 *  average of Opus code, because those tasks carried no verdict and the estimate read verdicts.) */
export function expectedCost(
  task: { kind?: string | null; model: string | null; effort: string | null },
  finished: FinishedCost[],
): CostEstimate {
  const own = modelMultiplier(task.model ?? 'claude-opus-5-5')
  const scaled = (f: FinishedCost): number =>
    (f.pct * own) / modelMultiplier(f.model ?? 'claude-opus-5-5')
  const family = finished.filter((f) => modelFamily(f.model) === modelFamily(task.model))
  const kind = task.kind ? finished.filter((f) => f.kind === task.kind) : []
  const kindFamily = kind.filter((f) => modelFamily(f.model) === modelFamily(task.model))
  const exact = kindFamily.filter((f) => f.model === task.model && f.effort === task.effort)
  const levels: Array<[CostEstimate['basis'], number[]]> = [
    ['model', family.map((f) => f.pct)],
    ['kind', kind.map(scaled)],
    ['kind-model', kindFamily.map((f) => f.pct)],
    ['setting', exact.map((f) => f.pct)],
  ]
  let est: CostEstimate = { pct: DEFAULT_TASK_PCT, basis: 'default', samples: 0 }
  for (const [basis, pcts] of levels) {
    if (!pcts.length) continue
    const sum = pcts.reduce((s, p) => s + p, 0)
    est = {
      pct: (sum + PRIOR_WEIGHT * est.pct) / (pcts.length + PRIOR_WEIGHT),
      basis,
      samples: pcts.length,
    }
  }
  return est
}

export function expectedPct(
  task: { kind?: string | null; model: string | null; effort: string | null },
  finished: FinishedCost[],
): number {
  return expectedCost(task, finished).pct
}

/** A task expected to cost more than this share of the biggest 5-hour window it may use is split
 *  before it starts (owner, 2026-10-01: "estimate the size of the task, check the accounts'
 *  available usage, then determine whether to send the full task or smaller tasks"). Run 1: the 49
 *  finished tasks averaged 24% of a Pro window and 80% of them stayed under 36%, but single tasks
 *  ran to 93% and 107%, and code on Opus high (33% on average) moved 33 times over 19 tasks. An
 *  estimate is an average, so a task estimated at over half a window runs past the whole window
 *  often enough that pieces, each started where it fits, cost less than its moves. */
export const SPLIT_SHARE = 0.5

/** How a task's expected cost (% of a Pro window) sits against the accounts it may use, given each
 *  one's planFactor. `window` is the biggest usable 5-hour window among them, in % of a Pro window
 *  (FIT_PCT of it; a Max 20x window holds 20 Pro windows). Over SPLIT_SHARE of it the task is
 *  `split`, into `pieces` that each stay under that share. */
export function sizeTask(
  expected: number,
  factors: number[],
): { window: number; share: number; split: boolean; pieces: number } {
  const window = FIT_PCT * Math.max(1, ...factors)
  const share = expected / window
  const split = share > SPLIT_SHARE
  return { window, share, split, pieces: split ? Math.ceil(share / SPLIT_SHARE) : 1 }
}

/** A week, the length of the all-models usage window. */
export const WEEK_MS = 7 * 24 * 3_600_000

/** How far the account's 7-day window has run, in % (0 just after its reset, 100 at the next):
 *  spending its week at exactly this pace lasts until the reset. Null when the reset is unknown. */
export function weekPacePct(acct: { weekResetsAt?: number | null }, now: number): number | null {
  const at = acct.weekResetsAt
  if (!at || at <= now) return null
  return Math.min(100, Math.max(0, 100 * (1 - (at - now) / WEEK_MS)))
}

/** How many points the account's weekly usage runs ahead of that pace: above 0 it is spending days
 *  it has not reached yet, below 0 it has room it loses at the reset unless used. Null when unknown. */
export function paceGap(
  acct: { weekPct?: number | null; weekResetsAt?: number | null },
  now: number,
): number | null {
  const pace = weekPacePct(acct, now)
  return pace === null || acct.weekPct === null || acct.weekPct === undefined
    ? null
    : acct.weekPct - pace
}

/** The longest a task waits for another account's 5-hour reset instead of starting on one that is
 *  ahead of its weekly pace. */
export const COOLDOWN_WAIT_MS = 30 * 60_000

/** Owner, 2026-10-01: with several Pro accounts and a Max 5x one, "just because the pro accounts have
 *  run low on usage does not mean you should begin immediately dumping everything into the 5X ...
 *  usage is usage, but it should smartly take into account the cool-down rate of up-and-coming
 *  accounts, the overhead it will take to do the work, what other things it can start or finish in
 *  the meantime while it's waiting". The 5-hour windows refill every five hours; the week is what
 *  runs out. So a task is held off `chosen` (pickAccount's best) when `chosen` has spent more of its
 *  week than the week has run, and an account it may use (`others`: allowed, signed in, under the
 *  weekly stop line) refills its 5-hour window within COOLDOWN_WAIT_MS with room for the task and is
 *  less ahead of its own pace. Answers that reset (epoch ms), or null to start now. Held, it costs
 *  nothing: no session starts, so there is no overhead to lose, and other tasks keep starting and
 *  finishing meanwhile. Never held: a session going on at home (warm cache) and priority work. */
export function waitsForCooldown(
  chosen: Pick<CliMayteAccount, 'id' | 'weekPct' | 'weekResetsAt'>,
  others: Array<
    Pick<CliMayteAccount, 'id' | 'sessionResetsAt' | 'planFactor' | 'weekPct' | 'weekResetsAt'>
  >,
  expected: number,
  now: number,
  opts: { home: boolean; priority: number },
): number | null {
  if (opts.home || opts.priority > 0) return null
  const gap = paceGap(chosen, now)
  if (gap === null || gap <= 0) return null
  const resets = others
    .filter(
      (a) =>
        a.id !== chosen.id &&
        !!a.sessionResetsAt &&
        a.sessionResetsAt > now &&
        a.sessionResetsAt - now <= COOLDOWN_WAIT_MS &&
        expected / (a.planFactor ?? 1) <= FIT_PCT &&
        (paceGap(a, now) ?? 0) < gap,
    )
    .map((a) => a.sessionResetsAt as number)
  return resets.length ? Math.min(...resets) : null
}

/** A session stopped at its own account's limit or ceiling (not a handoff) resumes there, warm, if
 *  that account frees up (`freesAt`: the end of its wall, else its 5-hour reset) within
 *  COOLDOWN_WAIT_MS: a move re-writes the whole conversation into a cold cache, a measured median of
 *  219k cache-write tokens against 49k for a resume on the same account. Answers when to start, or
 *  null to move now. Priority work never waits. */
export function waitsForHome(freesAt: number | null, now: number, priority: number): number | null {
  if (priority > 0 || freesAt === null || freesAt <= now) return null
  return freesAt - now <= COOLDOWN_WAIT_MS ? freesAt : null
}

/** Hold a task rather than start it on `chosen` (the best account pickAccount found) when it is not
 *  projected to finish there but would fit a fresh window of an account it may use: it would run
 *  out partway and move, re-writing its whole conversation into a cold cache. Smaller tasks take the
 *  room meanwhile, and the held one starts first once an account has room (a reset, or the work
 *  there finishing). A session going on on its own account (`home`) is never held, and neither is a
 *  task no window fits (run as a whole on the owner's say), which goes where the projection is lowest. */
export function waitsForRoom(
  chosen: Pick<CliMayteAccount, 'id' | 'sessionPct'> & { planFactor?: number },
  placement: CliMaytePlacement,
  allowedFactors: number[],
  home: boolean,
): boolean {
  if (home) return false
  const projected = projectedPct(
    chosen,
    placement.running.get(chosen.id) ?? [],
    placement.expected,
    placement.finishedSince?.get(chosen.id) ?? 0,
  )
  return projected > FIT_PCT && allowedFactors.some((f) => placement.expected / f <= FIT_PCT)
}
