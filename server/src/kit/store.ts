// Analytics toolkit store: DATA_DIR/analytics.db (docs/ANALYTICS-PLAN.md §4.2-4.3).
// One row per model call in usage_event (kept RAW_RETENTION_DAYS), an hourly rollup in usage_hour
// (kept forever), per-file ingest cursors and a meta table. Nothing here reads a source file; ingest
// and the query API are separate pieces.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../config'
import { dropKitSchema, KIT_HOUR_DIMS, KIT_MEASURES, migrateKitSchema } from './schema'

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

  /** Insert or replace by id: the last write wins, matching accumulateUsageLine. Returns rows written. */
  upsertEvents(events: readonly UsageEventInput[]): number {
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

  // ---- meta ----

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
   * raw event, from usage_event. Idempotent. Returns the number of hourly rows written.
   */
  rollup(fromTs?: number): number {
    const dirty = this.getMeta('dirty_from')
    const from = fromTs !== undefined ? hourStart(fromTs) : dirty !== null ? Number(dirty) : null
    if (from === null) return 0
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
      if (dirty === null || from <= Number(dirty)) {
        this.db.query("delete from meta where key = 'dirty_from'").run()
      }
    })()
    return written
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
    this.rollup(Math.min(hourStart(oldest.t), Number(this.getMeta('dirty_from') ?? Infinity)))
    return this.db.query('delete from usage_event where ts < ?').run(cutoff).changes
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
