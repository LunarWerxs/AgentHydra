import { afterAll, describe, expect, test } from 'bun:test'
import { type UsageQueryParams, usageQuery } from '../src/kit/query'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { parseKitUsageQuery } from '../src/routes/kit'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

const store = new KitStore(':memory:')
afterAll(() => store.close())

let n = 0
const ev = (ago: number, e: Partial<UsageEventInput>): UsageEventInput => ({
  id: `e${++n}`,
  ts: NOW - ago,
  source: 'cli',
  ...e,
})

const q = (p: Parameters<typeof usageQuery>[0], quota?: () => null) =>
  usageQuery(p, { store, now: NOW, quota })

// A: two Claude calls this hour and the one before, and one 40 days old.
// B: two HSwarm worker calls a day and a half ago (one failed, a model with no price), one at 23:30Z.
store.upsertEvents([
  ev(1 * H, {
    account: 'acct-a',
    instance: 'cli:1',
    pc: 'p1',
    session: 's1',
    agent: 'main',
    model: 'opus',
    provider: 'anthropic',
    input: 100,
    output: 50,
    list_usd: 1,
    weighted: 10,
  }),
  ev(2 * H, {
    account: 'acct-a',
    instance: 'cli:1',
    pc: 'p1',
    session: 's2',
    agent: 'subagent',
    model: 'opus',
    provider: 'anthropic',
    input: 10,
    cache_read: 5,
    list_usd: 2,
    weighted: 4,
  }),
  ev(30 * H, {
    account: 'acct-b',
    instance: 'desktop:x',
    pc: 'p2',
    session: 's3',
    agent: 'main',
    source: 'hswarm',
    model: 'dsv',
    provider: 'deepseek',
    input: 200,
    output: 20,
    list_usd: null,
    billed_usd: 0.5,
    weighted: 3,
    ok: true,
    seconds: 2,
  }),
  ev(30 * H + 1000, {
    account: 'acct-b',
    instance: 'desktop:x',
    pc: 'p2',
    session: 's3',
    agent: 'main',
    source: 'hswarm',
    model: 'dsv',
    provider: 'deepseek',
    input: 1,
    billed_usd: 0.25,
    weighted: 1,
    ok: false,
    seconds: 3,
  }),
  {
    ...ev(0, { account: 'acct-b', source: 'codex', model: 'gpt', input: 7 }),
    ts: Date.UTC(2026, 5, 14, 23, 30),
  },
  ev(40 * D, {
    account: 'acct-a',
    instance: 'cli:1',
    pc: 'p1',
    session: 's0',
    agent: 'main',
    model: 'opus',
    provider: 'anthropic',
    input: 1000,
    list_usd: 4,
    weighted: 40,
  }),
])

describe('filters', () => {
  const calls = (filter: NonNullable<UsageQueryParams['filter']>) =>
    q({ window: { last: '7d' }, filter, measures: ['calls'] }).totals.calls

  test.each([
    ['account', { account: 'acct-b' }, 3],
    ['instance', { instance: 'cli:1' }, 2],
    ['pc', { pc: 'p2' }, 2],
    ['source', { source: 'hswarm' }, 2],
    ['model', { model: 'opus' }, 2],
    ['provider', { provider: 'deepseek' }, 2],
    ['session', { session: 's2' }, 1],
    ['agent', { agent: 'subagent' }, 1],
    ['ok true', { ok: true }, 1],
    ['ok false', { ok: false }, 1],
    ['a list of values', { account: ['acct-a', 'acct-b'] }, 5],
    ['two filters', { account: 'acct-b', source: 'hswarm' }, 2],
  ] as [string, NonNullable<UsageQueryParams['filter']>, number][])('%s', (_n, filter, want) => {
    expect(calls(filter)).toBe(want)
  })
})

describe('groupBy', () => {
  const keys = (g: UsageQueryParams['groupBy']) =>
    q({ window: { last: '7d' }, groupBy: g, measures: ['calls'] }).rows.map((r) => r[g![0]])

  test.each([
    ['account', ['acct-a', 'acct-b']],
    ['instance', ['cli:1', 'desktop:x', null]],
    ['pc', ['p1', 'p2', null]],
    ['source', ['cli', 'codex', 'hswarm']],
    ['model', ['dsv', 'gpt', 'opus']],
    ['provider', ['anthropic', 'deepseek', null]],
    ['session', ['s1', 's2', 's3', null]],
  ] as const)('%s', (g, want) => {
    expect(keys([g])).toEqual(want as never)
  })

  test('day cuts in the asked time zone', () => {
    const days = (tz: string) =>
      q({ window: { last: '7d' }, groupBy: ['day'], measures: ['calls'], tz }).rows.map(
        (r) => `${r.day}:${r.calls}`,
      )
    expect(days('UTC')).toEqual(['2026-06-14:3', '2026-06-15:2'])
    // Auckland is UTC+12 in June: the 23:30Z call is already the 15th there.
    expect(days('Pacific/Auckland')).toEqual(['2026-06-14:2', '2026-06-15:3'])
  })

  test('hour buckets and a two-key group', () => {
    const r = q({ window: { last: '24h' }, groupBy: ['hour', 'account'], measures: ['tokens'] })
    expect(r.rows).toEqual([
      { hour: '2026-06-14T23:00:00.000Z', account: 'acct-b', tokens: 7 },
      { hour: '2026-06-15T10:00:00.000Z', account: 'acct-a', tokens: 15 },
      { hour: '2026-06-15T11:00:00.000Z', account: 'acct-a', tokens: 150 },
    ])
  })
})

