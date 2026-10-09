// server/src/climayte-scorecard.ts — which model and thinking level each KIND of CliMayte task needs,
// learned from verdicts on real work (docs/CLIMAYTE.md "Scorecard"). Pure: climayte.ts stores the
// verdicts and calls these.
//
// WHY (owner, 2026-09-30): "the AI can try a model, and if it works, it gives it a thumbs up ... if
// it does not, it reports the failure, and what model it tries next. This would essentially build a
// super effective model of what works." The run-1 audit measured that output (thinking included) is
// about half of what fills a Pro account's 5-hour meter, so the thinking level and the model are the
// biggest quota levers left, and the only safe way to lower them is to watch real results.
//
// The loop: the orchestrator (or the owner in the CliMayte view) gives each finished task a verdict. A
// fail sends the task back to the same worker one rung up the ladder. A task dispatched with model
// `auto` gets, of the rungs that pass its kind reliably (MIN_SAMPLES verdicts at PASS_BAR), the one
// whose passed task costs least, and every EXPLORE_EVERY-th auto pick tries the cheapest rung not yet
// trusted nor written off, so the table keeps learning instead of settling on the first thing that
// worked.
//
// HAIKU 5.5 FIRST (owner, 2026-10-07: never use Haiku 4.5, and things should start "attempting to
// offload there first ... it's really good and really cheap"). Every kind starts on Haiku medium,
// and while a Haiku rung is still learning EVERY auto pick of a kind whose best rung is above Haiku
// tries it, not only every 4th. A failed Haiku result goes back on the rung the kind would have run
// without the trial, so a task Haiku cannot do costs one Haiku attempt, not a climb. Verdicts on
// Haiku 4.5 stay off the ladder: they judged another model.
//
// WHY COST DECIDES (owner, 2026-10-02: "you are supposed to be sending the task to the cheapest/fastest
// model capable of reliably completing your offloaded task", and "don't forget Haiku exists"). The
// first version took the cheapest rung at 80%: code's Sonnet medium sat at 78% (93 of 119) while each
// of its tasks cost a quarter of an Opus high one, so every code task went to Opus high at about four
// times the quota per passed task.

import type { CliMayteTokens } from './climayte-lib'
import { weighCounts } from './usage-tokens'

export const CLIMAYTE_KINDS = [
  'code',
  'debug',
  'review',
  'sweep',
  'mechanical',
  'docs',
  'trivial',
  'manage',
] as const
export type CliMayteKind = (typeof CLIMAYTE_KINDS)[number]

export interface CliMayteConfig {
  model: string
  /** `--effort`; null for a setting that asks none (the CLI's default). */
  effort: string | null
}

export const HAIKU = 'claude-haiku-5-5'
export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'

/** Cheapest first. Price: Haiku 5.5 weighs 0.14x Sonnet 5.5 on the meter (its two prompt-size
 *  tiers blended as CliMayte's traffic measured, usage-tokens modelMultiplier) and Opus 5.5 twice
 *  it, and a higher effort writes more thinking, which is output, the dearest token on the meter. */
export const CLIMAYTE_LADDER: readonly CliMayteConfig[] = [
  { model: HAIKU, effort: 'medium' },
  { model: HAIKU, effort: 'high' },
  { model: SONNET, effort: 'low' },
  { model: SONNET, effort: 'medium' },
  { model: SONNET, effort: 'high' },
  { model: OPUS, effort: 'medium' },
  { model: OPUS, effort: 'high' },
  { model: OPUS, effort: 'xhigh' },
  { model: OPUS, effort: 'max' },
]
/** The Haiku rungs: the first this many of the ladder. */
const HAIKU_RUNGS = 2
/** What the CLI runs when asked for no model or effort: Opus high. */
const CLI_DEFAULT_RUNG = 6

/** Where a kind starts before any rung has earned its trust: Haiku medium, every kind. */
const START = 0
/** Where a kind starts once Haiku is out of its way (both Haiku rungs written off, or a failed Haiku
 *  trial sent back): the frugal starts it had before Haiku 5.5 (the climayte skill). */
