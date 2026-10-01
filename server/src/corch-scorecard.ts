// server/src/corch-scorecard.ts — which model and thinking level each KIND of Corch task needs,
// learned from verdicts on real work (docs/CORCH.md "Scorecard"). Pure: corch.ts stores the
// verdicts and calls these.
//
// WHY (owner, 2026-09-30): "the AI can try a model, and if it works, it gives it a thumbs up ... if
// it does not, it reports the failure, and what model it tries next. This would essentially build a
// super effective model of what works." The run-1 audit measured that output (thinking included) is
// about half of what fills a Pro account's 5-hour meter, so the thinking level and the model are the
// biggest quota levers left, and the only safe way to lower them is to watch real results.
//
// The loop: the orchestrator (or the owner in the Corch view) gives each finished task a verdict. A
// fail sends the task back to the same worker one rung up the ladder. A task dispatched with model
// `auto` gets the cheapest rung that keeps passing for its kind, and every EXPLORE_EVERY-th auto pick
// tries one rung cheaper, so the table keeps learning instead of settling on the first thing that
// worked.

import type { CorchTokens } from './corch-lib'
import { weighCounts } from './usage-tokens'

export const CORCH_KINDS = [
  'code',
  'debug',
  'review',
  'sweep',
  'mechanical',
  'docs',
  'trivial',
] as const
export type CorchKind = (typeof CORCH_KINDS)[number]

export interface CorchConfig {
  model: string
  effort: string
}

/** Cheapest first. Price: Opus 5.5 is twice Sonnet 5.5 per token (usage-tokens modelMultiplier),
 *  and a higher effort writes more thinking, which is output, the dearest token on the meter. */
export const CORCH_LADDER: readonly CorchConfig[] = [
  { model: 'claude-sonnet-5-5', effort: 'low' },
  { model: 'claude-sonnet-5-5', effort: 'medium' },
  { model: 'claude-sonnet-5-5', effort: 'high' },
  { model: 'claude-opus-5-5', effort: 'medium' },
  { model: 'claude-opus-5-5', effort: 'high' },
  { model: 'claude-opus-5-5', effort: 'xhigh' },
  { model: 'claude-opus-5-5', effort: 'max' },
]

/** Where a kind starts before it has verdicts: the corch skill's table (high for code was measured:
 *  it matched xhigh on ten real fixes at 2.3x fewer tokens). */
const START: Record<CorchKind, number> = {
  trivial: 0,
  sweep: 1,
  mechanical: 1,
  docs: 1,
  code: 4,
  review: 4,
  debug: 5,
}

/** A rung is trusted after this many verdicts at or above PASS_BAR... */
export const MIN_SAMPLES = 3
export const PASS_BAR = 0.8
/** ...and written off after two or more verdicts below half. */
const BAD_BAR = 0.5
/** One auto pick in this many tries the rung below the best. */
export const EXPLORE_EVERY = 4

/** Weighted units (usage-tokens.ts weights, Opus x2) per 1% of a Pro account's 5-hour window,
 *  fitted on run 1 (77 intervals over 7 Pro accounts, R^2 0.48). Display only: "this kind of task
 *  costs about 3% of a Pro window". */
export const UNITS_PER_PRO_PERCENT = 320_000

export function corchKind(v: unknown): CorchKind | null {
  if (v === undefined || v === null || v === '') return null
  const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!(CORCH_KINDS as readonly string[]).includes(k))
    throw new Error(`unknown kind '${String(v)}': use ${CORCH_KINDS.join(', ')}`)
  return k as CorchKind
}

export interface CorchVerdict {
  at: number
  verdict: 'pass' | 'fail'
  note: string | null
  /** What produced the judged result: the model the CLI reported and the effort it was given. */
  model: string | null
  effort: string | null
  /** Weighted units the work since the previous verdict cost (attemptUnits). */
  units: number
  /** Who judged: the task's own check command, the orchestrating chat, or the owner in the view. */
  by?: 'check' | 'orchestrator' | 'owner'
}

/** One attempt's tokens in weighted units. Writes are 5-minute ones for attempts launched with the
 *  5-minute cache (`cacheTtl`), else 1-hour ones, as Claude Code wrote them before. */
