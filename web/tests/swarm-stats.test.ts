// web/src/lib/swarm-stats.ts: the 7-day window, the sparkline order, "not measured" vs 0, and the
// shared poll. The feed's `days` is OLDEST FIRST (the newest day is last), like the real answer.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { effectScope } from 'vue'
import { API_BASE } from '../src/lib/api'
import {
  lastDaysSaved,
  POLL_MS,
  type SwarmStatsData,
  sparklineSeries,
  useSwarmStats,
} from '../src/lib/swarm-stats'

const day = (n: number, saved: number | null) => ({
  day: `2026-09-${String(n).padStart(2, '0')}`,
  saved_usd: saved,
})

test('last 7 days are the NEWEST seven: the last entries of an oldest-first list', () => {
  const days = [
    day(1, 1000),
    day(2, 1000),
    day(3, 1),
    day(4, 2),
    day(5, 3),
    day(6, 4),
    day(7, 5),
    day(8, 6),
    day(9, 7),
  ]
  expect(lastDaysSaved(days, 7)).toEqual({ sum: 28, measured: 7, total: 7 })
})

test('fewer than seven days sums what there is', () => {
  expect(lastDaysSaved([day(1, 10), day(2, 5)], 7)).toEqual({ sum: 15, measured: 2, total: 2 })
})

test('a null day is not measured: left out of the sum and of the measured count, never 0', () => {
  const r = lastDaysSaved([day(1, 10), day(2, null), day(3, 5)], 7)
  expect(r).toEqual({ sum: 15, measured: 2, total: 3 })
})

test('a window with no measured day has no sum at all (null, not 0)', () => {
  expect(lastDaysSaved([day(1, null), day(2, null)], 7).sum).toBeNull()
  expect(lastDaysSaved([], 7)).toEqual({ sum: null, measured: 0, total: 0 })
})

test('a measured zero stays a zero', () => {
  expect(lastDaysSaved([day(1, 0), day(2, 0)], 7).sum).toBe(0)
})

test('sparkline keeps the given oldest-to-newest order and keeps null as null', () => {
  const s = sparklineSeries([day(1, 5), day(2, null), day(3, 7)])
  expect(s.map((p) => p.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  expect(s.map((p) => p.value)).toEqual([5, null, 7])
})

const answer: SwarmStatsData = {
  source: 'zswarm',
  empty: false,
  total: { saved_usd: 100 },
  days: [day(1, 1)],
  today: { saved_usd: 1, tasks: 2, est_tokens: 3 },
}
const realFetch = globalThis.fetch
let calls: string[] = []

beforeEach(() => {
  jest.useFakeTimers()
  calls = []
  globalThis.fetch = (async (url: string) => {
    calls.push(url)
    return { ok: true, json: async () => answer } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('two users of useSwarmStats(14) share ONE fetch, and the poll stops after the last unmount', async () => {
  const a = effectScope()
  const b = effectScope()
  const first = a.run(() => useSwarmStats(14))
  const second = b.run(() => useSwarmStats(14))
  await flush()
  expect(calls).toEqual([`${API_BASE}/api/hswarm/api/stats?days=14`])
  expect(first?.stats.value?.total.saved_usd).toBe(100)
  expect(second?.stats.value).toBe(first?.stats.value ?? null)

  jest.advanceTimersByTime(POLL_MS)
  await flush()
  expect(calls).toHaveLength(2)

  a.stop()
  jest.advanceTimersByTime(POLL_MS)
  await flush()
  expect(calls).toHaveLength(3)

  b.stop()
  jest.advanceTimersByTime(POLL_MS * 3)
  await flush()
  expect(calls).toHaveLength(3)
})

test('a fetch that fails marks it offline', async () => {
  globalThis.fetch = (async () => {
    throw new Error('refused')
  }) as unknown as typeof fetch
  const scope = effectScope()
  const u = scope.run(() => useSwarmStats(14))
  await flush()
  expect(u?.offline.value).toBe(true)
  scope.stop()
})