const START_PAST_HAIKU: Record<CliMayteKind, number> = {
  trivial: 2,
  sweep: 3,
  mechanical: 3,
  docs: 3,
  code: 3,
  review: 3,
  debug: 5,
  manage: 2, // Sonnet low: reading reports and following a plan
}

/** A rung is trusted after this many verdicts at or above PASS_BAR, the floor for "reliably"... */
export const MIN_SAMPLES = 3
export const PASS_BAR = 0.7
/** ...and written off after two or more verdicts below half. */
const BAD_BAR = 0.5
/** One auto pick in this many tries a cheaper rung, to keep learning. */
export const EXPLORE_EVERY = 4
/** While the kind's best rung is an Opus one, every 2nd auto pick explores instead. Owner,
 *  2026-10-05: the point was to offload work to moderate models, yet 'not a single one is using any
 *  other model besides Opus 5.5'; review sat on Opus high because Sonnet had 2 verdicts and every
 *  4th pick was too slow to earn the third. */
export const EXPLORE_EVERY_ON_OPUS = 2

/** Weighted units (usage-tokens.ts weights, Opus x2) per 1% of a Pro account's 5-hour window,
 *  fitted on run 1 (77 intervals over 7 Pro accounts, R^2 0.48). Display only: "this kind of task
 *  costs about 3% of a Pro window". */
export const UNITS_PER_PRO_PERCENT = 320_000

export function climayteKind(v: unknown): CliMayteKind | null {
  if (v === undefined || v === null || v === '') return null
  const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!(CLIMAYTE_KINDS as readonly string[]).includes(k))
    throw new Error(`unknown kind '${String(v)}': use ${CLIMAYTE_KINDS.join(', ')}`)
  return k as CliMayteKind
}

export interface CliMayteVerdict {
  at: number
  verdict: 'pass' | 'fail'
  note: string | null
  /** What produced the judged result: the model the CLI reported and the effort it was given. */
  model: string | null
  effort: string | null
  /** Weighted units the work since the previous verdict cost (attemptUnits). */
  units: number
  /** The part of `units` that was re-reading conversations into a cold cache (rereadUnits): left out
   *  of what a kind costs. Absent on verdicts recorded before 2026-10-01 until the load backfill. */
  reread?: number
  /** Who judged: the task's own check command, the orchestrating chat, the owner in the view, or
   *  the daemon by wave commands. */
  by?: 'check' | 'orchestrator' | 'owner' | 'wave'
  /** Provisional verdicts (by: 'wave') stay out of the scorecard until the orchestrator confirms them
   *  by calling climayte_wave_verify with ok: true. */
  provisional?: boolean
  /** How bad a fail was (owner, 2026-10-06: "Did it really fail, or did something have to just do a
   *  slight bit of work to fix it? ... a catastrophic fail, or ... a whoopsie-daisy?"). Only on a fail.
   *  0 not the model's: the work was not judged or the failure is not this task's. The check could not
   *    run (126/127, never started, runner lost) or timed out, or it failed only on files this task
   *    did not edit (another session's work, the environment, a flaky check); an orchestrator may also
   *    say the brief was wrong. NOT SCORED (neither pass nor fail; its units stay out of the cost).
   *  1 slip: right work, a small miss someone fixes in minutes: files not committed, a file outside the
   *    brief's paths, a one-line, typo, lint or format fix, a small missed test or doc update.
   *  2 rework: a real part is wrong or missing and needs a substantive follow-up, the approach stands.
   *  3 failed: wrong, unusable or harmful: misunderstood the task, nothing useful, broke unrelated
   *    things, claimed a success that was not there.
   *  Absent on a fail (older daemon, the old window's thumbs-down) counts as 3. */
  severity?: 0 | 1 | 2 | 3
  /** The work this verdict judges: the start of the task's newest attempt when it was recorded. A
   *  verdict with the same span as the one before judges the same work (no attempt since) and
   *  replaces it in the scorecard. Absent on older verdicts: each counts on its own. */
  span?: number
}

/** One attempt's tokens in weighted units. Writes are 5-minute ones for attempts launched with the
 *  5-minute cache (`cacheTtl`), else 1-hour ones, as Claude Code wrote them before. */