describe('measures and totals', () => {
  test('every measure over the whole week', () => {
    const r = q({ window: { last: '7d' } })
    expect(r.rows).toHaveLength(1)
    expect(r.totals).toEqual({
      tokens: 100 + 50 + 10 + 5 + 200 + 20 + 1 + 7,
      list_usd: 3,
      billed_usd: 0.75,
      weighted: 18,
      calls: 5,
      ok: 1,
      failed: 1,
      seconds: 5,
    })
  })

  test('measures narrows the columns', () => {
    const r = q({ window: { last: '7d' }, groupBy: ['source'], measures: ['calls', 'failed'] })
    expect(r.rows).toEqual([
      { source: 'cli', calls: 2, failed: 0 },
      { source: 'codex', calls: 1, failed: 0 },
      { source: 'hswarm', calls: 2, failed: 1 },
    ])
  })
})

describe('windows', () => {
  test('from/to is inclusive and returned as resolved', () => {
    const r = q({ window: { from: NOW - 2 * H, to: NOW - 1 * H }, measures: ['calls'] })
    expect(r.totals.calls).toBe(2)
    expect(r.window).toEqual({ from: NOW - 2 * H, to: NOW - H, basis: 'explicit' })
  })

  const snap = (session: string | null, week: string | null) => () => ({
    sessionResetsAt: session,
    weekResetsAt: week,
  })
  const iso = (ms: number) => new Date(ms).toISOString()

  test('5h window starts 5h before the snapshot reset', () => {
    const r = usageQuery(
      { window: { account: 'acct-a', kind: '5h' }, measures: ['calls'] },
      { store, now: NOW, quota: snap(iso(NOW + 3 * H), null) },
    )
    // Window = [now-2h, now]: both of A's recent calls sit inside it, nothing older.
    expect(r.window).toMatchObject({ from: NOW - 2 * H, to: NOW, basis: 'snapshot', kind: '5h' })
    expect(r.totals.calls).toBe(2)
  })

  test('week window starts 7d before the snapshot reset', () => {
    const r = usageQuery(
      { window: { account: 'acct-b', kind: 'week' }, measures: ['calls'] },
      { store, now: NOW, quota: snap(null, iso(NOW + 1 * D)) },
    )
    expect(r.window).toMatchObject({ from: NOW - 6 * D, basis: 'snapshot', kind: 'week' })
    expect(r.totals.calls).toBe(5)
  })

  test('no snapshot, or one whose reset has passed, rolls back from now', () => {
    for (const quota of [() => null, snap(iso(NOW - H), iso(NOW - H))]) {
      const five = usageQuery({ window: { account: 'a', kind: '5h' } }, { store, now: NOW, quota })
      expect(five.window).toMatchObject({ from: NOW - 5 * H, to: NOW, basis: 'rolling' })
      const week = usageQuery(
        { window: { account: 'a', kind: 'week' } },
        { store, now: NOW, quota },
      )
      expect(week.window).toMatchObject({ from: NOW - 7 * D, basis: 'rolling' })
    }
  })
})

describe('raw / rollup split at the 35-day line', () => {
  test('a call is counted once whether or not its raw row is pruned yet', () => {
    const all = () =>
      q({ window: { last: 'all' }, filter: { account: 'acct-a' }, measures: ['calls', 'tokens'] })
    // Rolled up, raw still present: the old call lives in both tables.
    store.rollup()
    expect(all().totals).toEqual({ calls: 3, tokens: 1165 })

    // Pruned: only the hourly row remains for it.
    expect(store.pruneRaw(NOW)).toBe(1)
    expect(all().totals).toEqual({ calls: 3, tokens: 1165 })
    expect(
      q({ window: { last: '30d' }, filter: { account: 'acct-a' }, measures: ['calls'] }).totals
        .calls,
    ).toBe(2)
  })

  test('a straddling window groups old and new rows under one key', () => {
    const r = q({
      window: { last: 'all' },
      groupBy: ['model'],
      filter: { model: 'opus' },
      measures: ['calls', 'list_usd'],
    })
    expect(r.rows).toEqual([{ model: 'opus', calls: 3, list_usd: 7 }])
  })

  test('rollup rows answer dimension filters; session and ok say they cannot', () => {
    const old = { from: NOW - 41 * D, to: NOW - 39 * D }
    expect(
      q({ window: old, filter: { instance: 'cli:1' }, measures: ['tokens'] }).totals.tokens,
    ).toBe(1000)
    expect(
      q({ window: old, filter: { instance: 'nope' }, measures: ['tokens'] }).totals.tokens,
    ).toBe(0)
    // A session the window covers whole is answered from the per-session ledger.
    const r = q({ window: old, filter: { session: 's0' }, measures: ['tokens'] })
    expect(r.totals.tokens).toBe(1000)
    expect(r.notes).toEqual([])
    // An ok filter still cannot reach the rollup.
    const k = q({ window: old, filter: { ok: true }, measures: ['tokens'] })
    expect(k.totals.tokens).toBe(0)
    expect(k.notes[0]).toContain('ok filter cannot be applied')
  })
})

