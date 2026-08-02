// server/src/usage-history.ts — turn a percentage into a RATE, and a rate into a deadline.
//
// THE PROBLEM THIS SOLVES. "You are at 98%" is almost useless to an agent deciding whether to start
// a piece of work. 98% with a reset in 20 minutes is fine. 98% with a reset in four days, while
// burning 1%/hour, means you die mid-task in about two hours. Same number, opposite decision. The
// percentage alone cannot tell them apart; only its DERIVATIVE can.
//
// The endpoint gives us no rate (and no token or dollar counts — limit_dollars/used_dollars are null
// on a subscription), so we derive one: the background sweep already re-reads usage every 15 minutes,
// so we keep those readings and differentiate them.
//
// WHAT COMES OUT: burn rate in %/hour, hours of headroom left at that rate, the projected instant of
// exhaustion, and the single question that actually decides things:
//   "will I run out BEFORE the window resets?"
// If no, the cap is irrelevant and you can work freely. If yes, you know exactly how long you have.
//
// The pure math is separated from the storage so it is unit-testable without touching the disk.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import type { UsageForecast, UsageSample, UsageSnapshot } from './types'

const HISTORY_PATH = join(DATA_DIR, 'usage-history.json')

/** Keep ~5 days of 15-minute samples per key. Enough for a weekly trend, small enough to stay a
 *  few hundred KB of JSON. */
const MAX_SAMPLES_PER_KEY = 500

/**
 * Ignore a burn rate measured over less than this.
 *
 * THE PERCENTAGE IS AN INTEGER, and that is the whole reason this floor is as high as it is. If you
 * burn 0.8%/hour, the reported number does not move for over an hour. Measured across a 20-minute
 * span you would see delta = 0 and conclude "not burning" — which at 98% used is a FALSE GREEN LIGHT,
 * the single most expensive way this feature could be wrong.
 *
 * A span of h hours can only resolve rates down to (1 / h) %/hour. At 45 minutes that is ~1.3%/hour
 * of uncertainty, which is the coarsest that is still worth reporting. Below it we say "unknown"
 * rather than "zero". See burnRateBounds for how the residual uncertainty is then handled.
 */
const MIN_SPAN_MIN = 45

/** How far back to look when measuring the current burn. Long enough to smooth out a single heavy
 *  agent, short enough to still reflect what you are doing NOW rather than yesterday. */
const DEFAULT_LOOKBACK_HOURS = 6

type History = Record<string, UsageSample[]>

function readHistory(): History {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as History) : {}
  } catch {
    return {}
  }
}

function writeHistory(h: History): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(HISTORY_PATH, JSON.stringify(h))
  } catch {
    // best-effort: losing history costs us a forecast, never a usage reading
  }
}

/** Record one reading. Called on every successful check (manual or from the background sweep). */
export function recordUsageSample(key: string, snap: UsageSnapshot): void {
  if (!snap.weekAll) return // nothing to trend
  const h = readHistory()
  const list = h[key] ?? []
  const sample: UsageSample = {
    at: snap.capturedAt,
    sessionPct: snap.session?.pct ?? null,
    weekAllPct: snap.weekAll.pct,
    weekResetsAt: snap.weekAll.resetsAt ?? null,
  }
  // Don't store a duplicate reading (the cache can replay the same snapshot).
  const last = list[list.length - 1]
  if (last && last.at === sample.at) return
  list.push(sample)
  h[key] = list.slice(-MAX_SAMPLES_PER_KEY)
  writeHistory(h)
}

/** Drop a key's whole series — for when its subject is gone (a deleted dispatch account). Nothing
 *  can ever ask for that key again, and the file is capped per key but not per KEY COUNT, so
 *  without this every deleted account leaves up to 500 samples behind forever. */
export function dropUsageHistory(key: string): void {
  const h = readHistory()
  if (!(key in h)) return
  delete h[key]
  writeHistory(h)
}

/** Every stored sample for a key, oldest first. */
export function usageSamples(key: string): UsageSample[] {
  return readHistory()[key] ?? []
}

// --- the math (pure, tested) --------------------------------------------------

/**
 * Burn rate in percent-per-hour over the lookback window, or null when it can't be measured.
 *
 * Two things make this trickier than (last - first) / hours:
 *
 *  1. **A reset inside the window.** When the weekly window rolls over, the % drops to ~0. Naively
 *     differencing across that gives a large NEGATIVE rate, which would then be read as "you are
 *     gaining quota" and produce an infinite headroom. So we only measure from the LAST reset
 *     onward: walk back and cut the moment we see the percentage fall.
 *  2. **A flat window.** If you haven't worked, the rate is a legitimate 0, which must be reported as
 *     zero (meaning "no exhaustion in sight"), not as unknown.
 *
 * Returns null only when there genuinely isn't enough signal: fewer than 2 samples, or a span shorter
 * than MIN_SPAN_MIN.
 */