export function attemptUnits(
  tokens: CliMayteTokens | undefined,
  model: string | null | undefined,
  cacheTtl?: string,
): number {
  if (!tokens) return 0
  const fiveMinute = cacheTtl === '5m'
  return weighCounts(model ?? 'claude-opus-5-5', {
    input: tokens.input,
    cacheRead: tokens.cacheRead,
    cacheWrite5m: fiveMinute ? tokens.cacheWrite : 0,
    cacheWrite1h: fiveMinute ? 0 : tokens.cacheWrite,
    output: tokens.output,
  })
}

/** An attempt's restart overhead in weighted units: its first request's input and cache writes when
 *  it came after an attempt that ran (`spend.reread`), 0 otherwise. */
export function rereadUnits(
  at: { spend?: { reread: CliMayteTokens | null } | null; model?: string; cacheTtl?: string },
  model: string | null | undefined,
): number {
  const r = at.spend?.reread
  return r ? attemptUnits({ ...r, output: 0, cacheRead: 0 }, at.model ?? model, at.cacheTtl) : 0
}

export interface ScoreRow {
  kind: string
  model: string | null
  effort: string | null
  pass: number
  /** Scored fails, = slip + rework + failed. */
  fail: number
  slip: number
  rework: number
  /** Severity 3, and fails with no severity. */
  failed: number
  /** Severity-0 fails: in neither pass nor fail, and their units are not counted. */
  excluded: number
  units: number
}

/** Credit a scored verdict earns: a pass 1, a slip 2/3, a rework 1/3, a failed 0. */
export const SLIP_CREDIT = 2 / 3
export const REWORK_CREDIT = 1 / 3

/** A row's weighted pass rate (credit over scored verdicts), null with none scored. */
export function scoreOf(r: Pick<ScoreRow, 'pass' | 'slip' | 'rework' | 'fail'>): number | null {
  const n = r.pass + r.fail
  return n ? (r.pass + r.slip * SLIP_CREDIT + r.rework * REWORK_CREDIT) / n : null
}

/** Every verdict on record, summed per kind and setting; ladder order (cheapest first) within a
 *  kind, settings off the ladder (a CLI default) after it. Skips provisional verdicts (piece 5:
 *  the daemon judges by command, passes stay provisional until the orchestrator confirms them).
 *  Counts only the newest verdict per span of work: a later verdict on the same work (no attempt
 *  since the previous verdict) replaces an earlier one. */
export function scoreRows(
  tasks: Iterable<{ kind?: string | null; verdicts?: CliMayteVerdict[] }>,
): ScoreRow[] {
  const rows = new Map<string, ScoreRow>()
  for (const t of tasks) {
    if (!t.kind || !t.verdicts?.length) continue
    // The newest verdict per span of work; a provisional one leaves its span out of the card.
    const bySpan = new Map<number | string, CliMayteVerdict>()
    for (const [i, v] of t.verdicts.entries()) bySpan.set(v.span ?? `v${i}`, v)
    const filteredVerdicts = [...bySpan.values()].filter((v) => !v.provisional)
    for (const v of filteredVerdicts) {
      const key = `${t.kind}|${v.model ?? ''}|${v.effort ?? ''}`
      const row = rows.get(key) ?? {
        kind: t.kind,
        model: v.model,
        effort: v.effort,
        pass: 0,
        fail: 0,
        slip: 0,
        rework: 0,
        failed: 0,
        excluded: 0,
        units: 0,
      }
      rows.set(key, row)
      if (v.verdict === 'fail' && v.severity === 0) {
        row.excluded++
        continue
      }
      if (v.verdict === 'pass') row.pass++
      else {
        row.fail++
        if (v.severity === 1) row.slip++
        else if (v.severity === 2) row.rework++
        else row.failed++
      }
      // The work only: a move's re-read is what the move cost, not what the kind costs.
      row.units += Math.max(0, v.units - (v.reread ?? 0))
      rows.set(key, row)
    }
  }
  const rung = (r: ScoreRow): number => {
    const i = ladderIndex({ model: r.model, effort: r.effort })
    return i === -1 ? CLIMAYTE_LADDER.length : i
  }
  return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || rung(a) - rung(b))
}

