// web/src/lib/usage-catchup.ts — "which quota readings are worth re-checking when a window opens?"
//
// This replaced an unbounded Promise.all that force-probed EVERY instance the moment the lists
// arrived (measured 2026-08-07: 14 simultaneous probes, slowest 8.8s, on every open of the app).
// The three things that must not regress are exactly the three that made the old version wrong:
// a fresh reading is left alone, a MISSING reading is always fetched (that is the genuinely blank
// cell), and however many rows are due, they go out a couple at a time rather than all at once.
import { expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/lib/api'
import {
  needsUsageCatchup,
  runUsageCatchup,
  selectUsageCatchup,
  USAGE_CATCHUP_MAX_AGE_MS,
} from '../src/lib/usage-catchup'

const NOW = Date.parse('2026-08-07T12:00:00.000Z')

const snapAt = (capturedAt: string): UsageSnapshot => ({
  account: null,
  session: null,
  weekAll: null,
  weekModel: null,
  capturedAt,
})
const agedMs = (ms: number) => snapAt(new Date(NOW - ms).toISOString())

test('a reading inside the freshness window is left alone', () => {
  expect(needsUsageCatchup(agedMs(60_000), NOW)).toBe(false)
  expect(needsUsageCatchup(agedMs(USAGE_CATCHUP_MAX_AGE_MS - 1), NOW)).toBe(false)
})

test('a reading at or past the freshness window is due', () => {
  // At-or-past, not strictly-past: the boundary belongs with "re-check", matching how the filter's
  // own threshold comparison treats sitting exactly on the line.
  expect(needsUsageCatchup(agedMs(USAGE_CATCHUP_MAX_AGE_MS), NOW)).toBe(true)
  expect(needsUsageCatchup(agedMs(60 * 60_000), NOW)).toBe(true)
})

test('no snapshot at all is always due — that is the genuinely blank cell', () => {
  expect(needsUsageCatchup(undefined, NOW)).toBe(true)
  expect(needsUsageCatchup(null, NOW)).toBe(true)
})

test('an unparseable capturedAt counts as unknown, never as fresh', () => {
  // Treating a malformed timestamp as recent would pin a broken reading on screen indefinitely.
  expect(needsUsageCatchup(snapAt('not a date'), NOW)).toBe(true)
  expect(needsUsageCatchup(snapAt(''), NOW)).toBe(true)
})

test('selection keeps only the aged-out rows, in their original order', () => {
  const rows = [
    { id: 'fresh', snap: agedMs(1000) },
    { id: 'old', snap: agedMs(30 * 60_000) },
    { id: 'never', snap: undefined },
    { id: 'alsoFresh', snap: agedMs(2000) },
  ]
  const due = selectUsageCatchup(rows, (r) => r.snap, NOW)
  expect(due.map((r) => r.id)).toEqual(['old', 'never'])
})

test('a table whose readings are all fresh probes nothing at all', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: i, snap: agedMs(1000) }))
  expect(selectUsageCatchup(rows, (r) => r.snap, NOW)).toHaveLength(0)
})

test('the runner never exceeds its concurrency cap', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 12 }, (_, i) => i)
  await runUsageCatchup(
    items,
    async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
    },
    { concurrency: 2, staggerMs: 0 },
  )
  expect(peak).toBeLessThanOrEqual(2)
})

test('every item is attempted, and one failure does not abandon the queue', async () => {
  const seen: number[] = []
  const done = await runUsageCatchup(
    [1, 2, 3, 4],
    async (n) => {
      seen.push(n)
      if (n === 2) throw new Error('unreachable instance')
    },
    { concurrency: 1, staggerMs: 0 },
  )
  expect(seen.sort()).toEqual([1, 2, 3, 4])
  // The thrown item still counts as attempted — the row keeps its last reading and the next open
  // tries again; what must not happen is items 3 and 4 never being reached.
  expect(done).toBe(4)
})

test('it waits between probes rather than firing them together', async () => {
  const waits: number[] = []
  await runUsageCatchup([1, 2, 3], async () => {}, {
    concurrency: 1,
    staggerMs: 400,
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  // Two gaps for three items on a single lane — the stagger is between probes, not after the last.
  expect(waits).toEqual([400, 400])
})

test('an abort signal stops the queue mid-flight', async () => {
  const signal = { aborted: false }
  const seen: number[] = []
  await runUsageCatchup(
    [1, 2, 3, 4, 5],
    async (n) => {
      seen.push(n)
      if (n === 2) signal.aborted = true
    },
    { concurrency: 1, staggerMs: 0, signal },
  )
  // Leaving the tab must not leave a slow queue of network requests running behind you.
  expect(seen).toEqual([1, 2])
})
