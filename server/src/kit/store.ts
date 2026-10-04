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
  LAZY_INDEX_NAMES,
  LAZY_INDEXES_SQL,
  migrateKitSchema,
  sessionAddSql,
  sessionAggSql,
} from './schema'
import { ensureSettledPart, tagRawRange, tagSettledCalls } from './settled-part'

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

/**
 * bun:sqlite is synchronous: a statement or transaction that runs for a second holds the whole daemon for
 * that second (HTTP, MCP, CliMayte placement). Long store work is therefore cut into slices of about
 * SLICE_MS, each its own transaction, with a turn of the event loop between them.
 */
export const SLICE_MS = 40
/** Rows per transaction when events are written in slices (about 10 ms of sqlite each). */
export const WRITE_SLICE = 500
/** A turn of the event loop: timers, I/O and the HTTP server run before the caller continues. */
export const yieldLoop = (): Promise<void> => {
  for (const s of OPEN_STORES) s.checkpointSoon()
  return new Promise((r) => setTimeout(r, 0))
}
const OPEN_STORES = new Set<KitStore>()
const CHECKPOINT_EVERY_MS = 1500
/** A persistent connection that only checkpoints (passive: it never blocks the writer). */
const CHECKPOINT_WORKER_SOURCE = `
const { Database } = require('bun:sqlite')
let db = null
self.onmessage = (e) => {
  try {
    if (!db) {
      db = new Database(e.data.path)
      db.exec('pragma busy_timeout = 5000')
    }
    db.exec('pragma wal_checkpoint(PASSIVE)')
    self.postMessage({})
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) })
  }
}
`

/** Long store work is written once as a generator that yields between slices; these two run it. */
type Steps<T> = Generator<void, T>

function runSteps<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

async function runStepsAsync<T>(g: Steps<T>): Promise<T> {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
    await yieldLoop()
  }
}

/**
 * Walks [lo, hi) in hour-aligned slices, `step(a, b)` run for each. The slice grows while a step is quick
 * and shrinks when it runs over, so a sparse store takes few slices and a dense hour still stays short.
 */
export function* hourSlices(
  lo: number,
  hi: number,
  step: (a: number, b: number) => void,
): Steps<void> {
  let span = 12
  for (let a = hourStart(lo); a < hi; ) {
    const b = Math.min(a + span * HOUR_MS, hi)
    const t = performance.now()
    step(a, b)
    const took = performance.now() - t
    if (took < SLICE_MS / 3) span = Math.min(span * 2, 24 * 90)
    else if (took > SLICE_MS) span = Math.max(1, span >> 1)
    a = b
    yield
  }
}

/** Raw rows per slice of usage_event work (about 20-40 ms of sqlite whatever the density of the hour). */
export const SLICE_ROWS = 1000
/** Deleting a raw row also maintains every index, so the prune takes fewer per slice. */
const PRUNE_ROWS = 400
/** Raw rows of one session added up per transaction when its usage_session row is rebuilt. */
const SESSION_CHUNK_ROWS = 1500

/**
 * Walks [lo, hi) in slices that hold about `rows` raw events each, `step(a, b)` run for each. The first
 * slice starts on the hour of `lo`, so a step that treats "the hours that start in [a, b)" as its own sees
 * every hour exactly once. A dense hour is cut into several slices, a sparse month is one.
 */
export function* eventSlices(
  db: Database,
  lo: number,
  hi: number,
  step: (a: number, b: number) => void,
  rows: number = SLICE_ROWS,
): Steps<void> {
  const edge = db.prepare('select ts from usage_event where ts >= $a order by ts limit 1 offset $n')
  for (let a = hourStart(lo); a < hi; ) {
    const r = edge.get({ $a: a, $n: rows }) as { ts: number } | null
    const b = Math.min(r ? Math.max(r.ts, a + 1) : hi, hi)
    step(a, b)
    a = b
    yield
  }
}

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