/** A model as the ladder names it: older tasks stored `opus`, and the CLI may report a dated id.
 *  Haiku 4.5 stays as it is, off the ladder: its verdicts must not count for Haiku 5.5. */
export function ladderModel(model: string | null | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase()
  if (m.includes('opus-5-5') || m === 'opus') return OPUS
  if (m.includes('sonnet-5-5') || m === 'sonnet') return SONNET
  if (m.includes('haiku-5-5') || m === 'haiku') return HAIKU
  return model
}

/** A rung's place on the ladder; -1 off it. A Haiku 5.5 verdict with no effort ran at medium, the
 *  API's default. */
export function ladderIndex(c: { model: string | null; effort: string | null }): number {
  const effort = c.model === HAIKU ? (c.effort ?? 'medium') : c.effort
  return CLIMAYTE_LADDER.findIndex((r) => r.model === c.model && r.effort === effort)
}

/** "Sonnet medium", "Haiku high". */
export function rungLabel(i: number): string {
  const c = CLIMAYTE_LADDER[i]!
  const family = c.model === HAIKU ? 'Haiku' : c.model === SONNET ? 'Sonnet' : 'Opus'
  return c.effort ? `${family} ${c.effort}` : family
}

interface RungStat {
  n: number
  pass: number
  rate: number
  /** Weighted units per PASSED task (all its attempts' work over its passes); Infinity with none. */
  perPass: number
}

function statAt(rows: ScoreRow[], kind: string, i: number): RungStat {
  const sum = { pass: 0, fail: 0, slip: 0, rework: 0 }
  let units = 0
  for (const x of rows)
    if (x.kind === kind && ladderIndex({ model: ladderModel(x.model), effort: x.effort }) === i) {
      sum.pass += x.pass
      sum.fail += x.fail
      sum.slip += x.slip
      sum.rework += x.rework
      units += x.units
    }
  const n = sum.pass + sum.fail
  const rate = scoreOf(sum) ?? 0
  const credit = rate * n
  return { n, pass: sum.pass, rate, perPass: credit ? units / credit : Infinity }
}

const trusted = (s: RungStat): boolean => s.n >= MIN_SAMPLES && s.rate >= PASS_BAR

/** The rung CliMayte uses for `kind`: of the trusted rungs, the one whose passed task costs least
 *  (cheaper rung on a tie); else the kind's start, moved up past any rung that keeps failing, and
 *  to START_PAST_HAIKU once both Haiku rungs are written off. `pastHaiku` passes over every Haiku
 *  rung not trusted: the rung the kind would run without the Haiku trial (bestRungPastHaiku). */
export function bestRung(kind: CliMayteKind, rows: ScoreRow[], pastHaiku = false): number {
  let best = -1
  let bestCost = Infinity
  for (let i = 0; i < CLIMAYTE_LADDER.length; i++) {
    const s = statAt(rows, kind, i)
    if (trusted(s) && s.perPass < bestCost) {
      best = i
      bestCost = s.perPass
    }
  }
  if (best !== -1) return best
  let i = START
  while (i < HAIKU_RUNGS && (pastHaiku || isBad(kind, rows, i))) i++
  if (i >= HAIKU_RUNGS) i = Math.max(i, START_PAST_HAIKU[kind])
  while (i < CLIMAYTE_LADDER.length - 1 && isBad(kind, rows, i)) i++
  return i
}

/** The rung `kind` would run without the Haiku trial: where a failed Haiku result goes back to. */
export const bestRungPastHaiku = (kind: CliMayteKind, rows: ScoreRow[]): number =>
  bestRung(kind, rows, true)

function isBad(kind: string, rows: ScoreRow[], i: number): boolean {
  const s = statAt(rows, kind, i)
  return s.n >= 2 && s.rate < BAD_BAR
}

/** The rung an exploring pick tries: the cheapest below `best` neither trusted nor written off (one
 *  still learning, Haiku first), or none. */
function exploreRung(kind: CliMayteKind, rows: ScoreRow[], best: number): number | null {
  for (let i = 0; i < best; i++) {
    if (!trusted(statAt(rows, kind, i)) && !isBad(kind, rows, i)) return i
  }
  return null
}

