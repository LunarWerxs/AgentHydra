// web/src/lib/usage-filter.ts — the rule behind "dim/hide the accounts I've already spent".
//
// Four behaviours worth pinning down, each one a careless rewrite away from breaking: the two quota
// windows carry SEPARATE thresholds and are OR'd (an account can be cheap this week and exhausted
// for the next 5 hours, and those are different lines), a window the rule isn't measuring must be
// ignored entirely, an UNKNOWN reading must never count as over the limit (it would silently drop
// usable accounts out of the table), and the carry-over from the old single-threshold `scope`
// setting must land on the rule that behaves identically.
import { expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/lib/api'
import {
  clampThreshold,
  DEFAULT_USAGE_THRESHOLD,
  isEmptyRule,
  matchesUsageFilter,
  migrateLegacyUsageFilterScope,
  ruleFromLegacyScope,
  USAGE_FILTER_KEY,
  usageFilterReadings,
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
/** The default rule: weekly on at 80, the 5-hour window off. */
const WEEK_ONLY = { week: DEFAULT_USAGE_THRESHOLD, session: null }

test('the default rule measures the weekly cap, not the 5-hour session', () => {
  // The Usage column decides whether an account is worth starting on; the 5-hour reading comes back
  // the same day, so having it filter by default made rows drop out and back in over an afternoon.
  const sessionSpent = snap({ session: limit(97), weekAll: limit(12) })
  expect(usageFilterReadings(sessionSpent)).toEqual({ week: 12, session: 97 })
  expect(matchesUsageFilter(sessionSpent, WEEK_ONLY)).toBe(false)
})

test('each window carries its OWN threshold', () => {
  // The whole reason the single-threshold `scope` tri-toggle was replaced: "set it aside at 80% of
  // the week, but already at 50% of this session" cannot be said with one number.
  const s = snap({ session: limit(60), weekAll: limit(40) })
  expect(matchesUsageFilter(s, { week: 80, session: 50 })).toBe(true)
  expect(matchesUsageFilter(s, { week: 80, session: 70 })).toBe(false)
  expect(matchesUsageFilter(s, { week: 30, session: 70 })).toBe(true)
})

test('the windows are OR-ed: either one over is enough', () => {
  const sessionSpent = snap({ session: limit(97), weekAll: limit(12) })
  const weekSpent = snap({ session: limit(4), weekAll: limit(91) })
  expect(matchesUsageFilter(sessionSpent, { week: 80, session: 80 })).toBe(true)
  expect(matchesUsageFilter(weekSpent, { week: 80, session: 80 })).toBe(true)
})

test('a window the rule is not measuring is ignored, however spent it is', () => {
  const bothSpent = snap({ session: limit(100), weekAll: limit(100) })
  expect(matchesUsageFilter(bothSpent, { week: null, session: 80 })).toBe(true)
  expect(matchesUsageFilter(bothSpent, { week: 80, session: null })).toBe(true)
  // A rule measuring nothing matches nothing — the filter switched on and told to check no window.
  expect(matchesUsageFilter(bothSpent, { week: null, session: null })).toBe(false)
  expect(isEmptyRule({ week: null, session: null })).toBe(true)
  expect(isEmptyRule({ week: null, session: 0 })).toBe(false)
})

test('null is "not measured", 0 is a real (and total) threshold', () => {
  // The distinction the whole rule shape rests on: every known reading is at or above 0%.
  const fresh = snap({ session: limit(0), weekAll: limit(0) })
  expect(matchesUsageFilter(fresh, { week: 0, session: null })).toBe(true)
  expect(matchesUsageFilter(fresh, { week: null, session: null })).toBe(false)
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
  expect(usageFilterReadings(superseded, NOW)).toEqual({ week: null, session: null })
  expect(matchesUsageFilter(superseded, { week: 80, session: 80 }, NOW)).toBe(false)

  // ...while the window that is still running keeps deciding the filter on its own.
  const mixed = snap({
    session: {
      pct: 97,
      resets: 'Aug 6, 2pm',
      resetsAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
    },
    weekAll: { pct: 100, resets: 'Jul 26, 4am', resetsAt: past },
  })
  expect(usageFilterReadings(mixed, NOW)).toEqual({ week: null, session: 97 })
  expect(matchesUsageFilter(mixed, { week: 80, session: 80 }, NOW)).toBe(true)
  expect(matchesUsageFilter(mixed, WEEK_ONLY, NOW)).toBe(false)
})

test('a window with no reading is null, not zero', () => {
  // Zero would read as "0% used" and leave the row looking freshly available.
  expect(usageFilterReadings(snap({ session: limit(99) })).week).toBeNull()
  expect(usageFilterReadings(null)).toEqual({ week: null, session: null })
  expect(usageFilterReadings(undefined)).toEqual({ week: null, session: null })
})

test('an unknown reading is never filtered, at any threshold', () => {
  // The whole point: never-checked instances stay fully visible, whatever the thresholds say.
  expect(matchesUsageFilter(snap(), { week: 0, session: 0 })).toBe(false)
  expect(matchesUsageFilter(null, { week: 1, session: 1 })).toBe(false)
  expect(matchesUsageFilter(undefined, { week: 1, session: 1 })).toBe(false)
  expect(matchesUsageFilter(snap({ session: limit(100) }), WEEK_ONLY)).toBe(false)
})

test('the threshold is at-or-above', () => {
  const s = snap({ weekAll: limit(80) })
  expect(matchesUsageFilter(s, { week: 80, session: null })).toBe(true)
  expect(matchesUsageFilter(s, { week: 81, session: null })).toBe(false)
  expect(matchesUsageFilter(s, { week: 79, session: null })).toBe(true)
})

test('the legacy scope setting carries over to the rule that behaves identically', () => {
  // Upgrading must not silently re-point someone's filter at a different window. 'either' shared one
  // number across both, so both thresholds inherit it.
  expect(ruleFromLegacyScope('week', 70)).toEqual({ week: 70, session: null })
  expect(ruleFromLegacyScope('session', 70)).toEqual({ week: null, session: 70 })
  expect(ruleFromLegacyScope('either', 70)).toEqual({ week: 70, session: 70 })
  // Anything unrecognised (or absent) lands on the default window rather than on "measure nothing".
  expect(ruleFromLegacyScope(null, 70)).toEqual({ week: 70, session: null })
  expect(ruleFromLegacyScope('nonsense', 70)).toEqual({ week: 70, session: null })
})

// --- the stored carry-over ----------------------------------------------------------------------
// Same shape of regression as storage-rebrand.test.ts: if this breaks nothing throws and nothing
// logs, the filter just quietly starts measuring a different window than the user chose.

/** Minimal Storage over a Map. `throwOn` exercises the private-browsing path. */
function stubStorage(initial: Record<string, string> = {}, throwOn?: 'setItem'): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOn === 'setItem') throw new Error('quota exceeded')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
  } as Storage
}
const snapshotStore = (store: Storage): Record<string, string> => {
  const out: Record<string, string> = {}
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)
    if (k !== null) out[k] = store.getItem(k) ?? ''
  }
  return out
}

