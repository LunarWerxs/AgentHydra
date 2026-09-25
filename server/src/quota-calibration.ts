// server/src/quota-calibration.ts - what 100% of a subscription window is worth, in dollars.
//
// WHY. The usage endpoint reports a percentage and nothing else, so "weekly 62%" says how much is
// gone but not how much work is left. usage-budget.ts already sizes 1% in weighted tokens over a
// rolling 6 hours; this answers the question in the unit people and fan-outs budget in: list-price
// dollars of Claude Code spend. 100% weekly ~ $X turns "62% used" into "about $0.38X of work left".
//
// THE METHOD, adapted from an idea in lobehub/lobehub (packages/heterogeneous-agents/src/quota;
// written fresh here, no code copied):
//   1. Readings are grouped into WINDOWS keyed by the provider's own reset instant, rounded to the
//      minute. The reset time the endpoint reports jitters by seconds between reads; keyed raw, one
//      window would split into several and each piece would look too small to use.
//   2. Each clean window gives ONE sample: (percent moved, dollars spent between its first and last
//      reading), the dollars priced from this machine's transcripts at published rates.
//   3. A Theil-Sen slope (the median of pairwise slopes) through those samples is dollars per
//      percent. The median is the point: one window polluted by spend we cannot see moves a mean
//      a long way and a median hardly at all.
//   4. CENSORING. A window is thrown out, not averaged in, when its pair no longer describes the
//      account: it hit 100% (spend past the cap never reaches the percentage), the weekly cap cut a
//      5-hour window short, the percentage fell under one key (a reset we did not see), it rose with
//      no recorded turn behind it (usage from the desktop app, the web or another machine), a turn in
//      it has no price, or it moved too few points for an integer percentage to resolve.
//
// Folding is incremental: a window's running state is persisted, so each call prices only the
// turns since the last reading it folded, and a window keeps its early readings even after
// usage-history.ts has trimmed them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { priceTokens } from './pricing'
import type {
  BudgetConfidence,
  QuotaCapacity,
  QuotaDollars,
  QuotaWindowCensor,
  UsageSample,
  UsageSnapshot,
} from './types'
import { defaultConfigDir, forEachTurnSince } from './usage-tokens'

const STORE_PATH = join(DATA_DIR, 'quota-calibration.json')

/** A window must move at least this many points to count. The percentage is an integer, so a
 *  3-point move carries at most a third of a point of rounding error per point. */
const MIN_DELTA_PCT = 3

/** A rise of this many points between two readings with no priced turn between them is usage we
 *  cannot see. One point is not enough: an integer percentage can tick from rounding alone. */
const UNRECORDED_RISE_PCT = 2

/** At this many clean windows the median has something to reject outliers against. */
const MIN_WINDOWS_FOR_GOOD = 3

export type QuotaKind = 'weekly' | 'session'

/** One usage reading, reduced to what a window needs. */
export interface QuotaReading {
  at: number
  pct: number
  resetsAt: string | null
  /** The enclosing (higher-tier) limit's % at the same instant; null when there is none. */
  higherPct: number | null
}

/** The running state of one window, folded one reading at a time. */
export interface WindowFold {
  fromAt: number
  fromPct: number
  throughAt: number
  throughPct: number
  usd: number
  unpriced: boolean
  unrecorded: boolean
  capped: boolean
  higherCapped: boolean
  backwards: boolean
}

/** Dollars spent in (fromMs, toMs], and whether any turn in it had no price. */
export type IntervalCost = (fromMs: number, toMs: number) => { usd: number; unpriced: boolean }

/**
 * The window a reading belongs to: its reset instant, rounded to the nearest minute. Null for a
 * reading with no (or an unparseable) reset time, which cannot be placed in any window.
 */
export function windowKey(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return null
  return new Date(Math.round(t / 60_000) * 60_000).toISOString()
}

