// Analytics toolkit store: DATA_DIR/analytics.db (docs/ANALYTICS-PLAN.md §4.2-4.3).
// One row per model call in usage_event (kept RAW_RETENTION_DAYS), an hourly rollup in usage_hour
// (kept forever), a per-session ledger in usage_session (kept forever), per-file ingest cursors and a meta table. Nothing here reads a source file; ingest
// and the query API are separate pieces.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../config'
import {
  dropKitSchema,
  KIT_HOUR_DIMS,
  KIT_MEASURES,
  KIT_SESSION_KEY,
  migrateKitSchema,
  sessionAddSql,
  sessionAggSql,
} from './schema'

export const RAW_RETENTION_DAYS = 35
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface UsageEventInput {
  id: string
  ts: number
  /** Local date (YYYY-MM-DD) of `ts`. Computed from the machine's time zone when absent. */
  day?: string
  pc?: string | null
  account?: string | null
  instance?: string | null
  session?: string | null
  agent?: string | null
  source: string
  model?: string | null
  provider?: string | null
  input?: number
  output?: number
  cache_read?: number
  cache_write_5m?: number
  cache_write_1h?: number
  reasoning?: number
  list_usd?: number | null
  billed_usd?: number | null
  price_ver?: string | null
  weighted?: number
  ok?: boolean | null
  seconds?: number | null
  ref?: string | null
}

export interface IngestCursor {
  path: string
  size: number
  mtime: number
  offset: number
  version: number
}

export function kitDbPath(): string {
  return join(DATA_DIR, 'analytics.db')
}

