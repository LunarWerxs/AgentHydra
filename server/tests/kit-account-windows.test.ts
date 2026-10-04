import { afterAll, describe, expect, test } from 'bun:test'
import { accountTokenWindows } from '../src/kit/account-windows'
import { KitStore, type UsageEventInput } from '../src/kit/store'

const H = 3_600_000
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

const store = new KitStore(':memory:')
afterAll(() => store.close())

let n = 0
const ev = (account: string, ago: number, input: number, output = 0): UsageEventInput => ({
  id: `e${++n}`,
  ts: NOW - ago,
  source: 'cli',
  account,
  input,
  output,
  cache_read: 1000,
  cache_write_5m: 100,
  cache_write_1h: 10,
})

// Quota resets: A's 5h window began 1h ago (reset in 4h), its week began 2 days ago (reset in 5 days).
// B has no snapshot, so both its windows roll back from now.
const resets = {
  'acct-a': {
    sessionResetsAt: new Date(NOW + 4 * H).toISOString(),
    weekResetsAt: new Date(NOW + 5 * 24 * H).toISOString(),
  },
}
const quota = (a: string) => (resets as Record<string, (typeof resets)['acct-a']>)[a] ?? null

store.upsertEvents([
  // A: 5h edge is NOW-1h; week edge is NOW-2d.
  ev('acct-a', 30 * 60_000, 1), // inside both
  ev('acct-a', 61 * 60_000, 2), // before the 5h edge, inside the week
  ev('acct-a', 47 * H, 4), // inside the week, just
  ev('acct-a', 49 * H, 8), // before the week edge
  // B: rolling 5h (NOW-5h) and rolling week (NOW-7d).
  ev('acct-b', 4 * H, 16), // inside both
  ev('acct-b', 6 * H, 32), // out of 5h, inside week
  ev('acct-b', 8 * 24 * H, 64), // out of both
])

describe('accountTokenWindows', () => {
  const out = accountTokenWindows(['acct-a', 'acct-b', 'acct-none'], { store, now: NOW, quota })

  test('a snapshot cuts the 5h and week windows at the reset minus the span', () => {
    const a = out.get('acct-a')
    expect(a?.fiveHour.input).toBe(1)
    expect(a?.week.input).toBe(1 + 2 + 4)
    expect(a?.total.input).toBe(1 + 2 + 4 + 8)
  })

  test('an account with no snapshot rolls back from now', () => {
    const b = out.get('acct-b')
    expect(b?.fiveHour.input).toBe(16)
    expect(b?.week.input).toBe(16 + 32)
    expect(b?.total.input).toBe(16 + 32 + 64)
  })

  test('parts keep the four kinds apart and total is their sum', () => {
    const t = out.get('acct-b')?.fiveHour
    expect(t).toEqual({ input: 16, output: 0, cacheRead: 1000, cacheWrite: 110, total: 1126 })
  })

  test('an account with no events reads as zeros', () => {
    expect(out.get('acct-none')?.total.total).toBe(0)
  })
})

describe('accountTokenWindows over a rolled-up store', () => {
  test('whole hours come from the rollup, partial edge hours from raw rows, and a write shows at once', () => {
    const s = new KitStore(':memory:')
    // 20 min past the hour so every window edge cuts through an hour.
    const now = Date.UTC(2026, 5, 15, 12, 20, 0)
    const at = (id: string, ago: number, input: number): UsageEventInput => ({
      id,
      ts: now - ago,
      source: 'cli',
      account: 'acct-r',
      input,
    })
    s.upsertEvents([
      at('r1', 10 * 60_000, 1), // in the 5h window, current hour
      at('r2', 4 * H, 2), // in the 5h window, whole hour
      at('r3', 5 * H + 10 * 60_000, 4), // before the rolling 5h edge (12:20 - 5h = 07:20), same hour as edge
      at('r4', 3 * 24 * H, 8), // inside the week only
    ])
    const raw = accountTokenWindows(['acct-r'], { store: s, now, quota: () => null })
    s.rollup()
    const rolled = accountTokenWindows(['acct-r'], { store: s, now, quota: () => null })
    expect(rolled.get('acct-r')).toEqual(raw.get('acct-r'))
    expect(rolled.get('acct-r')?.fiveHour.input).toBe(1 + 2)
    expect(rolled.get('acct-r')?.week.input).toBe(1 + 2 + 4 + 8)

    s.upsertEvents([at('r5', 60_000, 16)])
    const after = accountTokenWindows(['acct-r'], { store: s, now, quota: () => null })
    expect(after.get('acct-r')?.fiveHour.input).toBe(1 + 2 + 16)
    expect(after.get('acct-r')?.total.input).toBe(1 + 2 + 4 + 8 + 16)
    s.close()
  })
})