/** The readings of one kind of window out of the usage history, oldest first. */
export function readingsFor(samples: UsageSample[], kind: QuotaKind): QuotaReading[] {
  const out: QuotaReading[] = []
  for (const s of samples) {
    const at = Date.parse(s.at)
    if (!Number.isFinite(at)) continue
    if (kind === 'weekly') {
      out.push({ at, pct: s.weekAllPct, resetsAt: s.weekResetsAt, higherPct: null })
    } else if (s.sessionPct !== null) {
      out.push({
        at,
        pct: s.sessionPct,
        resetsAt: s.sessionResetsAt ?? null,
        higherPct: s.weekAllPct,
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Readings grouped by window key, in order. Readings with no key are dropped. */
export function groupWindows(readings: QuotaReading[]): Map<string, QuotaReading[]> {
  const windows = new Map<string, QuotaReading[]>()
  for (const r of readings) {
    const key = windowKey(r.resetsAt)
    if (!key) continue
    const list = windows.get(key) ?? []
    list.push(r)
    windows.set(key, list)
  }
  return windows
}

/**
 * Fold a window's readings into its running state, starting from `prior` (the state a previous
 * call persisted) so only readings after `prior.throughAt` cost anything to price.
 */
export function foldWindow(
  readings: QuotaReading[],
  cost: IntervalCost,
  prior: WindowFold | null = null,
): WindowFold | null {
  const first = readings[0]
  if (!prior && !first) return null
  const state: WindowFold = prior
    ? { ...prior }
    : {
        fromAt: first!.at,
        fromPct: first!.pct,
        throughAt: first!.at,
        throughPct: first!.pct,
        usd: 0,
        unpriced: false,
        unrecorded: false,
        capped: first!.pct >= 100,
        higherCapped: (first!.higherPct ?? 0) >= 100,
        backwards: false,
      }
  for (const r of readings) {
    if (r.at <= state.throughAt) continue
    const spent = cost(state.throughAt, r.at)
    const rise = r.pct - state.throughPct
    state.usd += spent.usd
    if (spent.unpriced) state.unpriced = true
    if (rise < 0) state.backwards = true
    if (rise >= UNRECORDED_RISE_PCT && spent.usd === 0) state.unrecorded = true
    if (r.pct >= 100) state.capped = true
    if ((r.higherPct ?? 0) >= 100) state.higherCapped = true
    state.throughAt = r.at
    state.throughPct = r.pct
  }
  return state
}

/** A folded window as one calibration sample, or the reason it cannot be one. */
export function classifyWindow(
  w: WindowFold,
): { dPct: number; usd: number } | { censor: QuotaWindowCensor } {
  if (w.capped) return { censor: 'capped' }
  if (w.higherCapped) return { censor: 'higher_tier_capped' }
  if (w.backwards) return { censor: 'went_backwards' }
  if (w.unpriced) return { censor: 'unpriced' }
  if (w.unrecorded) return { censor: 'unrecorded_usage' }
  const dPct = w.throughPct - w.fromPct
  if (dPct < MIN_DELTA_PCT) return { censor: 'too_small' }
  return { dPct, usd: w.usd }
}

/**
 * Theil-Sen slope: the median of the slopes between every pair of points with distinct x.
 *
 * The origin is always one of the points, because a window whose percentage did not move spent
 * nothing against it. That anchor is what lets a single clean window calibrate at all (its slope
 * is its own dollars-per-percent), while further windows let the median outvote a bad one.
 * Returns null when no positive slope comes out.
 */
export function theilSenSlope(points: { x: number; y: number }[]): number | null {
  const pts = [{ x: 0, y: 0 }, ...points]
  const slopes: number[] = []
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!
      const b = pts[j]!
      if (a.x === b.x) continue
      slopes.push((b.y - a.y) / (b.x - a.x))
    }
  }
  if (slopes.length === 0) return null
  slopes.sort((a, b) => a - b)
  const mid = slopes.length >> 1
  const median = slopes.length % 2 ? slopes[mid]! : (slopes[mid - 1]! + slopes[mid]!) / 2
  return median > 0 && Number.isFinite(median) ? median : null
}

/** An uncalibrated capacity: every figure null, never zero. */
export function emptyCapacity(): QuotaCapacity {
  return {
    usdPerPct: null,
    capacityUsd: null,
    dollarsLeft: null,
    windows: 0,
    censored: {},
    confidence: 'none',
  }
}

/** Fit the slope to a set of folded windows and price what is left of `currentPct`. */
export function capacityFrom(folds: WindowFold[], currentPct: number | null): QuotaCapacity {
  const out = emptyCapacity()
  const points: { x: number; y: number }[] = []
  for (const w of folds) {
    const c = classifyWindow(w)
    if ('censor' in c) out.censored[c.censor] = (out.censored[c.censor] ?? 0) + 1
    else points.push({ x: c.dPct, y: c.usd })
  }
  out.windows = points.length
  const slope = points.length ? theilSenSlope(points) : null
  if (slope === null) return out
  out.usdPerPct = slope
  out.capacityUsd = slope * 100
  out.dollarsLeft = currentPct === null ? null : slope * Math.max(0, 100 - currentPct)
  const confidence: BudgetConfidence = points.length >= MIN_WINDOWS_FOR_GOOD ? 'good' : 'rough'
  out.confidence = confidence
  return out
}

/** Same capacity, re-priced against a newer reading. */
export function withCurrentPct(cap: QuotaCapacity, currentPct: number | null): QuotaCapacity {
  return {
    ...cap,
    dollarsLeft:
      cap.usdPerPct === null || currentPct === null
        ? null
        : cap.usdPerPct * Math.max(0, 100 - currentPct),
  }
}

const CAVEAT =
  'Measured, not published: dollars are Claude Code turns in the counted transcripts priced at list API rates, fitted against how far each quota window moved (Theil-Sen median over clean windows). Windows that hit a cap, were cut short by the weekly cap, fell back, moved with no recorded turn, held an unpriced model, or moved under ' +
  `${MIN_DELTA_PCT} points are left out. Usage from the desktop app, the web or another machine that slips past those rules makes the figure too LOW (more percent per dollar), so dollarsLeft errs conservative; spend from another account in the same transcripts makes it too HIGH.`

// --- storage ------------------------------------------------------------------

interface AccountEntry {
  /** `<kind>:<window key>` -> that window's running fold. */
  windows: Record<string, WindowFold>
  dollars: QuotaDollars | null
}

type Store = Record<string, AccountEntry>

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function writeStore(s: Store): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(s))
  } catch {
    // best-effort: losing the calibration costs a dollar figure, never a usage reading
  }
}

