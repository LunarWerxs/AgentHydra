// Cost routing (docs/COST-MODEL.md): the fractions, windows per week from stored samples, the decision.
import { afterAll, expect, test } from 'bun:test'
import { db } from '../src/db'
import {
  bucketOf,
  decideRoute,
  effectiveFraction,
  measuredWindowsPerWeek,
  type RoutingContext,
} from '../src/routing-cost'

const KEY = 'cli:test-routing-cost'
afterAll(() => {
  db.query('delete from usage_samples where key = ?').run(KEY)
})

test('effectiveFraction: a Pro plan at the research numbers is about 1.9% of list', () => {
  const f = effectiveFraction(20, 11.7, 1, 20.7)
  expect(f).toBeCloseTo(20 / (11.7 * 4.33 * 20.7), 10)
  expect(f).toBeGreaterThan(0.018)
  expect(f).toBeLessThan(0.02)
  // A Max 5x window is 4.75 Pro windows.
  expect(effectiveFraction(100, 9.8, 4.75, 20.7)).toBeCloseTo(0.0211, 3)
})

test('windowsPerWeek is the inverse of week-rise per session-rise, from stored samples', () => {
  db.query('delete from usage_samples where key = ?').run(KEY)
  const now = Date.now()
  const sessionReset = new Date(now + 3 * 3_600_000).toISOString()
  const weekReset = new Date(now + 3 * 86_400_000).toISOString()
  const ins = db.query(
    'insert into usage_samples (key, at, at_ms, session_pct, week_pct, week_resets_at, session_resets_at) values (?, ?, ?, ?, ?, ?, ?)',
  )
  // 50 samples 10 min apart: session +1 each step, week +0.1 each step => 10 session-% per week-%.
  for (let i = 0; i < 50; i++) {
    const t = now - (50 - i) * 600_000
    ins.run(KEY, new Date(t).toISOString(), t, i, 10 + i * 0.1, weekReset, sessionReset)
  }
  const got = measuredWindowsPerWeek([{ key: KEY, plan: 'Pro' }], now)
  expect(got.Pro.fellBack).toBe(false)
  expect(got.Pro.accounts).toBe(1)
  expect(got.Pro.value).toBeCloseTo(10, 5)
  // No account on the other plans: the research figures.
  expect(got['Max 5×']).toEqual({ value: 9.8, accounts: 0, fellBack: true })
  expect(got['Max 20×'].value).toBe(4.1)
})

test('an account with under 40 session points is ignored', () => {
  db.query('delete from usage_samples where key = ?').run(KEY)
  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    const t = now - (10 - i) * 600_000
    db.query(
      'insert into usage_samples (key, at, at_ms, session_pct, week_pct, week_resets_at, session_resets_at) values (?, ?, ?, ?, ?, null, null)',
    ).run(KEY, new Date(t).toISOString(), t, i, i / 10)
  }
  expect(measuredWindowsPerWeek([{ key: KEY, plan: 'Pro' }], now).Pro.fellBack).toBe(true)
})

const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  enabled: true,
  apiPreferencePct: 60,
  closeRatio: 3,
  discounts: { anthropic: 0, deepseek: 0, openrouter: 0, other: 0 },
  sessionOverheadPct: 0,
  dollarsPerProWindow: 20.7,
  fleetFraction: 0.02,
  ...over,
})
const api = (usd: number, provider = 'deepseek') => ({ provider, model: 'example-model', usd })

test('outside the close band the cheaper side wins, both ways', () => {
  // subscription = 10 * 0.02 = 0.2
  expect(
    decideRoute({ key: 'a', listUsd: 10, api: api(0.01), subscriptionRoom: true }, ctx()).route,
  ).toBe('api')
  const sub = decideRoute({ key: 'a', listUsd: 10, api: api(5), subscriptionRoom: true }, ctx())
  expect(sub.route).toBe('subscription')
  expect(sub.close).toBe(false)
})

test('inside the band the split is deterministic per key; 0 and 100 send everything one way', () => {
  const input = (key: string) => ({ key, listUsd: 10, api: api(0.3), subscriptionRoom: true })
  const keys = Array.from({ length: 200 }, (_, i) => `task-${i}`)
  const routes = keys.map((k) => decideRoute(input(k), ctx()).route)
  expect(keys.map((k) => decideRoute(input(k), ctx()).route)).toEqual(routes)
  expect(decideRoute(input('task-1'), ctx()).close).toBe(true)
  const apiShare = routes.filter((r) => r === 'api').length / keys.length
  expect(apiShare).toBeGreaterThan(0.45)
  expect(apiShare).toBeLessThan(0.75)
  for (const k of keys) {
    expect(decideRoute(input(k), ctx({ apiPreferencePct: 0 })).route).toBe('subscription')
    expect(decideRoute(input(k), ctx({ apiPreferencePct: 100 })).route).toBe('api')
  }
  expect(bucketOf('task-1')).toBeLessThan(100)
})

test('no room, disabled, no list cost -> api; no API model -> subscription', () => {
  const base = { key: 'k', listUsd: 10, api: api(0.01), subscriptionRoom: true }
  expect(decideRoute({ ...base, api: api(50), subscriptionRoom: false }, ctx()).route).toBe('api')
  expect(decideRoute({ ...base, api: api(50) }, ctx({ enabled: false })).route).toBe('api')
  expect(decideRoute({ ...base, api: api(50), listUsd: null }, ctx()).route).toBe('api')
  expect(decideRoute({ ...base, api: null }, ctx()).route).toBe('subscription')
})

test('a discount changes the outcome', () => {
  const input = { key: 'k', listUsd: 10, api: api(0.7, 'anthropic'), subscriptionRoom: true }
  // subscription 0.2; API 0.7 is 3.5x: the subscription wins.
  expect(decideRoute(input, ctx()).route).toBe('subscription')
  // 50% off anthropic: 0.35 is within 3x, so the call is close; with preference 100 it goes to the API.
  const d = decideRoute(
    input,
    ctx({
      discounts: { anthropic: 50, deepseek: 0, openrouter: 0, other: 0 },
      apiPreferencePct: 100,
    }),
  )
  expect(d.apiUsd).toBeCloseTo(0.35, 10)
  expect(d.close).toBe(true)
  expect(d.route).toBe('api')
})