export function localDay(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

export const hourStart = (ts: number): number => ts - (((ts % HOUR_MS) + HOUR_MS) % HOUR_MS)

const EVENT_COLS = [
  'id',
  'ts',
  'day',
  'pc',
  'account',
  'instance',
  'session',
  'agent',
  'source',
  'model',
  'provider',
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
  'reasoning',
  'list_usd',
  'billed_usd',
  'price_ver',
  'weighted',
  'ok',
  'seconds',
  'ref',
] as const

const num = (v: number | undefined): number => (Number.isFinite(v) ? (v as number) : 0)

export class KitStore {
  readonly db: Database
  private readonly upsertStmt

  constructor(path: string = kitDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    if (path !== ':memory:') this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma synchronous = NORMAL')
    migrateKitSchema(this.db)
    this.upsertStmt = this.prepareUpsert()
  }

  private prepareUpsert() {
    return this.db.prepare(
      `insert or replace into usage_event (${EVENT_COLS.join(',')}) values (${EVENT_COLS.map((c) => `$${c}`).join(',')})`,
    )
  }

  close(): void {
    this.db.close()
  }

  /**
   * Insert or replace by id: the last write wins, matching accumulateUsageLine. Returns rows written.
   *
   * An event older than the raw cut (the last prune's cutoff) is dropped: its raw row is gone and its
   * usage is already counted in usage_hour and usage_session, so taking it again (a source file re-read
   * from byte 0 after a cursor reset) would double it there, or make the next rollup rewrite hours that
   * no raw row backs any more.
   */
  upsertEvents(input: readonly UsageEventInput[]): number {
    const cut = this.rawCut()
    const events = cut === null ? input : input.filter((e) => e.ts >= cut)
    if (events.length === 0) return 0
    let minTs = Infinity
    const tx = this.db.transaction((rows: readonly UsageEventInput[]) => {
      for (const e of rows) {
        minTs = Math.min(minTs, e.ts)
        this.upsertStmt.run({
          $id: e.id,
          $ts: e.ts,
          $day: e.day ?? localDay(e.ts),
          $pc: e.pc ?? null,
          $account: e.account ?? null,
          $instance: e.instance ?? null,
          $session: e.session ?? null,
          $agent: e.agent ?? null,
          $source: e.source,
          $model: e.model ?? null,
          $provider: e.provider ?? null,
          $input: num(e.input),
          $output: num(e.output),
          $cache_read: num(e.cache_read),
          $cache_write_5m: num(e.cache_write_5m),
          $cache_write_1h: num(e.cache_write_1h),
          $reasoning: num(e.reasoning),
          $list_usd: e.list_usd ?? null,
          $billed_usd: e.billed_usd ?? null,
          $price_ver: e.price_ver ?? null,
          $weighted: num(e.weighted),
          $ok: e.ok == null ? null : e.ok ? 1 : 0,
          $seconds: e.seconds ?? null,
          $ref: e.ref ?? null,
        })
      }
      this.markDirty(hourStart(minTs))
    })
    tx(events)
    return events.length
  }

  /**
   * Add events straight to usage_hour, never to usage_event: for calls already older than the raw window,
   * which would only be pruned again. Additive (not idempotent), so the caller must write the file's
   * cursor in the same transaction and never feed the same call twice. Returns events added.
   */
  addToHourly(events: readonly UsageEventInput[]): number {
    if (events.length === 0) return 0
    const groups = new Map<
      string,
      { e: UsageEventInput; n: Record<string, number>; calls: number }
    >()
    for (const e of events) {
      const hour = hourStart(e.ts)
      const key = [hour, ...KIT_HOUR_DIMS.map((d) => e[d] ?? '')].join('\u0000')
      let g = groups.get(key)
      if (!g) {
        g = { e: { ...e, ts: hour }, n: {}, calls: 0 }
        groups.set(key, g)
      }
      g.calls++
      for (const m of KIT_MEASURES) {
        const v = e[m]
        if (v != null) g.n[m] = (g.n[m] ?? 0) + v
      }
    }
    const nullable = new Set(['list_usd', 'billed_usd', 'seconds'])
    const cols = KIT_MEASURES.map((m) => m)
    const stmt = this.db.prepare(
      `insert into usage_hour (hour, day, ${KIT_HOUR_DIMS.join(', ')}, calls, ok_calls, failed_calls, ${cols.join(', ')})
       values ($hour, $day, ${KIT_HOUR_DIMS.map((d) => `$${d}`).join(', ')}, $calls, $ok, $failed, ${cols.map((c) => `$${c}`).join(', ')})
       on conflict (hour, pc, account, instance, agent, source, model, provider) do update set
         calls = calls + excluded.calls, ok_calls = ok_calls + excluded.ok_calls,
         failed_calls = failed_calls + excluded.failed_calls,
         ${cols.map((c) => (nullable.has(c) ? `${c} = case when ${c} is null and excluded.${c} is null then null else coalesce(${c}, 0) + coalesce(excluded.${c}, 0) end` : `${c} = ${c} + excluded.${c}`)).join(', ')}`,
    )
    this.db.transaction(() => {
      for (const g of groups.values()) {
        const p: Record<string, string | number | null> = {
          $hour: g.e.ts,
          $day: g.e.day ?? localDay(g.e.ts),
          $calls: g.calls,
          $ok: 0,
          $failed: 0,
        }
        for (const d of KIT_HOUR_DIMS) p[`$${d}`] = g.e[d] ?? ''
        for (const c of cols) p[`$${c}`] = g.n[c] ?? (nullable.has(c) ? null : 0)
        stmt.run(p)
      }
    })()
    return events.length
  }

  /**
   * Settle calls already older than the raw window without a usage_event row: they are added to usage_hour,
   * to the live session ledger and to its settled part (the same keys pruneRaw folds raw rows under).
   * First claim wins: an id that has a raw row, or was settled before (by this source or a copy of it in
   * another), is dropped. Additive, so the caller writes the file's cursor in the same transaction.
   * Returns calls settled.
   */
  settleOld(events: readonly UsageEventInput[]): number {
    const inRaw = this.db.prepare('select 1 from usage_event where id = ?')
    const claim = this.db.prepare('insert or ignore into settled_claim (h) values (?)')
    let fresh: UsageEventInput[] = []
    this.db.transaction(() => {
      fresh = events.filter(
        (e) =>
          !inRaw.get(e.id) &&
          claim.run(createHash('sha1').update(e.id).digest().readBigInt64BE(0)).changes === 1,
      )
      this.addToHourly(fresh)
      this.addToSessions(fresh)
    })()
    return fresh.length
  }

  /** Add events to usage_session and usage_session_settled (both keep them forever). */
  private addToSessions(events: readonly UsageEventInput[]): void {
    if (events.length === 0) return
    const nullable = new Set(['list_usd', 'billed_usd', 'seconds'])
    const groups = new Map<
      string,
      { e: UsageEventInput; first: number; last: number; calls: number; n: Record<string, number> }
    >()
    for (const e of events) {
      const key = KIT_SESSION_KEY.map((k) => e[k] ?? '').join('\u0000')
      let g = groups.get(key)
      if (!g) {
        g = { e, first: e.ts, last: e.ts, calls: 0, n: {} }
        groups.set(key, g)
      }
      g.calls++
      g.first = Math.min(g.first, e.ts)
      g.last = Math.max(g.last, e.ts)
      for (const m of KIT_MEASURES) {
        const v = e[m]
        if (v != null) g.n[m] = (g.n[m] ?? 0) + v
      }
    }
    const select = `select ${KIT_SESSION_KEY.map((k) => `$${k}`).join(', ')}, $first, $last, $calls, 0, 0,
      ${KIT_MEASURES.map((m) => `$${m}`).join(', ')} where true`
    const stmts = ['usage_session', 'usage_session_settled'].map((t) =>
      this.db.prepare(sessionAddSql(t, select)),
    )
    for (const g of groups.values()) {
      const p: Record<string, string | number | null> = {
        $first: g.first,
        $last: g.last,
        $calls: g.calls,
      }
      for (const k of KIT_SESSION_KEY) p[`$${k}`] = g.e[k] ?? ''
      for (const m of KIT_MEASURES) p[`$${m}`] = g.n[m] ?? (nullable.has(m) ? null : 0)
      for (const s of stmts) s.run(p)
    }
  }

  // ---- meta ----

  /** Hour below which raw events were pruned (so no new one is taken), or null before the first prune. */
  rawCut(): number | null {
    const v = this.getMeta('raw_cut')
    return v === null ? null : Number(v)
  }

  getMeta(key: string): string | null {
    const r = this.db.query('select value from meta where key = ?').get(key) as {
      value: string
    } | null
    return r ? r.value : null
  }

  setMeta(key: string, value: string): void {
    this.db.query('insert or replace into meta (key, value) values (?, ?)').run(key, value)
  }

  /** Oldest hour whose rollup may be stale; every upsert lowers it, a rollup clears it. */
  private markDirty(hour: number): void {
    const cur = this.getMeta('dirty_from')
    if (cur === null || hour < Number(cur)) this.setMeta('dirty_from', String(hour))
  }

  // ---- ingest cursors ----

  getCursor(path: string): IngestCursor | null {
    return (
      (this.db
        .query('select * from ingest_cursor where path = ?')
        .get(path) as IngestCursor | null) ?? null
    )
  }

  setCursor(c: IngestCursor): void {
    this.db
      .query(
        'insert or replace into ingest_cursor (path, size, mtime, offset, version) values (?, ?, ?, ?, ?)',
      )
      .run(c.path, c.size, c.mtime, c.offset, c.version)
  }

  // ---- rollup, pruning, rebuild ----

  /**
   * Recompute usage_hour for every hour from `fromTs` (default: the oldest stale hour) to the newest
   * raw event, from usage_event, and usage_session for every session with a raw event in that range
   * (its settled, already pruned part plus its raw rows). Idempotent. Hours below the raw cut have no
   * raw rows left and are never touched. Returns the number of hourly rows written.
   */
  rollup(fromTs?: number): number {
    const dirty = this.getMeta('dirty_from')
    let from = fromTs !== undefined ? hourStart(fromTs) : dirty !== null ? Number(dirty) : null
    if (from === null) return 0
    from = Math.max(from, this.rawCut() ?? -Infinity)
    const dims = KIT_HOUR_DIMS.map((d) => `coalesce(${d}, '')`).join(', ')
    const sums = KIT_MEASURES.filter((m) => m !== 'weighted')
      .map((m) => `sum(${m})`)
      .join(', ')
    let written = 0
    this.db.transaction(() => {
      this.db.query('delete from usage_hour where hour >= ?').run(from)
      written = this.db
        .query(
          `insert into usage_hour (hour, day, ${KIT_HOUR_DIMS.join(', ')}, calls, ok_calls, failed_calls,
             ${KIT_MEASURES.filter((m) => m !== 'weighted').join(', ')}, weighted)
           select (ts - (ts % ${HOUR_MS})) as h, min(day), ${dims}, count(*),
             sum(case when ok = 1 then 1 else 0 end), sum(case when ok = 0 then 1 else 0 end),
             ${sums}, sum(weighted)
           from usage_event where ts >= ?
           group by h, ${dims}`,
        )
        .run(from).changes
      this.rollupSessions(from)
      if (dirty === null || from <= Number(dirty)) {
        this.db.query("delete from meta where key = 'dirty_from'").run()
      }
    })()
    return written
  }

  /** Rebuild the usage_session rows of every (session, ref) with a raw event at or after `from`. */
  private rollupSessions(from: number): void {
    const pairs = this.db
      .query(
        "select distinct coalesce(session, '') as s, coalesce(ref, '') as r from usage_event where ts >= ?",
      )
      .all(from) as { s: string; r: string }[]
    const del = this.db.prepare('delete from usage_session where session = $s and ref = $r')
    const fresh = this.db.prepare(
      sessionAddSql(
        'usage_session',
        sessionAggSql("coalesce(session, '') = $s and coalesce(ref, '') = $r"),
      ),
    )
    const settled = this.db.prepare(
      sessionAddSql(
        'usage_session',
        'select * from usage_session_settled where session = $s and ref = $r',
      ),
    )
    for (const { s, r } of pairs) {
      const a = { $s: s, $r: r }
      del.run(a)
      fresh.run(a)
      settled.run(a)
    }
  }

  /**
   * Delete raw events older than the retention window (cut at an hour boundary so no hour is left half
   * rolled up). Rolls the doomed hours up first, so the hourly rows always survive. Returns rows deleted.
   */
  pruneRaw(now: number = Date.now(), days: number = RAW_RETENTION_DAYS): number {
    const cutoff = hourStart(now - days * DAY_MS)
    const oldest = this.db.query('select min(ts) as t from usage_event').get() as {
      t: number | null
    }
    if (oldest.t === null || oldest.t >= cutoff) return 0
    const oldestTs = oldest.t
    let deleted = 0
    this.db.transaction(() => {
      this.rollup(Math.min(hourStart(oldestTs), Number(this.getMeta('dirty_from') ?? Infinity)))
      // The sessions' totals do not change: the doomed rows move from raw into the settled part.
      this.db.exec(sessionAddSql('usage_session_settled', sessionAggSql(`ts < ${cutoff}`)))
      deleted = this.db.query('delete from usage_event where ts < ?').run(cutoff).changes
      this.setMeta('raw_cut', String(Math.max(cutoff, this.rawCut() ?? cutoff)))
    })()
    return deleted
  }

  /** The hourly job: roll up what changed, then prune. */
  runMaintenance(now: number = Date.now()): { rolledUp: number; pruned: number } {
    const rolledUp = this.rollup()
    const pruned = this.pruneRaw(now)
    return { rolledUp, pruned }
  }

  /**
   * Drop every table and recreate it empty (cursors included, so the next ingest re-reads every source
   * file). Pass a price version to record the one the rebuild will use.
   */
  dropAndRebuild(priceVer?: string): void {
    dropKitSchema(this.db)
    migrateKitSchema(this.db)
    if (priceVer !== undefined) this.setMeta('price_ver', priceVer)
  }
}
