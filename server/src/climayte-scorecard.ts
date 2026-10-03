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
  /** `--effort`; null for a model run without one (Haiku: no effort level is asked of it). */
  effort: string | null
}

export const HAIKU = 'claude-haiku-4-5'
export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'

/** Cheapest first. Price: Haiku 4.5 is half Sonnet 5.5 per token and Opus 5.5 twice it
 *  (usage-tokens modelMultiplier), and a higher effort writes more thinking, which is output, the
 *  dearest token on the meter. */
export const CLIMAYTE_LADDER: readonly CliMayteConfig[] = [
  { model: HAIKU, effort: null },
  { model: SONNET, effort: 'low' },
  { model: SONNET, effort: 'medium' },
  { model: SONNET, effort: 'high' },
  { model: OPUS, effort: 'medium' },
  { model: OPUS, effort: 'high' },
  { model: OPUS, effort: 'xhigh' },
  { model: OPUS, effort: 'max' },
]
/** What the CLI runs when asked for no model or effort: Opus high. */
const CLI_DEFAULT_RUNG = 5

/** Where a kind starts before any rung has earned its trust: frugal (the climayte skill), and the
 *  every-4th exploring pick tries cheaper still. */
const START: Record<CliMayteKind, number> = {
  trivial: 0,
  sweep: 2,
  mechanical: 2,
  docs: 2,
  code: 2,
  review: 2,
  debug: 4,
  manage: 1, // Sonnet low: reading reports and following a plan
}

/** A rung is trusted after this many verdicts at or above PASS_BAR, the floor for "reliably"... */
export const MIN_SAMPLES = 3
export const PASS_BAR = 0.7
/** ...and written off after two or more verdicts below half. */
const BAD_BAR = 0.5
/** One auto pick in this many tries a cheaper rung, to keep learning. */
export const EXPLORE_EVERY = 4

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
  fail: number
  units: number
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
        units: 0,
      }
      if (v.verdict === 'pass') row.pass++
      else row.fail++
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

/** A model as the ladder names it: older tasks stored `opus`, and the CLI may report a dated id. */
export function ladderModel(model: string | null | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase()
  if (m.includes('opus-5-5') || m === 'opus') return OPUS
  if (m.includes('sonnet-5-5') || m === 'sonnet') return SONNET
  if (m.includes('haiku-4-5') || m === 'haiku') return HAIKU
  return model
}

/** A rung's place on the ladder; -1 off it. Haiku is one rung whatever effort a verdict names. */
export function ladderIndex(c: { model: string | null; effort: string | null }): number {
  if (c.model === HAIKU) return 0
  return CLIMAYTE_LADDER.findIndex((r) => r.model === c.model && r.effort === c.effort)
}

/** "Sonnet medium", "Haiku". */
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
  let pass = 0
  let fail = 0
  let units = 0
  for (const x of rows)
    if (x.kind === kind && ladderIndex({ model: ladderModel(x.model), effort: x.effort }) === i) {
      pass += x.pass
      fail += x.fail
      units += x.units
    }
  const n = pass + fail
  return { n, pass, rate: n ? pass / n : 0, perPass: pass ? units / pass : Infinity }
}

const trusted = (s: RungStat): boolean => s.n >= MIN_SAMPLES && s.rate >= PASS_BAR

/** The rung CliMayte uses for `kind`: of the trusted rungs, the one whose passed task costs least
 *  (cheaper rung on a tie); else the kind's start, moved up past any rung that keeps failing. */
export function bestRung(kind: CliMayteKind, rows: ScoreRow[]): number {
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
  let i = START[kind]
  while (i < CLIMAYTE_LADDER.length - 1 && isBad(kind, rows, i)) i++
  return i
}

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

/** The setting for an auto task: the best rung, or on every EXPLORE_EVERY-th auto pick of the kind
 *  (`autoIndex` counts them from 0) a cheaper one still learning (exploreRung). */
export function pickConfig(
  kind: CliMayteKind,
  rows: ScoreRow[],
  autoIndex: number,
): { config: CliMayteConfig; reason: string } {
  const best = bestRung(kind, rows)
  const explore =
    autoIndex % EXPLORE_EVERY === EXPLORE_EVERY - 1 ? exploreRung(kind, rows, best) : null
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

/** The rung above what produced a failed result, or null at the top. A setting off the ladder (the
 *  CLI's default model and effort) counts as Opus high, what the CLI runs by default here. */
export function nextRung(c: {
  model: string | null
  effort: string | null
}): CliMayteConfig | null {
  let i = ladderIndex(c)
  if (i === -1) i = CLI_DEFAULT_RUNG
  return CLIMAYTE_LADDER[i + 1] ?? null
}