/** Every priced turn since `sinceMs`, as a cumulative-cost lookup over any interval. */
function intervalCostFrom(sinceMs: number, configDirs: string[]): IntervalCost {
  const turns: { ts: number; usd: number; unpriced: boolean }[] = []
  forEachTurnSince(new Date(sinceMs), configDirs, (ts, byModel) => {
    const priced = priceTokens(byModel, ts)
    turns.push({ ts, usd: priced.costUsd ?? 0, unpriced: priced.unpriced.length > 0 })
  })
  turns.sort((a, b) => a.ts - b.ts)
  const cum: number[] = [0]
  const unpricedCum: number[] = [0]
  for (const t of turns) {
    cum.push(cum[cum.length - 1]! + t.usd)
    unpricedCum.push(unpricedCum[unpricedCum.length - 1]! + (t.unpriced ? 1 : 0))
  }
  // Index of the first turn with ts > ms.
  const after = (ms: number): number => {
    let lo = 0
    let hi = turns.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (turns[m]!.ts <= ms) lo = m + 1
      else hi = m
    }
    return lo
  }
  return (fromMs, toMs) => {
    const i = after(fromMs)
    const j = after(toMs)
    return { usd: cum[j]! - cum[i]!, unpriced: unpricedCum[j]! - unpricedCum[i]! > 0 }
  }
}

