import { describe, expect, test } from 'bun:test'
import { KIT_SCHEMA_VERSION } from '../src/kit/schema'
import { KitStore, localDay } from '../src/kit/store'

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0)

const count = (s: KitStore, t: string) =>
  (s.db.query(`select count(*) as n from ${t}`).get() as { n: number }).n

describe('kit store', () => {
  test('duplicate ids: the last write wins', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 1 }])
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 99 }])
    expect(count(s, 'usage_event')).toBe(1)
    expect(s.db.query("select output from usage_event where id = 'cli:m1'").get()).toEqual({
      output: 99,
    })
  })

  test('day is the local date stored at write time', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli' }])
    expect(s.db.query('select day from usage_event').get()).toEqual({ day: localDay(T0) })
  })

  test('rollup sums per hour and dimensions, and is idempotent', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([
      {
        id: 'a',
        ts: T0 + 1,
        source: 'cli',
        model: 'm',
        input: 5,
        output: 1,
        list_usd: 0.5,
        ok: true,
      },
      {
        id: 'b',
        ts: T0 + 2,
        source: 'cli',
        model: 'm',
        input: 7,
        output: 2,
        list_usd: 0.25,
        ok: false,
      },
      { id: 'c', ts: T0 + 3, source: 'hswarm', model: 'm', input: 100, billed_usd: 1 },
      { id: 'd', ts: T0 + H, source: 'cli', model: 'm', input: 1 },
    ])
    expect(s.rollup()).toBe(3)
    expect(s.rollup()).toBe(0)
    s.rollup(T0)
    const cli = s.db
      .query("select * from usage_hour where source = 'cli' and hour = ?")
      .get(T0) as Record<string, number>
    expect(cli).toMatchObject({
      calls: 2,
      ok_calls: 1,
      failed_calls: 1,
      input: 12,
      output: 3,
      list_usd: 0.75,
    })
    expect(count(s, 'usage_hour')).toBe(3)
  })

  test('a late event re-marks its hour and the next rollup picks it up', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli', input: 1 }])
    s.rollup()
    s.upsertEvents([{ id: 'late', ts: T0 - 5 * H, source: 'cli', input: 4 }])
    // only the dirty hour is rebuilt now (the hour after it is already current); both rows exist
    expect(s.rollup()).toBe(1)
    expect(count(s, 'usage_hour')).toBe(2)
  })

  test('pruning drops old raw events and keeps the hourly rows', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const now = T0 + 60 * D
    s.upsertEvents([
      { id: 'old1', ts: T0, source: 'cli', input: 3 },
      { id: 'old2', ts: T0 + 10, source: 'cli', input: 4 },
      { id: 'new', ts: now - D, source: 'cli', input: 9 },
    ])
    // never rolled up before pruning: the prune must roll the doomed hours up first
    expect(s.pruneRaw(now)).toBe(2)
    expect(count(s, 'usage_event')).toBe(1)
    expect(s.db.query('select input from usage_hour where hour = ?').get(T0 - (T0 % H))).toEqual({
      input: 7,
    })
    expect(s.runMaintenance(now).pruned).toBe(0)
    expect(s.db.query('select sum(input) as n from usage_hour').get()).toEqual({ n: 16 })
  })

  test('drop and rebuild empties every table and clears cursors', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli' }])
    s.rollup()
    s.setCursor({ path: '/x', size: 1, mtime: 2, offset: 1, version: 1 })
    s.dropAndRebuild('v9')
    expect(count(s, 'usage_event') + count(s, 'usage_hour') + count(s, 'ingest_cursor')).toBe(0)
    expect(s.getMeta('price_ver')).toBe('v9')
    s.upsertEvents([{ id: 'b', ts: T0, source: 'cli' }])
    expect(count(s, 'usage_event')).toBe(1)
  })

  test('a newer schema version is refused', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.db.exec('pragma user_version = 99')
    const { migrateKitSchema } = require('../src/kit/schema')
    expect(() => migrateKitSchema(s.db)).toThrow()
  })
})