export function attemptUnits(
  tokens: CorchTokens | undefined,
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

export interface ScoreRow {
  kind: string
  model: string | null
  effort: string | null
  pass: number
  fail: number
  units: number
}

/** Every verdict on record, summed per kind and setting; ladder order (cheapest first) within a
 *  kind, settings off the ladder (a CLI default) after it. */
export function scoreRows(
  tasks: Iterable<{ kind?: string | null; verdicts?: CorchVerdict[] }>,
): ScoreRow[] {
  const rows = new Map<string, ScoreRow>()
  for (const t of tasks) {
    if (!t.kind || !t.verdicts?.length) continue
    for (const v of t.verdicts) {
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
      row.units += v.units
      rows.set(key, row)
    }
  }
  const rung = (r: ScoreRow): number => {
    const i = ladderIndex({ model: r.model, effort: r.effort })
    return i === -1 ? CORCH_LADDER.length : i
  }
  return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || rung(a) - rung(b))
}

/** A model as the ladder names it: older tasks stored `opus`, and the CLI may report a dated id. */
export function ladderModel(model: string | null | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase()
  if (m.includes('opus-5-5') || m === 'opus') return 'claude-opus-5-5'
  if (m.includes('sonnet-5-5') || m === 'sonnet') return 'claude-sonnet-5-5'
  return model
}

export function ladderIndex(c: { model: string | null; effort: string | null }): number {
  return CORCH_LADDER.findIndex((r) => r.model === c.model && r.effort === c.effort)
}

function statAt(rows: ScoreRow[], kind: string, i: number): { n: number; rate: number } {
  const c = CORCH_LADDER[i]!
  const r = rows.find((x) => x.kind === kind && x.model === c.model && x.effort === c.effort)
  const n = r ? r.pass + r.fail : 0
  return { n, rate: n ? r!.pass / n : 0 }
}

/** The rung Corch trusts for `kind`: the cheapest with MIN_SAMPLES verdicts at PASS_BAR, else the
 *  kind's start, moved up past any rung that keeps failing. */
export function bestRung(kind: CorchKind, rows: ScoreRow[]): number {
  const good = CORCH_LADDER.findIndex((_, i) => {
    const s = statAt(rows, kind, i)
    return s.n >= MIN_SAMPLES && s.rate >= PASS_BAR
  })
  if (good !== -1) return good
  let i = START[kind]
  while (i < CORCH_LADDER.length - 1 && isBad(kind, rows, i)) i++
  return i
}

function isBad(kind: string, rows: ScoreRow[], i: number): boolean {
  const s = statAt(rows, kind, i)
  return s.n >= 2 && s.rate < BAD_BAR
}

/** The setting for an auto task: the best rung, or one cheaper on every EXPLORE_EVERY-th auto pick
 *  of the kind (`autoIndex` counts them from 0) unless that rung keeps failing. */
export function pickConfig(
  kind: CorchKind,
  rows: ScoreRow[],
  autoIndex: number,
): { config: CorchConfig; reason: string } {
  const best = bestRung(kind, rows)
  const label = (i: number): string => {
    const c = CORCH_LADDER[i]!
    return `${c.model.includes('sonnet') ? 'Sonnet' : 'Opus'} ${c.effort}`
  }
  if (autoIndex % EXPLORE_EVERY === EXPLORE_EVERY - 1 && best > 0 && !isBad(kind, rows, best - 1))
    return {
      config: CORCH_LADDER[best - 1]!,
      reason: `trying one rung cheaper than ${label(best)} (${label(best - 1)}) for ${kind}`,
    }
  const s = statAt(rows, kind, best)
  return {
    config: CORCH_LADDER[best]!,
    reason:
      s.n >= MIN_SAMPLES && s.rate >= PASS_BAR
        ? `${label(best)} passed ${Math.round(s.rate * s.n)} of ${s.n} ${kind} tasks`
        : `${label(best)}, the starting point for ${kind} until it has ${MIN_SAMPLES} verdicts`,
  }
}

/** The rung above what produced a failed result, or null at the top. A setting off the ladder (the
 *  CLI's default model and effort) counts as Opus high, what the CLI runs by default here. */
export function nextRung(c: { model: string | null; effort: string | null }): CorchConfig | null {
  let i = ladderIndex(c)
  if (i === -1) i = 4
  return CORCH_LADDER[i + 1] ?? null
}
