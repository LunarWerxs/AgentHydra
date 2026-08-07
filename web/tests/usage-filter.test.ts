// web/src/lib/usage-filter.ts — the rule behind "dim/hide the accounts I've already spent".
//
// Three behaviours worth pinning down, each one a careless rewrite away from breaking: the DEFAULT
// window is the weekly cap (the Usage column, not the 5-hour one), an UNKNOWN reading must never
// count as over the limit (it would silently drop usable accounts out of the table), and the opt-in
// 'either' must look at both windows (a row can be cheap weekly and exhausted for the next 5 hours).
import { expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/lib/api'
import {
  clampThreshold,
  DEFAULT_USAGE_FILTER_SCOPE,
  DEFAULT_USAGE_THRESHOLD,
  isOverUsageThreshold,
  usageFilterPct,
} from '../src/lib/usage-filter'

const limit = (pct: number) => ({ pct, resets: 'Aug 6, 4:59am' })
const snap = (parts: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  account: null,
  session: null,
  weekAll: null,
  weekModel: null,
  capturedAt: '2026-08-05T12:00:00.000Z',
  ...parts,
})

test('the default window is the weekly cap, not the 5-hour session', () => {
  // The Usage column decides whether an account is worth starting on; the 5-hour reading comes back
  // the same day, so defaulting to it made rows drop out and back in over an afternoon.
  expect(DEFAULT_USAGE_FILTER_SCOPE).toBe('week')
  const sessionSpent = snap({ session: limit(97), weekAll: limit(12) })
  expect(usageFilterPct(sessionSpent)).toBe(12)
  expect(isOverUsageThreshold(sessionSpent, 80)).toBe(false)
})

test('a window that has already reset counts as UNKNOWN, never as spent', () => {
  // The sharpest form of the "unknown is not exhausted" rule: an 11-day-old snapshot at 100% would
  // otherwise hide a fully-reset account from the table indefinitely (owner-reported 2026-08-07).
  const NOW = new Date(Date.UTC(2026, 7, 6, 12, 0, 0))
  const past = new Date(NOW.getTime() - 11 * 24 * 60 * 60_000).toISOString()
  const superseded = snap({
    session: { pct: 100, resets: 'Jul 26, 4am', resetsAt: past },
    weekAll: { pct: 100, resets: 'Jul 26, 4am', resetsAt: past },
  })
  expect(usageFilterPct(superseded, 'week', NOW)).toBeNull()
  expect(usageFilterPct(superseded, 'either', NOW)).toBeNull()
  expect(isOverUsageThreshold(superseded, 80, 'week', NOW)).toBe(false)

  // ...while the window that is still running keeps deciding the filter on its own.
  const mixed = snap({
    session: {
      pct: 97,
      resets: 'Aug 6, 2pm',
      resetsAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
    },
    weekAll: { pct: 100, resets: 'Jul 26, 4am', resetsAt: past },
  })
  expect(usageFilterPct(mixed, 'either', NOW)).toBe(97)
  expect(usageFilterPct(mixed, 'week', NOW)).toBeNull()
})

test('either takes whichever window is closest to its cap', () => {
  const s = snap({ session: limit(97), weekAll: limit(12) })
  expect(usageFilterPct(s, 'either')).toBe(97)
  expect(usageFilterPct(s, 'week')).toBe(12)
  expect(usageFilterPct(s, 'session')).toBe(97)
})

test('either falls back to whichever single window has a reading', () => {
  expect(usageFilterPct(snap({ weekAll: limit(40) }), 'either')).toBe(40)
  expect(usageFilterPct(snap({ session: limit(40) }), 'either')).toBe(40)
  expect(usageFilterPct(snap(), 'either')).toBeNull()
})

test('an unknown reading is never filtered on the default scope either', () => {
  expect(isOverUsageThreshold(snap({ session: limit(100) }), 50)).toBe(false)
  expect(isOverUsageThreshold(snap(), 0)).toBe(false)
})

test('a scope with no reading is null, not zero', () => {
  // Zero would read as "0% used" and leave the row looking freshly available.
  expect(usageFilterPct(snap({ session: limit(99) }), 'week')).toBeNull()
  expect(usageFilterPct(null, 'week')).toBeNull()
  expect(usageFilterPct(undefined, 'either')).toBeNull()
})

test('an unknown reading is never filtered', () => {
  // The whole point: never-checked instances stay fully visible, whatever the threshold.
  expect(isOverUsageThreshold(snap(), 0, 'either')).toBe(false)
  expect(isOverUsageThreshold(null, 1, 'either')).toBe(false)
  expect(isOverUsageThreshold(undefined, 1, 'either')).toBe(false)
  expect(isOverUsageThreshold(snap({ session: limit(100) }), 50, 'week')).toBe(false)
})

test('the threshold is at-or-above', () => {
  const s = snap({ weekAll: limit(80) })
  expect(isOverUsageThreshold(s, 80, 'week')).toBe(true)
  expect(isOverUsageThreshold(s, 81, 'week')).toBe(false)
  expect(isOverUsageThreshold(s, 79, 'week')).toBe(true)
})

test('either matches when EITHER window is over, not only the weekly one', () => {
  const sessionSpent = snap({ session: limit(97), weekAll: limit(12) })
  expect(isOverUsageThreshold(sessionSpent, 80, 'either')).toBe(true)
  expect(isOverUsageThreshold(sessionSpent, 80, 'week')).toBe(false)
})

test('clampThreshold keeps a typed value inside 0-100 and rejects junk', () => {
  expect(clampThreshold('85')).toBe(85)
  expect(clampThreshold(800)).toBe(100)
  expect(clampThreshold(-5)).toBe(0)
  expect(clampThreshold(79.6)).toBe(80)
  // Junk keeps the previous value rather than snapping the filter to a default mid-edit.
  expect(clampThreshold('', 65)).toBe(65)
  expect(clampThreshold('abc', 65)).toBe(65)
  expect(clampThreshold(Number.NaN)).toBe(DEFAULT_USAGE_THRESHOLD)
})
