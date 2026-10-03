// web/src/lib/home-charts.ts: the hour buckets (newest hour last, outside the window dropped), the
// outcome split, and the headroom sort/reset rules.
import { expect, test } from 'bun:test'
import {
  countPerHour,
  type HeadroomRow,
  sortHeadroom,
  usedPct,
  workersPerHour,
} from '../src/lib/home-charts'

const H = 3_600_000
const asOf = Date.UTC(2026, 9, 3, 12, 30)
const noon = Date.UTC(2026, 9, 3, 12, 0)

test('events land in clock-hour buckets, newest hour last; older than the window or future is dropped', () => {
  const counts = countPerHour(
    [asOf, noon, noon - 1, noon - 23 * H, noon - 24 * H - 1, asOf + H],
    asOf,
    24,
  )
  expect(counts[23]).toBe(2)
  expect(counts[22]).toBe(1)
  expect(counts[0]).toBe(1)
  expect(counts.reduce((a, b) => a + b, 0)).toBe(4)
})

test('workers split by outcome: cancelled counts as failed, unfinished as running', () => {
  const out = workersPerHour(
    [
      { createdAt: noon, status: 'done' },
      { createdAt: noon, status: 'cancelled' },
      { createdAt: noon, status: 'waiting' },
      { createdAt: noon, status: 'failed' },
    ],
    asOf,
    24,
  )
  expect(out[23]).toEqual({ done: 1, failed: 2, running: 1 })
})

test('headroom sorts the most used first and drops accounts with no reading', () => {
  const row = (key: string, session: number | null, week: number | null): HeadroomRow => ({
    key,
    label: key,
    session,
    week,
    to: 'cli',
  })
  const sorted = sortHeadroom([
    row('a', 10, 20),
    row('none', null, null),
    row('b', 5, 90),
    row('c', 60, null),
  ])
  expect(sorted.map((r) => r.key)).toEqual(['b', 'c', 'a'])
})

test('a window past its reset reads 0% used, whatever % was stored', () => {
  expect(usedPct({ pct: 80, resetsAt: new Date(asOf - 1000).toISOString() }, asOf)).toBe(0)
  expect(usedPct({ pct: 80, resetsAt: new Date(asOf + 1000).toISOString() }, asOf)).toBe(80)
  expect(usedPct(null, asOf)).toBeNull()
})
