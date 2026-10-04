// server/tests/kit-legacy.test.ts — the one-time backfill of the kit from session_stats
// (kit/ingest-legacy.ts): Claude history whose transcripts are gone must stay in 'all time'.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { spendReport } from '../src/analytics'
import { db } from '../src/db'
import { ingestLegacy } from '../src/kit/ingest-legacy'
import { usageQuery } from '../src/kit/query'
import { KitStore, localDay, type UsageEventInput } from '../src/kit/store'
import { priceTokens } from '../src/pricing'

const D = 86_400_000
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
const day = (ago: number) => localDay(NOW - ago * D)
const MODEL = 'claude-opus-5'

function statsDb(): Database {
  const s = new Database(':memory:')
  s.exec(`create table session_stats (session_key text primary key, session_id text not null,
    source text not null, instance text, cwd text, last_ts integer, tokens_json text, days_json text,
    gone_at integer)`)
  return s
}

/** 1000 input + 200 output tokens over the given days (weighted 1 per day unless given). */
function put(
  s: Database,
  id: string,
  days: Record<string, number>,
  o: { gone?: boolean; instance?: string | null; source?: string; cwd?: string } = {},
) {
  const w = Object.values(days).reduce((a, b) => a + b, 0)
  s.query('insert into session_stats values (?,?,?,?,?,?,?,?,?)').run(
    `${o.source ?? 'claude'}:${id}`,
    id,
    o.source ?? 'claude',
    o.instance ?? null,
    o.cwd ?? `D:/work/${id}`,
    NOW,
    JSON.stringify({
      [MODEL]: {
        weighted: w * 10,
        output: 200,
        turns: 4,
        input: 1000,
        cacheRead: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
      },
    }),
    JSON.stringify(days),
    o.gone ? 1 : null,
  )
}

const kitCall = (id: string, session: string, ago: number): UsageEventInput => ({
  id,
  ts: NOW - ago * D,
  source: 'cli',
  instance: 'cli:1',
  session,
  agent: 'main',
  model: MODEL,
  provider: 'anthropic',
  input: 500,
  output: 100,
  list_usd: 1,
  weighted: 5,
})

const sessionTokens = (store: KitStore, session: string) =>
  Number(
    usageQuery(
      { window: { from: 0 }, filter: { session: [session] }, measures: ['tokens'] },
      { store, now: NOW },
    ).totals.tokens ?? 0,
  )

describe('kit legacy backfill', () => {
  test('a gone session is counted once, split by day, priced like the kit, at the first hour', async () => {
    const store = new KitStore(':memory:', { now: NOW })
    const s = statsDb()
    put(s, 'gone1', { [day(90)]: 3, [day(89)]: 1 }, { gone: true })
    const r = await ingestLegacy(store, s, { now: NOW })
    expect(r.written).toBe(2)
    expect(sessionTokens(store, 'gone1')).toBe(1200)
    const hours = store.db
      .query(
        "select hour, day, input, list_usd, source from usage_hour where source = 'cli' order by hour",
      )
      .all() as { hour: number; day: string; input: number; list_usd: number; source: string }[]
    expect(hours.map((h) => h.input)).toEqual([750, 250])
    expect(hours[0]?.day).toBe(day(90))
    expect(hours[0]?.hour).toBe(new Date(NOW - 90 * D).setHours(0, 0, 0, 0))
    const want = priceTokens(
      {
        [MODEL]: {
          output: 150,
          input: 750,
          cacheRead: 0,
          cacheCreation5m: 0,
          cacheCreation1h: 0,
        },
      },
      0,
    )
    expect(hours[0]?.list_usd).toBeCloseTo(want.costUsd ?? Number.NaN, 9)
    store.close()
  })

  test("transcript-seen days stay the kit's, older days are added once each", async () => {
    const store = new KitStore(':memory:', { now: NOW })
    store.upsertEvents([kitCall('k1', 'mix', 3), kitCall('k2', 'mix', 1)])
    const s = statsDb()
    // the kit holds days -3 and -1; session_stats also has -60 (older than the kit) and -2 (inside the span)
    put(s, 'mix', { [day(60)]: 1, [day(3)]: 1, [day(2)]: 1, [day(1)]: 1 })
    // a live session the kit has not seen, older than its oldest day: backfilled; a newer one is not
    put(s, 'unseen', { [day(40)]: 1, [day(0)]: 1 })
    const r = await ingestLegacy(store, s, { now: NOW })
    expect(r.written).toBe(2)
    // 2 kit calls (600 each) + one backfilled day with a quarter of 1200
    expect(sessionTokens(store, 'mix')).toBe(1200 + 300)
    expect(sessionTokens(store, 'unseen')).toBe(600)
    store.close()
  })

  test('a second run, and a run repeated after a crash, add nothing', async () => {
    const store = new KitStore(':memory:', { now: NOW })
    const s = statsDb()
    put(s, 'g', { [day(100)]: 1, [day(10)]: 1 }, { gone: true, instance: 'desktop:abc' })
    put(s, 'other', { [day(80)]: 1 }, { gone: true, source: 'codex' })
    await ingestLegacy(store, s, { now: NOW })
    const snap = () => [
      store.db.query('select * from usage_hour order by hour, source').all(),
      store.db.query('select * from usage_session order by session').all(),
      store.db.query('select id from usage_event order by id').all(),
    ]
    const first = JSON.stringify(snap())
    expect((await ingestLegacy(store, s, { now: NOW })).skipped).toBe(true)
    // crash: no done flag and no position, claims and raw rows already there
    store.db.query("delete from meta where key like 'legacy_backfill%'").run()
    const again = await ingestLegacy(store, s, { now: NOW })
    expect(again.written).toBe(0)
    expect(JSON.stringify(snap())).toBe(first)
    // source from the instance; other providers are not this backfill's
    expect(
      (
        store.db.query('select distinct source from usage_session').all() as { source: string }[]
      ).map((r) => r.source),
    ).toEqual(['desktop'])
    // the day inside the raw window is a raw row the rollup carries
    expect(
      store.db.query("select count(*) as n from usage_event where id like 'legacy:%'").get(),
    ).toEqual({ n: 1 })
    store.close()
  })

  test("spendReport 'all' includes the backfill: total, day and project", async () => {
    const store = new KitStore(':memory:', { now: NOW })
    const s = statsDb()
    put(s, 'rep-gone', { [day(120)]: 1 }, { gone: true, cwd: 'D:/work/Legacy' })
    db.query(
      'insert or replace into session_stats (session_key, session_id, source, cwd, first_seen_at, last_scanned_at) values (?, ?, ?, ?, 1, 2)',
    ).run('claude:rep-gone', 'rep-gone', 'claude', 'D:/work/Legacy')
    const before = await spendReport({ store, now: NOW })
    await ingestLegacy(store, s, { now: NOW })
    const after = await spendReport({ store, now: NOW })
    expect(before.tokens.total).toBe(0)
    expect(after.tokens.total).toBe(1200)
    expect(after.byDay.map((d) => d.key)).toEqual([day(120)])
    expect(after.byModel[0]?.key).toBe(MODEL)
    expect(after.byProject.map((p) => p.key)).toEqual(['D:/work/Legacy'])
    expect(after.byProvider[0]?.tokens.total).toBe(1200)
    store.close()
  })
})

afterAll(() => {
  db.query("delete from session_stats where session_key = 'claude:rep-gone'").run()
})