test('a stored scope becomes the matching per-window switches, once', () => {
  const store = stubStorage({
    [`${USAGE_FILTER_KEY}.scope2`]: 'either',
    [`${USAGE_FILTER_KEY}.threshold`]: '70',
  })
  migrateLegacyUsageFilterScope(store)
  expect(snapshotStore(store)).toEqual({
    [`${USAGE_FILTER_KEY}.threshold`]: '70',
    [`${USAGE_FILTER_KEY}.week`]: 'true',
    [`${USAGE_FILTER_KEY}.session`]: 'true',
    [`${USAGE_FILTER_KEY}.sessionThreshold`]: '70',
  })
  // Idempotent: the legacy key is gone, so a second pass cannot re-derive over a later choice.
  const afterFirst = snapshotStore(store)
  migrateLegacyUsageFilterScope(store)
  expect(snapshotStore(store)).toEqual(afterFirst)
})

test("the 5h-only scope survives as 5h-only, and doesn't switch the weekly window on", () => {
  // The case a naive migration loses: 'session' meant "ignore the weekly cap entirely".
  const store = stubStorage({
    [`${USAGE_FILTER_KEY}.scope2`]: 'session',
    [`${USAGE_FILTER_KEY}.threshold`]: '90',
  })
  migrateLegacyUsageFilterScope(store)
  expect(store.getItem(`${USAGE_FILTER_KEY}.week`)).toBe('false')
  expect(store.getItem(`${USAGE_FILTER_KEY}.session`)).toBe('true')
  expect(store.getItem(`${USAGE_FILTER_KEY}.sessionThreshold`)).toBe('90')
})

test('a scope stored without a threshold lands on the default, not on 0', () => {
  // localStorage.getItem returns null for a never-written key, and Number(null) is 0 — which as a
  // threshold means "filter every instance that has any reading at all".
  const store = stubStorage({ [`${USAGE_FILTER_KEY}.scope2`]: 'week' })
  migrateLegacyUsageFilterScope(store)
  expect(store.getItem(`${USAGE_FILTER_KEY}.sessionThreshold`)).toBe(
    String(DEFAULT_USAGE_THRESHOLD),
  )
})

test('values already in the new shape win over a stale legacy scope', () => {
  // Downgrade to a build that still wrote scope2, then upgrade again.
  const store = stubStorage({
    [`${USAGE_FILTER_KEY}.scope2`]: 'week',
    [`${USAGE_FILTER_KEY}.week`]: 'false',
    [`${USAGE_FILTER_KEY}.session`]: 'true',
  })
  migrateLegacyUsageFilterScope(store)
  expect(snapshotStore(store)).toEqual({
    [`${USAGE_FILTER_KEY}.week`]: 'false',
    [`${USAGE_FILTER_KEY}.session`]: 'true',
  })
})

test('a fresh install is left completely alone', () => {
  const store = stubStorage({ [`${USAGE_FILTER_KEY}.enabled`]: 'true' })
  migrateLegacyUsageFilterScope(store)
  expect(snapshotStore(store)).toEqual({ [`${USAGE_FILTER_KEY}.enabled`]: 'true' })
})

test('storage that throws mid-write does not take the app down', () => {
  const store = stubStorage({ [`${USAGE_FILTER_KEY}.scope2`]: 'either' }, 'setItem')
  expect(() => migrateLegacyUsageFilterScope(store)).not.toThrow()
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
  // A MISSING setting is junk too: Number(null) is 0, which would silently mean "filter everything".
  expect(clampThreshold(null, 65)).toBe(65)
  expect(clampThreshold(undefined, 65)).toBe(65)
})