describe('unpriced, price version and coverage', () => {
  test('unpriced lists models whose calls have no list price', () => {
    expect(q({ window: { last: '7d' } }).unpriced).toEqual(['dsv', 'gpt'])
    expect(q({ window: { last: '7d' }, filter: { source: 'cli' } }).unpriced).toEqual([])
  })

  test('priceVer comes from meta', () => {
    expect(q({}).priceVer).toBeNull()
    store.setMeta('price_ver', '2026-10-01')
    expect(q({}).priceVer).toBe('2026-10-01')
  })

  test('coverage reports each source up to its newest call, and the cursors', () => {
    store.setCursor({ path: 'f1', size: 1, mtime: 500, offset: 1, version: 1 })
    store.setCursor({ path: 'f2', size: 1, mtime: 900, offset: 1, version: 1 })
    const c = q({ window: { last: '7d' } }).coverage
    expect(c.sources.hswarm).toMatchObject({ events: 2, lastTs: NOW - 30 * H })
    expect(c.sources.cli.lastTs).toBe(NOW - 1 * H)
    expect(c.cursors).toEqual({ files: 2, newestMtime: 900 })
  })
})

describe('GET /api/kit/usage parameters', () => {
  const parse = (s: string) => {
    const p = new URLSearchParams(s)
    return parseKitUsageQuery((k) => p.get(k) ?? undefined)
  }

  test('maps every field to the usageQuery shape', () => {
    expect(parse('last=7d&account=a,b&ok=true&groupBy=day,source&measures=calls&tz=UTC')).toEqual({
      window: { last: '7d' },
      filter: { account: ['a', 'b'], ok: [true] },
      groupBy: ['day', 'source'],
      measures: ['calls'],
      tz: 'UTC',
    })
    expect(parse('kind=week&windowAccount=acct-z').window).toEqual({
      account: 'acct-z',
      kind: 'week',
    })
    expect(parse('from=5&to=9').window).toEqual({ from: 5, to: 9 })
  })

  test('refuses what it cannot read', () => {
    expect(() => parse('last=3y')).toThrow('last must be one of')
    expect(() => parse('groupBy=planet')).toThrow('groupBy "planet"')
    expect(() => parse('kind=5h')).toThrow('kind needs')
  })
})

describe('session and ref totals at any age', () => {
  const sx = new KitStore(':memory:')
  afterAll(() => sx.close())
  let m = 0
  const e = (ago: number, o: Partial<UsageEventInput>): UsageEventInput => ({
    id: `x${++m}`,
    ts: NOW - ago,
    source: 'cli',
    ...o,
  })
  // s1 spans the raw line (50 days and 2 days old); s2 and attempt r1 are 60 days old, all pruned.
  sx.upsertEvents([
    e(50 * D, { session: 's1', input: 100, list_usd: 1, ok: true }),
    e(2 * D, { session: 's1', input: 10, list_usd: 0.5, ok: false }),
    e(60 * D, { session: 's2', ref: 'r1', input: 7, list_usd: 2 }),
    e(60 * D + H, { session: 's2', ref: 'r1', input: 3, list_usd: 1 }),
    e(1 * H, { input: 1000 }),
  ])
  sx.runMaintenance(NOW)
  const qs = (p: UsageQueryParams) => usageQuery(p, { store: sx, now: NOW, quota: () => null })

  test('a pruned session answers for last: all, and a pruned ref too', () => {
    const r = qs({
      window: { last: 'all' },
      groupBy: ['session'],
      measures: ['tokens', 'list_usd'],
    })
    expect(r.rows).toEqual([
      { session: 's1', tokens: 110, list_usd: 1.5 },
      { session: 's2', tokens: 10, list_usd: 3 },
      { session: null, tokens: 1000, list_usd: null },
    ])
    expect(r.notes).toEqual([])
    const ref = qs({
      window: { last: 'all' },
      filter: { ref: 'r1' },
      measures: ['calls', 'tokens'],
    })
    expect(ref.totals).toEqual({ calls: 2, tokens: 10 })
  })

  test('an explicit window that covers the session whole is answered the same, with no double count', () => {
    const r = qs({
      window: { from: NOW - 61 * D, to: NOW },
      filter: { session: ['s1', 's2'] },
      measures: ['calls', 'tokens'],
    })
    expect(r.totals).toEqual({ calls: 4, tokens: 120 })
  })

  test('a window that cuts a session keeps reading raw rows, and says what it misses', () => {
    const r = qs({
      window: { from: NOW - 40 * D, to: NOW },
      filter: { session: 's1' },
      measures: ['calls', 'tokens'],
    })
    expect(r.totals).toEqual({ calls: 1, tokens: 10 })
    expect(r.notes[0]).toContain('does not cover whole')
  })
})