/** The Haiku rung every auto pick tries while the kind's best rung is above Haiku: the cheapest one
 *  still learning, or none once a cheaper Haiku rung is written off (Haiku is out for the kind, and
 *  the every-4th exploring pick takes over). */
function haikuTrial(kind: CliMayteKind, rows: ScoreRow[], best: number): number | null {
  if (best < HAIKU_RUNGS) return null
  for (let i = 0; i < HAIKU_RUNGS; i++) {
    if (isBad(kind, rows, i)) return null
    const s = statAt(rows, kind, i)
    // A cheaper Haiku rung already trusted has been measured and lost to `best` on cost per pass, so a
    // dearer Haiku rung has nothing left to prove (2026-10-09: mechanical sent every pick to Haiku high,
    // 0 passes in 2, while Haiku medium passed 7 of 9 and Sonnet medium 32 of 33).
    if (trusted(s)) return null
    // Only until the rung has its samples: one that settles between the bars (0.5 to 0.7) goes back
    // to the every-EXPLORE_EVERY-th cadence, or it would take every pick of the kind for good.
    if (s.n < MIN_SAMPLES) return i
  }
  return null
}

/** The rung an auto pick of `kind` goes to now, before exploring: the Haiku trial's rung while it
 *  runs, else the best rung. What the scorecard reports as the pick. */
export function pickedRung(kind: CliMayteKind, rows: ScoreRow[]): number {
  const best = bestRung(kind, rows)
  return haikuTrial(kind, rows, best) ?? best
}

/** The setting for an auto task: a Haiku rung still learning on every pick while the best rung is
 *  above Haiku (haikuTrial); else the best rung, or on every EXPLORE_EVERY-th (EXPLORE_EVERY_ON_OPUS
 *  while the best rung is an Opus one) auto pick of the kind
 *  (`autoIndex` counts them from 0) a cheaper one still learning (exploreRung). */
export function pickConfig(
  kind: CliMayteKind,
  rows: ScoreRow[],
  autoIndex: number,
): { config: CliMayteConfig; reason: string } {
  const best = bestRung(kind, rows)
  const trial = haikuTrial(kind, rows, best)
  if (trial !== null)
    return {
      config: CLIMAYTE_LADDER[trial]!,
      reason: `trying ${rungLabel(trial)} first (Haiku 5.5), cheaper than ${rungLabel(best)}, for ${kind}`,
    }
  const every = CLIMAYTE_LADDER[best]!.model === OPUS ? EXPLORE_EVERY_ON_OPUS : EXPLORE_EVERY
  const explore = autoIndex % every === every - 1 ? exploreRung(kind, rows, best) : null
  if (explore !== null)
    return {
      config: CLIMAYTE_LADDER[explore]!,
      reason: `trying ${rungLabel(explore)}, cheaper than ${rungLabel(best)}, for ${kind}`,
    }
  const s = statAt(rows, kind, best)
  return {
    config: CLIMAYTE_LADDER[best]!,
    reason: trusted(s)
      ? `${rungLabel(best)} passed ${s.pass} of ${s.n} ${kind} tasks, the least quota per passed task`
      : `${rungLabel(best)}, the starting point for ${kind} until a setting passes ${MIN_SAMPLES} reliably`,
  }
}

/** The rung above what produced a failed result, or the ladder index `floor` when that is higher;
 *  null at the top. A setting off the ladder counts as the rung it sits nearest: Haiku 5.5 low just
 *  below Haiku medium, any other Haiku (4.5, or 5.5 above high) as Haiku high, anything else (the
 *  CLI's default model and effort) as Opus high, what the CLI runs by default here. */
export function nextRung(
  c: { model: string | null; effort: string | null },
  floor = 0,
): CliMayteConfig | null {
  let i = ladderIndex(c)
  if (i === -1 && c.model?.toLowerCase().includes('haiku'))
    i = c.model === HAIKU && c.effort === 'low' ? -1 : HAIKU_RUNGS - 1
  else if (i === -1) i = CLI_DEFAULT_RUNG
  return CLIMAYTE_LADDER[Math.max(i + 1, floor)] ?? null
}
