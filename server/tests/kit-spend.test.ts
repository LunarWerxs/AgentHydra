import { afterAll, expect, test } from 'bun:test'
import { forEachCallSince, spendSince } from '../src/kit/spend'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { defaultConfigDir } from '../src/usage-tokens'

const H = 3_600_000
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const store = new KitStore(':memory:', { now: NOW })
afterAll(() => store.close())

let n = 0
const ev = (instance: string, source: string, ago: number, input: number): UsageEventInput => ({
  id: `e${++n}`,
  ts: NOW - ago,
  source,
  instance,
  model: 'claude-sonnet-5-5',
  input,
  output: 2,
  cache_read: 10,
  cache_write_5m: 3,
  cache_write_1h: 4,
  weighted: input,
})

store.upsertEvents([
  ev('default', 'cli', H, 100),
  ev('desktop:1', 'desktop', 2 * H, 20),
  ev('cli:other', 'cli', H, 1000),
  ev('default', 'cli', 7 * H, 5),
])

test('the default login counts its shared store (default and desktop chats), inside the window only', async () => {
  const dirs = [defaultConfigDir()]
  const spend = spendSince(new Date(NOW - 6 * H), dirs, { store, now: NOW, quota: () => null })
  expect(spend.turns).toBe(2)
  expect(spend.input).toBe(120)
  expect(spend.cacheCreation).toBe(14)
  expect(spend.weighted).toBe(120)
  const turns: number[] = []
  await forEachCallSince(new Date(NOW - 6 * H), dirs, (ts) => turns.push(ts), {
    store,
    now: NOW,
    quota: () => null,
  })
  expect(turns).toEqual([NOW - 2 * H, NOW - H])
})

test('an unknown config dir reads as no spend', () => {
  const spend = spendSince(new Date(NOW - 6 * H), ['/nowhere/else'], {
    store,
    now: NOW,
    quota: () => null,
  })
  expect(spend.turns).toBe(0)
})

test('whole hours of a rolled-up store come from the hourly rollup, stamped at the hour middle', async () => {
  const s = new KitStore(':memory:', { now: NOW })
  s.upsertEvents([
    ev('default', 'cli', 5 * H + 10 * 60_000, 7),
    ev('default', 'cli', 20 * 60_000, 9),
  ])
  s.rollup()
  const seen: [number, number][] = []
  await forEachCallSince(
    new Date(NOW - 8 * H),
    [defaultConfigDir()],
    (ts, m) => seen.push([ts, m['claude-sonnet-5-5']?.turns ?? 0]),
    { store: s, now: NOW, quota: () => null },
  )
  // The older call is one whole-hour group at 06:30; the recent one stays a per-minute group.
  expect(seen).toEqual([
    [NOW - 6 * H + H / 2, 1],
    [NOW - 20 * 60_000, 1],
  ])
  s.close()
})
