// server/tests/analytics-window.test.ts — what the Analytics tab's spend report counts, and over
// which window, now that it reads the analytics toolkit instead of per-session totals.
//
// THE FAILURES THESE PIN. (1) A window used to be applied per SESSION, with a day-proportioned
// approximation, so "last 7 days" on a machine that runs marathon sessions was neither the last 7
// days nor anything you could name. The toolkit has one row per call with its own timestamp, so a
// window must cut a session exactly where the calls are. (2) The tab counted desktop chats only:
// every CLI account's spend was missing from the totals and `byAccount` was always empty.
// (3) The source filter has to narrow EVERY figure, not just one panel.

import { afterAll, describe, expect, test } from 'bun:test'
import { spendReport } from '../src/analytics'
import { db } from '../src/db'
import { KitStore, type UsageEventInput } from '../src/kit/store'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

const store = new KitStore(':memory:')
afterAll(() => store.close())

let n = 0
const call = (ago: number, e: Partial<UsageEventInput>): UsageEventInput => ({
  id: `w${++n}`,
  ts: NOW - ago,
  source: 'cli',
  model: 'claude-opus-5',
  provider: 'anthropic',
  input: 100,
  output: 50,
  cache_read: 1000,
  list_usd: 1,
  weighted: 10,
  ...e,
})

const report = (o: { sinceMs?: number | null; sources?: string[] } = {}) =>
  spendReport({ store, now: NOW, ...o })

// A marathon CLI session: one call 8 days ago, one yesterday.
// A desktop chat and a CliMayte call on another account, both inside the last day.
// An OpenCode call the provider billed itself, and an unpriced model.
db.query(
  'insert or replace into session_stats (session_key, session_id, source, cwd, first_seen_at, last_scanned_at) values (?, ?, ?, ?, 1, 2)',
).run('claude:win-marathon', 'win-marathon', 'claude', 'D:\\work\\Alpha')
store.upsertEvents([
  call(8 * D, { account: 'acct-a', instance: 'cli:1', session: 'win-marathon' }),
  call(1 * D, { account: 'acct-a', instance: 'cli:1', session: 'win-marathon' }),
  call(2 * H, {
    source: 'desktop',
    account: 'acct-b',
    instance: 'desktop:x',
    session: 'win-desk',
    list_usd: 2,
    weighted: 20,
  }),
  call(3 * H, {
    source: 'climayte',
    account: 'acct-a',
    instance: 'cli:1',
    session: 'win-cm',
    model: 'claude-sonnet-5-5',
    list_usd: 4,
    weighted: 5,
  }),
  call(4 * H, {
    source: 'opencode',
    session: 'win-oc',
    model: 'some-routed-model',
    list_usd: null,
    billed_usd: 0.5,
    weighted: 1,
  }),
  call(5 * H, {
    source: 'codex',
    session: 'win-cx',
    model: 'no-price-model',
    list_usd: null,
    weighted: 1,
  }),
])

describe('the window cuts a session where its calls are', () => {
  test('only the marathon session’s in-window call counts, not its whole life', () => {
    const r = report({ sinceMs: NOW - 7 * D, sources: ['cli'] })
    expect(r.calls).toBe(1)
    expect(r.totalCostUsd).toBe(1)
    expect(r.tokens.total).toBe(1150)
  })

  test('no window counts every call', () => {
    expect(report().calls).toBe(6)
  })

  test('the window is exact to the hour, not to the day', () => {
    // 2.5 h back: the desktop call (2 h) is in, the CliMayte call (3 h) is out.
    const r = report({ sinceMs: NOW - 2.5 * H, sources: ['desktop', 'climayte'] })
    expect(r.bySource.map((b) => b.key)).toEqual(['desktop'])
  })
})

describe('the totals cover every account, not desktop alone', () => {
  const r = report({ sinceMs: NOW - 7 * D })

  test('CLI, desktop and CliMayte spend are all in the total', () => {
    expect(r.bySource.map((b) => b.key).sort()).toEqual(
      ['climayte', 'cli', 'codex', 'desktop', 'opencode'].sort(),
    )
    // 1 (cli) + 2 (desktop) + 4 (climayte) list-priced, + 0.5 the provider billed.
    expect(r.totalCostUsd).toBeCloseTo(7.5, 9)
  })

  test('byAccount is filled, per account, from the calls', () => {
    expect(r.byAccount.map((b) => b.key).sort()).toEqual(['acct-a', 'acct-b'])
    const a = r.byAccount.find((b) => b.key === 'acct-a')
    expect(a?.costUsd).toBe(5)
    expect(a?.sessions).toBe(2)
  })

  test('the four-way token split is kept and sums to the total', () => {
    expect(r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite).toBe(
      r.tokens.total,
    )
    expect(r.tokens.cacheRead).toBe(5000)
  })

  test('a provider-billed cost wins and its model is not listed as unpriced', () => {
    expect(r.unpricedModels).toEqual(['no-price-model'])
    expect(r.byModel.find((b) => b.key === 'some-routed-model')?.costUsd).toBe(0.5)
  })

  test('byProvider groups the three Claude sources as one', () => {
    expect(r.byProvider.map((p) => p.key).sort()).toEqual(['claude', 'codex', 'opencode'])
  })

  test('a session’s project is its cwd; a session nobody knows is "unknown"', () => {
    const all = report()
    expect(all.byProject.find((b) => b.key === 'D:\\work\\Alpha')?.costUsd).toBe(2)
    expect(all.byProject.find((b) => b.key === 'unknown')).toBeDefined()
  })
})

describe('the source filter narrows every figure', () => {
  test('one source leaves only that source in every breakdown and total', () => {
    const r = report({ sources: ['desktop'] })
    expect(r.totalCostUsd).toBe(2)
    expect(r.totalWeighted).toBe(20)
    expect(r.sessions).toBe(1)
    expect(r.byProvider.map((p) => p.key)).toEqual(['claude'])
    expect(r.byModel.map((b) => b.key)).toEqual(['claude-opus-5'])
    expect(r.byAccount.map((b) => b.key)).toEqual(['acct-b'])
    expect(r.bySource.map((b) => b.key)).toEqual(['desktop'])
    expect(r.byDay.reduce((s, b) => s + (b.costUsd ?? 0), 0)).toBe(2)
  })

  test('an empty list is nothing ticked: zero, not everything', () => {
    const r = report({ sources: [] })
    expect(r.calls).toBe(0)
    expect(r.totalCostUsd).toBeNull()
  })

  test('the toolkit’s coverage rides along, so a partial figure can say so', () => {
    expect(Object.keys(report().kitCoverage.sources)).toContain('desktop')
  })
})

describe('history past the raw window survives in the rollup', () => {
  test('a 60-day-old call still counts, but has no session, so no project', () => {
    const old = new KitStore(':memory:')
    old.upsertEvents([call(60 * D, { account: 'acct-a', session: 'gone-session' })])
    old.runMaintenance(NOW)
    const r = spendReport({ store: old, now: NOW })
    old.close()
    expect(r.calls).toBe(1)
    expect(r.totalCostUsd).toBe(1)
    expect(r.sessions).toBe(0)
    expect(r.byProject.map((b) => b.key)).toEqual(['unknown'])
    expect(r.notes.join(' ')).toContain('no session')
  })
})