/** Runs one statement on a connection of its own, off the daemon's thread (like core/sqlite-worker.ts). */
const EXEC_WORKER_SOURCE = `
const { Database } = require('bun:sqlite')
self.onmessage = (e) => {
  const { path, sql } = e.data
  let db = null
  try {
    db = new Database(path)
    db.exec('pragma busy_timeout = 30000')
    db.exec(sql)
    self.postMessage({})
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) })
  } finally {
    if (db) db.close()
  }
}
`

export class KitStore {
  readonly db: Database
  private readonly upsertStmt
  /** Bumped when every cursor is dropped, so a cache of cursors held by an ingest knows it is stale. */
  cursorEpoch = 0

  constructor(readonly path: string = kitDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    if (path !== ':memory:') this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma synchronous = NORMAL')
    // 64 MB of pages, not 2: a usage query over a week of the ledger reads tens of MB and re-reads them from the OS each time.
    this.db.exec('pragma cache_size = -65536')
    migrateKitSchema(this.db)
    ensureSettledPart(this.db)
    this.upsertStmt = this.prepareUpsert()
    if (path !== ':memory:') OPEN_STORES.add(this)
  }

  private prepareUpsert() {
    return this.db.prepare(
      `insert or replace into usage_event (${EVENT_COLS.join(',')}) values (${EVENT_COLS.map((c) => `$${c}`).join(',')})`,
    )
  }

  close(): void {
    OPEN_STORES.delete(this)
    this.ckptWorker?.terminate()
    this.ckptWorker = null
    this.db.close()
  }

  private ckptWorker: Worker | null = null
  private ckptBusy = false
  private ckptAt = 0
  private ckptOff = false

  /**
   * A WAL checkpoint run by the commit that crosses the threshold fsyncs the database file on the daemon's
   * thread (100-500 ms on a live-size store, whichever slice happened to commit). Once a store is being
   * written in slices, checkpoints are made by a connection of a worker thread instead, at most one every
   * CHECKPOINT_EVERY_MS, and the writer's own automatic checkpoint is switched off. Called on every turn
   * that long work gives back to the loop; costs nothing between checkpoints.
   */
  checkpointSoon(): void {
    if (this.path === ':memory:' || this.ckptOff || this.ckptBusy) return
    const now = Date.now()
    if (now - this.ckptAt < CHECKPOINT_EVERY_MS) return
    this.ckptAt = now
    try {
      if (!this.ckptWorker) {
        this.ckptWorker = new Worker(
          URL.createObjectURL(new Blob([CHECKPOINT_WORKER_SOURCE], { type: 'text/javascript' })),
        )
        this.ckptWorker.onmessage = (e: MessageEvent<{ error?: string }>) => {
          this.ckptBusy = false
          if (e.data.error !== undefined) this.stopCheckpointWorker()
        }
        this.ckptWorker.onerror = () => this.stopCheckpointWorker()
        this.ckptWorker.unref()
        this.db.exec('pragma wal_autocheckpoint = 0')
      }
      this.ckptBusy = true
      this.ckptWorker.postMessage({ path: this.path })
    } catch {
      this.stopCheckpointWorker()
    }
  }

  /** The worker failed: the writer's automatic checkpoint is restored and no more are tried. */
  private stopCheckpointWorker(): void {
    this.ckptOff = true
    this.ckptBusy = false
    this.ckptWorker?.terminate()
    this.ckptWorker = null
    try {
      this.db.exec('pragma wal_autocheckpoint = 1000')
    } catch {
      // closed
    }
  }

