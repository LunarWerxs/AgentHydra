import { describe, expect, test } from 'bun:test'
import { KitStore, localDay } from '../src/kit/store'

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0)

const count = (s: KitStore, t: string) =>
  (s.db.query(`select count(*) as n from ${t}`).get() as { n: number }).n

describe('kit store', () => {
  test('duplicate ids: the last write wins', () => {
    const s = new KitStore(':memory:')
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 1 }])
    s.upsertEvents([{ id: 'cli:m1', ts: T0, source: 'cli', input: 10, output: 99 }])
    expect(count(s, 'usage_event')).toBe(1)
    expect(s.db.query("select output from usage_event where id = 'cli:m1'").get()).toEqual({
      output: 99,
    })
  })

  test('day is the local date stored at write time', () => {
    const s = new KitStore(':memory:')
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli' }])
    expect(s.db.query('select day from usage_event').get()).toEqual({ day: localDay(T0) })
  })

  test('rollup sums per hour and dimensions, and is idempotent', () => {
    const s = new KitStore(':memory:')
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
    const s = new KitStore(':memory:')
    s.upsertEvents([{ id: 'a', ts: T0, source: 'cli', input: 1 }])
    s.rollup()
    s.upsertEvents([{ id: 'late', ts: T0 - 5 * H, source: 'cli', input: 4 }])
    expect(s.rollup()).toBe(2)
    expect(count(s, 'usage_hour')).toBe(2)
  })

  test('pruning drops old raw events and keeps the hourly rows', () => {
    const s = new KitStore(':memory:')
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
    const s = new KitStore(':memory:')
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
    const s = new KitStore(':memory:')
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
    const s = new KitStore(':memory:')
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

  test('a v1 file is migrated to v2 with its surviving raw rows in the ledger', () => {
    const s = new KitStore(':memory:')
    s.upsertEvents([{ id: 'a', ts: T0, session: 's', source: 'cli', input: 5 }])
    s.db.exec('drop table usage_session; drop table usage_session_settled; pragma user_version = 1')
    const { migrateKitSchema } = require('../src/kit/schema')
    migrateKitSchema(s.db)
    expect(s.db.query('pragma user_version').get()).toEqual({ user_version: 2 })
    expect(ledger(s)).toMatchObject([{ session: 's', calls: 1, input: 5 }])
  })
})