describe('session ledger and the raw cut', () => {
  const NOW = T0 + 60 * D
  const ledger = (s: KitStore) =>
    s.db
      .query(
        'select session, ref, calls, first_ts, last_ts, input, list_usd from usage_session order by session, ref',
      )
      .all()
  const hourSum = (s: KitStore) =>
    s.db.query('select sum(calls) as c, sum(input) as i from usage_hour').get()

  test('totals equal every event once across pruning, re-upserts and a re-read of old events', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const old = [
      { id: 'o1', ts: T0, session: 'a', ref: 'r', source: 'cli', input: 3, list_usd: 1 },
      { id: 'o2', ts: T0 + 10, session: 'a', ref: 'r', source: 'cli', input: 4, list_usd: 2 },
    ]
    const fresh = [{ id: 'n1', ts: NOW - D, session: 'a', ref: 'r', source: 'cli', input: 9 }]
    s.upsertEvents([...old, ...fresh])
    s.runMaintenance(NOW)
    // o1 and o2 are pruned; one fresh event is still raw. The session total spans both.
    expect(count(s, 'usage_event')).toBe(1)
    const want = [
      { session: 'a', ref: 'r', calls: 3, first_ts: T0, last_ts: NOW - D, input: 16, list_usd: 3 },
    ]
    expect(ledger(s)).toEqual(want)
    const hours = hourSum(s)

    // the fresh event is re-upserted (last write wins), the old ones are read again from byte 0
    s.upsertEvents([{ ...fresh[0], input: 9 }])
    expect(s.upsertEvents(old)).toBe(0)
    s.runMaintenance(NOW)
    s.runMaintenance(NOW + H)
    expect(ledger(s)).toEqual(want)
    expect(hourSum(s)).toEqual(hours)
    expect(count(s, 'usage_event')).toBe(1)

    // a changed fresh event replaces its old value in the total
    s.upsertEvents([{ ...fresh[0], input: 20 }])
    s.runMaintenance(NOW)
    expect((ledger(s)[0] as { input: number }).input).toBe(27)
  })

  test('a rollup and prune cut into slices count every call once, over a dense hour and many days', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    const evs: Array<{
      id: string
      ts: number
      session: string
      model: string
      source: string
      input: number
    }> = []
    // 2500 calls inside one hour (more than a slice holds, with shared timestamps), then one a day for 50 days
    for (let i = 0; i < 2500; i++)
      evs.push({
        id: `dense${i}`,
        ts: T0 + Math.floor(i / 3),
        session: `s${i % 7}`,
        model: i % 5 ? 'm1' : 'm2',
        source: 'cli',
        input: i,
      })
    for (let d = 1; d <= 50; d++)
      evs.push({
        id: `day${d}`,
        ts: T0 + d * D,
        session: `s${d % 3}`,
        model: 'm1',
        source: 'cli',
        input: d,
      })
    s.upsertEvents(evs)
    await s.runMaintenanceAsync(NOW)

    const want = new Map<string, { calls: number; input: number }>()
    for (const e of evs) {
      const k = `${e.ts - (e.ts % H)}|${e.model}`
      const w = want.get(k) ?? { calls: 0, input: 0 }
      w.calls++
      w.input += e.input
      want.set(k, w)
    }
    const got = new Map<string, { calls: number; input: number }>()
    for (const r of s.db.query('select hour, model, calls, input from usage_hour').all() as Array<{
      hour: number
      model: string
      calls: number
      input: number
    }>)
      got.set(`${r.hour}|${r.model}`, { calls: r.calls, input: r.input })
    expect(got).toEqual(want)
    const total = s.db.query('select sum(calls) as c, sum(input) as i from usage_session').get()
    expect(total).toEqual({ c: evs.length, i: evs.reduce((a, e) => a + e.input, 0) })
    expect(count(s, 'usage_event')).toBeLessThan(evs.length) // the old calls were pruned
    expect(s.rawCut()).toBe(Math.floor((NOW - 35 * D) / H) * H)
  })
  test('a v1 file is migrated to v2 with its surviving raw rows in the ledger', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([{ id: 'a', ts: T0, session: 's', source: 'cli', input: 5 }])
    s.db.exec('drop table usage_session; drop table usage_session_settled; pragma user_version = 1')
    const { migrateKitSchema } = require('../src/kit/schema')
    migrateKitSchema(s.db)
    expect(s.db.query('pragma user_version').get()).toEqual({ user_version: KIT_SCHEMA_VERSION })
    expect(ledger(s)).toMatchObject([{ session: 's', calls: 1, input: 5 }])
  })
})