/**
 * Calibrate one account's quota windows into dollars and persist the result.
 *
 * `key` is the usage-history key (desktop:/cli:/...) the samples were recorded under. Never
 * throws: a failure reads as "not calibrated", with every figure null.
 */
export function calibrateQuotaDollars(
  key: string,
  snap: UsageSnapshot,
  samples: UsageSample[],
  configDirs: string[] = [defaultConfigDir()],
  now: Date = new Date(),
): QuotaDollars {
  try {
    const store = readStore()
    const entry: AccountEntry = store[key] ?? { windows: {}, dollars: null }
    const grouped = new Map<string, QuotaReading[]>()
    for (const kind of ['weekly', 'session'] as const) {
      for (const [wk, list] of groupWindows(readingsFor(samples, kind)))
        grouped.set(`${kind}:${wk}`, list)
    }

    // One transcript walk covers every window that has an unpriced reading left.
    let scanFrom = Number.POSITIVE_INFINITY
    for (const [id, list] of grouped) {
      const prior = entry.windows[id]
      const last = list[list.length - 1]!
      const start = prior ? prior.throughAt : list[0]!.at
      if (last.at > start) scanFrom = Math.min(scanFrom, start)
    }
    const cost: IntervalCost = Number.isFinite(scanFrom)
      ? intervalCostFrom(scanFrom, configDirs)
      : () => ({ usd: 0, unpriced: false })

    // Windows no longer in the history are dropped: nothing can extend them, and the store stays
    // bounded by the history's own cap.
    const windows: Record<string, WindowFold> = {}
    for (const [id, list] of grouped) {
      const fold = foldWindow(list, cost, entry.windows[id] ?? null)
      if (fold) windows[id] = fold
    }
    const folds = (kind: QuotaKind) =>
      Object.entries(windows)
        .filter(([id]) => id.startsWith(`${kind}:`))
        .map(([, w]) => w)

    const dollars: QuotaDollars = {
      weekly: capacityFrom(folds('weekly'), snap.weekAll?.pct ?? null),
      session: capacityFrom(folds('session'), snap.session?.pct ?? null),
      calibratedAt: now.toISOString(),
      caveat: CAVEAT,
    }
    store[key] = { windows, dollars }
    writeStore(store)
    return dollars
  } catch {
    return uncalibratedDollars()
  }
}

export function uncalibratedDollars(): QuotaDollars {
  return {
    weekly: emptyCapacity(),
    session: emptyCapacity(),
    calibratedAt: null,
    caveat: `Not calibrated yet: run usage_budget once the account has quota windows that moved at least ${MIN_DELTA_PCT} points. ${CAVEAT}`,
  }
}

/**
 * The last calibration for `key`, re-priced against `snap`: a file read, no transcript walk, so a
 * quick self-check can carry a dollar figure. Every figure is null until usage_budget has run.
 */
export function storedQuotaDollars(key: string, snap: UsageSnapshot | null): QuotaDollars {
  const stored = readStore()[key]?.dollars
  if (!stored) return uncalibratedDollars()
  return {
    ...stored,
    weekly: withCurrentPct(stored.weekly, snap?.weekAll?.pct ?? null),
    session: withCurrentPct(stored.session, snap?.session?.pct ?? null),
  }
}

/** One sentence for an agent's context, or '' when nothing is calibrated. */
export function dollarsSummary(d: QuotaDollars): string {
  const parts: string[] = []
  const say = (label: string, c: QuotaCapacity) => {
    if (c.capacityUsd === null) return
    const left = c.dollarsLeft === null ? '' : `, about $${c.dollarsLeft.toFixed(2)} of it left`
    parts.push(
      `${label} 100% is worth about $${c.capacityUsd.toFixed(2)} of Claude Code at list prices${left} (from ${c.windows} clean window${c.windows === 1 ? '' : 's'}, confidence ${c.confidence}).`,
    )
  }
  say('Weekly', d.weekly)
  say('5-hour', d.session)
  return parts.join(' ')
}