export function burnRateBounds(
  samples: UsageSample[],
  now = new Date(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
): { point: number; upper: number; spanHours: number } | null {
  if (samples.length < 2) return null
  const cutoff = now.getTime() - lookbackHours * 3600_000

  // Newest-first walk, stopping at the last reset (a drop in %) or the lookback edge.
  const window: UsageSample[] = []
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!
    const t = Date.parse(s.at)
    if (!Number.isFinite(t)) continue
    const prev = window[0]
    // Walking backwards, so `prev` is the sample AFTER this one in time. If this older sample has a
    // HIGHER pct than the newer one, the counter reset between them: stop, don't cross the boundary.
    if (prev && s.weekAllPct > prev.weekAllPct) break
    window.unshift(s)
    if (t < cutoff) break // include the first sample past the edge, then stop
  }
  if (window.length < 2) return null

  const first = window[0]!
  const last = window[window.length - 1]!
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600_000
  if (!Number.isFinite(hours) || hours * 60 < MIN_SPAN_MIN) return null

  const delta = last.weekAllPct - first.weekAllPct

  // The point estimate. Floored at 0: the walk above breaks on any decrease, so this cannot go
  // negative today, but a negative burn would read as "gaining quota" and hand out infinite headroom,
  // so the floor stays as a guard on that invariant.
  const point = Math.max(0, delta / hours)

  // THE UPPER BOUND, and the reason this function returns a range at all.
  //
  // `weekAllPct` is an INTEGER. A reading of 98 means the truth is somewhere in [98, 99). So a
  // measured delta of d could really be as much as d + 1 (you crossed almost a whole extra point
  // without the display ticking). In particular d = 0 does NOT mean "not burning" — it means
  // "burning slower than this span can resolve", which over 45 minutes is anything under ~1.3%/hour.
  //
  // Treating that as zero is how you tell someone at 98% to "work freely" minutes before they are
  // cut off. So every decision downstream is made against `upper`, never `point`.
  const upper = (delta + 1) / hours

  return { point, upper, spanHours: hours }
}

/** The point-estimate burn rate in %/hour, or null when unmeasurable. Prefer burnRateBounds when
 *  making a DECISION — a point estimate of 0 is not the same as "not burning" (see above). */
export function burnRatePctPerHour(
  samples: UsageSample[],
  now = new Date(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
): number | null {
  return burnRateBounds(samples, now, lookbackHours)?.point ?? null
}

/**
 * Turn the current reading + its history into a decision.
 *
 * The field that matters is `exhaustsBeforeReset`. Everything else is supporting detail:
 *   false -> the cap will not bite; work normally regardless of how scary the % looks.
 *   true  -> you have `headroomHours` before you are cut off. Plan around it.
 *
 * ASYMMETRY IS DELIBERATE. Every derived figure is computed from the burn rate's UPPER bound, not
 * its point estimate, so `headroomHours` is the WORST case and `exhaustsBeforeReset` errs toward
 * true. The two ways to be wrong are not equal: a needless warning costs a moment's caution, while a
 * false "work freely" gets an agent killed mid-task holding unsaved context, which is the exact
 * disaster this whole subsystem exists to prevent. When the integer percentage cannot resolve the
 * truth, we take the pessimistic end of the range.
 */
export function forecastUsage(
  snap: UsageSnapshot,
  samples: UsageSample[],
  now = new Date(),
): UsageForecast {
  const pct = snap.weekAll?.pct ?? null
  const resetsAt = snap.weekAll?.resetsAt ?? null
  const bounds = burnRateBounds(samples, now)

  // A reset time in the PAST means the snapshot is stale (the window has rolled over but this reading
  // predates it). Report it as UNKNOWN, not as "0 hours to reset".
  //
  // This matters more than it looks. `exhaustsBeforeReset` is `headroomHours < hoursToReset`, so
  // clamping a past reset to 0 would make that comparison false for ANY positive headroom — handing
  // back "you will not hit the cap, work freely" off a stale reading at 98% used. That is the same
  // false green light the upper-bound machinery above exists to prevent, arriving through a side door.
  // Null propagates to a null verdict, which callers must treat as "I don't know", never as "fine".
  const rawHoursToReset = resetsAt ? (Date.parse(resetsAt) - now.getTime()) / 3600_000 : null
  const hoursToReset =
    rawHoursToReset !== null && Number.isFinite(rawHoursToReset) && rawHoursToReset > 0
      ? rawHoursToReset
      : null

  const base: UsageForecast = {
    burnPctPerHour: bounds?.point ?? null,
    burnPctPerHourUpper: bounds?.upper ?? null,
    remainingPct: pct === null ? null : Math.max(0, 100 - pct),
    headroomHours: null,
    exhaustsAt: null,
    hoursToReset,
    exhaustsBeforeReset: null,
    samples: samples.length,
  }
  if (pct === null || bounds === null) return base

  const remaining = Math.max(0, 100 - pct)
  // `upper` is always > 0 (it is (delta + 1) / hours with hours > 0), so headroom is always finite.
  // There is deliberately no "burn is zero, you will never run out" branch any more: a measured zero
  // only means "slower than this span can resolve", and at 98% used that distinction is everything.
  const headroomHours = remaining / bounds.upper
  const exhaustsAt = new Date(now.getTime() + headroomHours * 3600_000).toISOString()
  return {
    ...base,
    headroomHours,
    exhaustsAt,
    exhaustsBeforeReset: hoursToReset === null ? null : headroomHours < hoursToReset,
  }
}