describe('settled calls, the raw cut and the hour rollup', () => {
  const hourCalls = (s: KitStore, source: string) =>
    (
      s.db
        .query('select coalesce(sum(calls),0) as c from usage_hour where source = ?')
        .get(source) as {
        c: number
      }
    ).c
  const ledgerCalls = (s: KitStore) =>
    (s.db.query('select coalesce(sum(calls),0) as c from usage_session').get() as { c: number }).c

  test('a pruned call read again below the cut is not counted a second time', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const ev = { id: 'msg_X', ts: T0 - 30 * D, session: 's', ref: 'r', source: 'cli', input: 5 }
    s.upsertEvents([ev])
    s.runMaintenance(T0)
    s.pruneRaw(T0 + 10 * D)
    expect(count(s, 'usage_event')).toBe(0)
    expect(s.settleOld([ev])).toBe(0)
    expect(hourCalls(s, 'cli')).toBe(1)
    expect(ledgerCalls(s)).toBe(1)
  })

  test('an old foreign event on a fresh store does not erase settled Claude hours', () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.settleOld([{ id: 'c1', ts: T0 - 100 * D, session: 's', source: 'cli', input: 7 }])
    s.upsertEvents([{ id: 'x1', ts: T0 - 200 * D, session: 'z', source: 'codex', input: 3 }])
    s.runMaintenance(T0)
    expect(hourCalls(s, 'cli')).toBe(1)
    expect(hourCalls(s, 'codex')).toBe(1)
    expect(ledgerCalls(s)).toBe(2)
    expect(count(s, 'usage_event')).toBe(0)
  })

  test('a call re-written with a later hour leaves its old hour', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const h = T0 - (T0 % H)
    s.upsertEvents([{ id: 'm', ts: h + H - 1000, session: 's', source: 'cli', input: 5 }])
    s.rollup()
    s.upsertEvents([{ id: 'm', ts: h + H + 1000, session: 's', source: 'cli', input: 6 }])
    s.rollup()
    const rows = s.db.query('select hour, calls, input from usage_hour order by hour').all()
    expect(rows).toEqual([{ hour: h + H, calls: 1, input: 6 }])
  })

  test('a call settled in the band between the cut and the sweep cutoff survives the rollup', () => {
    const s = new KitStore(':memory:', { now: T0 })
    const A = T0 - (T0 % H)
    s.upsertEvents([
      { id: 'b1', ts: A - 600_000, session: 's', source: 'cli', input: 1 },
      { id: 'b2', ts: A + 60_000, session: 's', source: 'cli', input: 2 },
    ])
    s.runMaintenance(A + 35 * D + 30_000)
    expect(s.rawCut()).toBe(A)
    s.settleOld([{ id: 'b3', ts: A + 20 * 60_000, session: 's', source: 'cli', input: 4 }])
    s.runMaintenance(A + 35 * D + H + 60_000)
    expect(s.db.query('select calls, input from usage_hour where hour = ?').get(A)).toEqual({
      calls: 2,
      input: 6,
    })
    expect(ledgerCalls(s)).toBe(3)
  })

  test('a long ingest keeps the dirty hours near now and readers use the rollup below them', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.rollupEveryMs = 0
    const evs = Array.from({ length: 1200 }, (_, i) => ({
      id: `l${i}`,
      ts: T0 - 20 * D + i * 1_440_000,
      session: 's',
      source: 'cli',
      input: 1,
    }))
    await s.upsertEventsAsync(evs)
    const dirty = s.dirtyFrom()
    // without the mid-ingest rollup this is the first event's hour, 20 days back
    expect(dirty === null || dirty > T0 - 10 * D).toBe(true)
    expect(
      (s.db.query('select coalesce(sum(calls),0) as c from usage_hour').get() as { c: number }).c,
    ).toBeGreaterThan(0)
  })

  test('a v3 file is upgraded: unbilled and per-call cost are backfilled, in slices', async () => {
    const s = new KitStore(':memory:', { now: T0 })
    s.upsertEvents([
      { id: 'a', ts: T0, session: 's', source: 'hswarm', list_usd: 0.2, billed_usd: null },
      { id: 'b', ts: T0 + 1, session: 's', source: 'hswarm', list_usd: 0.5, billed_usd: 0.1 },
      { id: 'c', ts: T0 + 2, session: 's', source: 'hswarm', list_usd: 0.7, billed_usd: 0 },
    ])
    await s.runMaintenanceAsync(T0 + H)
    const want = s.db.query('select unbilled_usd as u, cost_usd as c from usage_hour').get() as {
      u: number
      c: number
    }
    expect(want.u).toBeCloseTo(0.2)
    expect(want.c).toBeCloseTo(0.3)
    s.db.exec('update usage_hour set unbilled_usd = 0, cost_usd = 0')
    s.db.exec('update usage_session set unbilled_usd = 0, cost_usd = 0')
    s.setMeta('backfill_v4', 'a')
    await s.backfillAsync()
    expect(s.db.query('select unbilled_usd as u, cost_usd as c from usage_hour').get()).toEqual(
      want,
    )
    expect(
      (s.db.query('select cost_usd as c from usage_session').get() as { c: number }).c,
    ).toBeCloseTo(0.3)
  })
})