  /**
   * Builds the indexes that migrateKitSchema leaves out of a big table, on a worker thread: the build
   * takes seconds and would hold the daemon for all of them on this one. Where a worker cannot be
   * started (an in-memory store, no Worker) it is built here. Call it before the first write of a sweep.
   */
  async ensureIndexes(): Promise<void> {
    const have = this.db
      .query(
        `select count(*) as n from sqlite_master where type = 'index' and name in (${LAZY_INDEX_NAMES.map((n) => `'${n}'`).join(', ')})`,
      )
      .get() as { n: number }
    if (have.n === LAZY_INDEX_NAMES.length) return
    if (this.path !== ':memory:') {
      try {
        const w = new Worker(
          URL.createObjectURL(new Blob([EXEC_WORKER_SOURCE], { type: 'text/javascript' })),
        )
        try {
          await new Promise<void>((resolve, reject) => {
            w.onmessage = (e: MessageEvent<{ error?: string }>) =>
              e.data.error === undefined ? resolve() : reject(new Error(e.data.error))
            w.onerror = (e) => reject(new Error(e.message))
            w.postMessage({ path: this.path, sql: LAZY_INDEXES_SQL })
          })
          return
        } finally {
          w.terminate()
        }
      } catch {
        // fall through to building it here
      }
    }
    this.db.exec(LAZY_INDEXES_SQL)
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

  /** upsertEvents in slices of WRITE_SLICE rows, each its own transaction, with a turn of the loop between. */
  async upsertEventsAsync(input: readonly UsageEventInput[]): Promise<number> {
    let n = 0
    for (let i = 0; i < input.length; i += WRITE_SLICE) {
      n += this.upsertEvents(input.slice(i, i + WRITE_SLICE))
      await yieldLoop()
    }
    return n
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
      tagSettledCalls(this.db, fresh) // so a version upgrade can take back what a transcript still on disk gave
    })()
    return fresh.length
  }

  /** settleOld in slices of WRITE_SLICE calls. Each slice is atomic with its claims, so a cut-short run
   *  is finished by the next one without counting a call twice. */
  async settleOldAsync(events: readonly UsageEventInput[]): Promise<number> {
    let n = 0
    for (let i = 0; i < events.length; i += WRITE_SLICE) {
      n += this.settleOld(events.slice(i, i + WRITE_SLICE))
      await yieldLoop()
    }
    return n
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
  //
  // Each of these is written once as a generator (…Steps) that yields between slices; the plain method runs
  // it to the end, the …Async one gives the event loop a turn between slices (see SLICE_MS). Every slice is
  // a transaction of its own, so a rollup or prune that is cut short leaves a store that the next run
  // finishes: both are idempotent per hour / per session, and pruneRaw raises raw_cut slice by slice.

  /**
   * Recompute usage_hour for every hour from `fromTs` (default: the oldest stale hour) to the newest
   * raw event, from usage_event, and usage_session for every session with a raw event in that range
   * (its settled, already pruned part plus its raw rows). Idempotent. Hours below the raw cut have no
   * raw rows left and are never touched. Returns the number of hourly rows written.
   */
  rollup(fromTs?: number): number {
    return runSteps(this.rollupSteps(fromTs))
  }

  rollupAsync(fromTs?: number): Promise<number> {
    return runStepsAsync(this.rollupSteps(fromTs))
  }

  private *rollupSteps(fromTs?: number): Steps<number> {
    const dirty = this.getMeta('dirty_from')
    const from = fromTs !== undefined ? hourStart(fromTs) : dirty !== null ? Number(dirty) : null
    if (from === null) return 0
    const written = yield* this.rollupRange(from, Infinity)
    if (dirty === null || Math.max(from, this.rawCut() ?? -Infinity) <= Number(dirty)) {
      this.db.query("delete from meta where key = 'dirty_from'").run()
    }
    return written
  }

  /** usage_hour for the hours in [from, to) and usage_session for each session with a raw event there. */
  private *rollupRange(from: number, to: number): Steps<number> {
    from = Math.max(from, this.rawCut() ?? -Infinity)
    const dims = KIT_HOUR_DIMS.map((d) => `coalesce(${d}, '')`).join(', ')
    const sums = KIT_MEASURES.filter((m) => m !== 'weighted')
      .map((m) => `sum(${m})`)
      .join(', ')
    // Hours that exist in usage_hour but have no raw event any more still have to be cleared.
    // Index seeks (a min() over a union scans the range, which is seconds on a live-size store).
    const edgeOf = (table: string, col: string, dir: 'asc' | 'desc'): number | null =>
      (
        this.db
          .query(
            `select ${col} as t from ${table} where ${col} >= $from order by ${col} ${dir} limit 1`,
          )
          .get({ $from: from }) as { t: number } | null
      )?.t ?? null
    const lows = [edgeOf('usage_event', 'ts', 'asc'), edgeOf('usage_hour', 'hour', 'asc')].filter(
      (v): v is number => v !== null,
    )
    const highs = [
      edgeOf('usage_event', 'ts', 'desc'),
      edgeOf('usage_hour', 'hour', 'desc'),
    ].filter((v): v is number => v !== null)
    if (lows.length === 0 || highs.length === 0) return 0
    const edge = { lo: Math.min(...lows), hi: Math.max(...highs) }
    const hi = Math.min(hourStart(edge.hi) + HOUR_MS, to)
    // An hour's row is deleted by the slice its first millisecond falls in; every slice of the hour adds.
    const del = this.db.prepare('delete from usage_hour where hour >= $a and hour < $b')
    const cols = KIT_MEASURES.map((m) => m)
    const nullable = new Set(['list_usd', 'billed_usd', 'seconds'])
    const ins = this.db.prepare(
      `insert into usage_hour (hour, day, ${KIT_HOUR_DIMS.join(', ')}, calls, ok_calls, failed_calls,
         ${KIT_MEASURES.filter((m) => m !== 'weighted').join(', ')}, weighted)
       select (ts - (ts % ${HOUR_MS})) as h, min(day), ${dims}, count(*),
         sum(case when ok = 1 then 1 else 0 end), sum(case when ok = 0 then 1 else 0 end),
         ${sums}, sum(weighted)
       from usage_event where ts >= $a and ts < $b
       group by h, ${dims}
       on conflict (hour, pc, account, instance, agent, source, model, provider) do update set
         calls = calls + excluded.calls, ok_calls = ok_calls + excluded.ok_calls,
         failed_calls = failed_calls + excluded.failed_calls,
         ${cols.map((c) => (nullable.has(c) ? `${c} = case when ${c} is null and excluded.${c} is null then null else coalesce(${c}, 0) + coalesce(excluded.${c}, 0) end` : `${c} = ${c} + excluded.${c}`)).join(', ')}`,
    )
    const pairsOf = this.db.prepare(
      "select distinct coalesce(session, '') as s, coalesce(ref, '') as r from usage_event where ts >= $a and ts < $b",
    )
    let written = 0
    const pairs = new Map<string, { s: string; r: string }>()
    yield* eventSlices(this.db, Math.max(from, hourStart(edge.lo)), hi, (a, b) => {
      this.db.transaction(() => {
        del.run({ $a: a, $b: b })
        written += ins.run({ $a: a, $b: b }).changes
      })()
      for (const p of pairsOf.all({ $a: a, $b: b }) as { s: string; r: string }[])
        pairs.set(`${p.s}\u0000${p.r}`, p)
    })
    yield* this.rollupSessions([...pairs.values()])
    return written
  }

  /** Rebuild the usage_session rows of the given (session, ref) pairs. */
  private *rollupSessions(pairs: readonly { s: string; r: string }[]): Steps<void> {
    const del = this.db.prepare('delete from usage_session where session = $s and ref = $r')
    const mine = "coalesce(session, '') = $s and coalesce(ref, '') = $r"
    const fresh = this.db.prepare(
      sessionAddSql('usage_session', sessionAggSql(`${mine} and rowid > $lo and rowid <= $hi`)),
    )
    const freshRest = this.db.prepare(
      sessionAddSql('usage_session', sessionAggSql(`${mine} and rowid > $lo`)),
    )
    // The rowid of the row that ends a chunk of this session's raw rows (an index walk).
    const chunkEnd = this.db.prepare(
      `select rowid as r from usage_event where ${mine} and rowid > $lo order by rowid limit 1 offset ${SESSION_CHUNK_ROWS}`,
    )
    const settled = this.db.prepare(
      sessionAddSql(
        'usage_session',
        'select * from usage_session_settled where session = $s and ref = $r',
      ),
    )
    let since = performance.now()
    for (let i = 0; i < pairs.length; i++) {
      const a = { $s: (pairs[i] as { s: string }).s, $r: (pairs[i] as { r: string }).r }
      // A session with a great many raw rows is added up a chunk of rows at a time, each its own
      // transaction (the sums are additive); the first one also clears the old row and adds the settled part.
      let lo = 0
      for (let first = true; ; first = false) {
        const end = (chunkEnd.get({ ...a, $lo: lo }) as { r: number } | null)?.r
        this.db.transaction(() => {
          if (first) {
            del.run(a)
            settled.run(a)
          }
          if (end === undefined) freshRest.run({ ...a, $lo: lo })
          else fresh.run({ ...a, $lo: lo, $hi: end })
        })()
        if (end === undefined) break
        lo = end
        since = performance.now()
        yield
      }
      if (performance.now() - since >= SLICE_MS) {
        since = performance.now()
        yield
      }
    }
  }

  /**
   * Delete raw events older than the retention window (cut at an hour boundary so no hour is left half
   * rolled up). Rolls the doomed hours up first, so the hourly rows always survive. Returns rows deleted.
   */
  pruneRaw(now: number = Date.now(), days: number = RAW_RETENTION_DAYS): number {
    return runSteps(this.pruneRawSteps(now, days))
  }

  pruneRawAsync(now: number = Date.now(), days: number = RAW_RETENTION_DAYS): Promise<number> {
    return runStepsAsync(this.pruneRawSteps(now, days))
  }

  private *pruneRawSteps(now: number, days: number): Steps<number> {
    const cutoff = hourStart(now - days * DAY_MS)
    const oldest = this.db.query('select ts as t from usage_event order by ts limit 1').get() as {
      t: number | null
    } | null
    if (!oldest || oldest.t === null || oldest.t >= cutoff) return 0
    const oldestHour = hourStart(oldest.t)
    // Only the doomed hours are rolled up; whatever was stale at or after the cut stays stale.
    const dirty = this.getMeta('dirty_from')
    yield* this.rollupRange(Math.min(oldestHour, Number(dirty ?? Infinity)), cutoff)
    if (dirty !== null && Number(dirty) < cutoff) this.setMeta('dirty_from', String(cutoff))
    let deleted = 0
    // The sessions' totals do not change: the doomed rows move from raw into the settled part.
    const fold = this.db.prepare(
      sessionAddSql('usage_session_settled', sessionAggSql('ts >= $a and ts < $b')),
    )
    const drop = this.db.prepare('delete from usage_event where ts >= $a and ts < $b')
    // A slice can end inside an hour. Every doomed hour was rolled up above, so raw_cut is raised to the end
    // of the hour the slice reaches: a run cut short here is never followed by a rollup of the hour's
    // remaining raw rows over its complete usage_hour row.
    yield* eventSlices(
      this.db,
      oldestHour,
      cutoff,
      (a, b) => {
        this.db.transaction(() => {
          fold.run({ $a: a, $b: b })
          tagRawRange(this.db, a, b)
          deleted += drop.run({ $a: a, $b: b }).changes
          const reached = hourStart(b - 1) + HOUR_MS
          this.setMeta('raw_cut', String(Math.max(reached, this.rawCut() ?? reached)))
        })()
      },
      PRUNE_ROWS,
    )
    return deleted
  }

  /** The hourly job: roll up what changed, then prune. */
  runMaintenance(now: number = Date.now()): { rolledUp: number; pruned: number } {
    const rolledUp = this.rollup()
    const pruned = this.pruneRaw(now)
    return { rolledUp, pruned }
  }

  async runMaintenanceAsync(
    now: number = Date.now(),
  ): Promise<{ rolledUp: number; pruned: number }> {
    const rolledUp = await this.rollupAsync()
    const pruned = await this.pruneRawAsync(now)
    return { rolledUp, pruned }
  }

  /**
   * Drop every table and recreate it empty (cursors included, so the next ingest re-reads every source
   * file). Pass a price version to record the one the rebuild will use.
   */
  dropAndRebuild(priceVer?: string): void {
    this.db.exec('drop table if exists settled_part')
    dropKitSchema(this.db)
    this.cursorEpoch++
    migrateKitSchema(this.db)
    ensureSettledPart(this.db)
    if (priceVer !== undefined) this.setMeta('price_ver', priceVer)
  }
}
