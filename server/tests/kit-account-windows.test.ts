import { afterAll, describe, expect, test } from 'bun:test'
import { accountTokenWindows, accountTokenWindowsAsync } from '../src/kit/account-windows'
import { KitStore, type UsageEventInput } from '../src/kit/store'

const H = 3_600_000
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

const store = new KitStore(':memory:', { now: NOW })
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

  test('the async read, a turn of the loop between accounts, gives the same answer', async () => {
    const ids = ['acct-a', 'acct-b', 'acct-none']
    const sync = accountTokenWindows(ids, { store, now: NOW, quota })
    // reversed: a different cache key, so the read really runs
    const asynced = await accountTokenWindowsAsync([...ids].reverse(), { store, now: NOW, quota })
    for (const id of ids) expect(asynced.get(id)).toEqual(sync.get(id))
  })

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
    const s = new KitStore(':memory:', { now: NOW })
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

describe('accountTokenWindows during a long ingest', () => {
  test('hours the ingest has already rolled up are read from the rollup, not from every raw row', async () => {
    const s = new KitStore(':memory:', { now: NOW })
    s.rollupEveryMs = 0
    // more than one write slice, spread over 20 days: an ingest that only rolled up at its end would
    // leave the oldest hour dirty all along, and every reader would walk the raw rows
    const evs = Array.from({ length: 1100 }, (_, i) => ({
      id: `g${i}`,
      ts: NOW - 20 * 24 * H + i * 26 * 60_000,
      source: 'cli',
      account: 'acct-g',
      input: 1,
    }))
    await s.upsertEventsAsync(evs)
    const dirty = s.dirtyFrom()
    expect(dirty === null || dirty > NOW - 10 * 24 * H).toBe(true)
    const read = () =>
      accountTokenWindows(['acct-g'], { store: s, now: NOW, quota: () => null }).get('acct-g')
    expect(read()?.total.input).toBe(1100)
    // tamper with the raw rows: a reader that still used them for the rolled hours would see it
    s.db.exec('update usage_event set input = 5')
    expect(read()?.total.input).toBe(1100)
    s.close()
  })
})

describe('accountTokenWindows with an old dirty hour', () => {
  test('a dirty hour near the raw cut with a great many raw rows after it does not send the reader to them, the newest two hours still come from them', () => {
    const s = new KitStore(':memory:', { now: NOW })
    s.rawTailRows = 2
    const at = (ago: number, input: number, id: string) => ({
      id,
      ts: NOW - ago,
      source: 'cli',
      account: 'acct-d',
      input,
    })
    s.upsertEvents([at(30 * 24 * H, 1, 'old'), at(3 * H, 2, 'mid'), at(30 * 60_000, 4, 'new')])
    s.runMaintenance(NOW)
    // a long ingest left the oldest hour dirty
    s.db
      .query('insert or ignore into dirty_hour (hour) values (?)')
      .run(Math.floor((NOW - 30 * 24 * H) / H) * H)
    // the raw rows now say something else: only the rows the reader still reads raw show it
    s.db.exec('update usage_event set input = input * 100')
    const read = () =>
      accountTokenWindows(['acct-d'], { store: s, now: NOW, quota: () => null }).get('acct-d')
    // old and mid from the rollup (1 + 2), the half hour old call from raw (4 * 100)
    expect(read()?.total.input).toBe(1 + 2 + 400)
    s.close()
  })

  test('a dirty hour with few raw rows after it is read from them, exactly', () => {
    const s = new KitStore(':memory:', { now: NOW })
    const at = (ago: number, input: number, id: string) => ({
      id,
      ts: NOW - ago,
      source: 'cli',
      account: 'acct-d',
      input,
    })
    s.upsertEvents([at(30 * 24 * H, 1, 'old'), at(3 * H, 2, 'mid'), at(30 * 60_000, 4, 'new')])
    s.runMaintenance(NOW)
    // a long ingest left the oldest hour dirty
    s.db
      .query('insert or ignore into dirty_hour (hour) values (?)')
      .run(Math.floor((NOW - 30 * 24 * H) / H) * H)
    // the raw rows now say something else: only the rows the reader still reads raw show it
    s.db.exec('update usage_event set input = input * 100')
    const read = () =>
      accountTokenWindows(['acct-d'], { store: s, now: NOW, quota: () => null }).get('acct-d')
    expect(read()?.total.input).toBe(700)
    s.close()
  })
})
