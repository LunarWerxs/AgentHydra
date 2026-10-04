// Analytics toolkit query API (docs/ANALYTICS-PLAN.md §4.4): the one function every usage reader asks.
// Inside the raw retention period it reads usage_event; older hours read the hourly rollup usage_hour.
// The two ranges are disjoint (cut at an hour boundary, the same one pruneRaw uses), so a window that
// straddles the line never counts a call twice.
// A query on a session or ref (filter or group) cannot use usage_hour, which has neither. It reads the
// per-session ledger usage_session for every (session, ref) the window covers whole, and raw rows (this
// side excluding those) for the rest, so no event is counted in both.
import type { Database } from 'bun:sqlite'
import { getCachedUsage } from '../usage-cache'
import { machineId } from './machine'
import { eventMeasureSql, KIT_SESSION_KEY } from './schema'
import { KitStore, RAW_RETENTION_DAYS } from './store'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export const FILTER_KEYS = [
  'account',
  'instance',
  'pc',
  'source',
  'model',
  'provider',
  'session',
  'ref',
  'agent',
  'ok',
] as const
export const GROUP_BYS = [
  'day',
  'hour',
  'account',
  'instance',
  'pc',
  'source',
  'model',
  'provider',
  'session',
  'ref',
] as const
export const MEASURES = [
  'tokens',
  'list_usd',
  'billed_usd',
  'unbilled_usd',
  'cost_usd',
  'weighted',
  'calls',
  'ok',
  'failed',
  'seconds',
] as const
/** Token kinds, opt-in: `tokens` stays the sum, these split it (`cache_write` = 5m + 1h writes). */
export const TOKEN_KIND_MEASURES = ['input', 'output', 'cache_read', 'cache_write'] as const
export const LAST_WINDOWS = ['5h', '24h', '7d', '30d', 'all'] as const

export type FilterKey = (typeof FILTER_KEYS)[number]
export type GroupBy = (typeof GROUP_BYS)[number]
export type Measure = (typeof MEASURES)[number] | (typeof TOKEN_KIND_MEASURES)[number]
export type LastWindow = (typeof LAST_WINDOWS)[number]
type One<T> = T | T[]

export type UsageWindow =
  | { from?: number; to?: number }
  | { last: LastWindow }
  | { account: string; kind: '5h' | 'week' }

export interface UsageQueryParams {
  window?: UsageWindow
  filter?: Partial<Record<Exclude<FilterKey, 'ok'>, One<string>>> & { ok?: One<boolean> }
  groupBy?: GroupBy[]
  measures?: Measure[]
  /** IANA zone the `day` buckets are cut in. Defaults to this machine's. */
  tz?: string
}

/** Reset instants (ISO) of an account's latest quota snapshot. */
export interface QuotaReset {
  sessionResetsAt?: string | null
  weekResetsAt?: string | null
}

export interface UsageQueryOpts {
  store?: KitStore
  now?: number
  /** Where an account's latest quota snapshot comes from. Defaults to the daemon's usage cache. */
  quota?: (account: string) => QuotaReset | null
  /** `false` leaves `coverage` empty: for a caller that never reads it, since computing it after each
   *  store write costs ~100 ms on the live store. */
  coverage?: boolean
}

export interface ResolvedWindow {
  from: number
  to: number
  /** How it was resolved: given by the caller, a `last` span, an account's snapshot, or the rolling fallback. */
  basis: 'explicit' | 'last' | 'snapshot' | 'snapshot-past' | 'rolling'
  account?: string
  kind?: '5h' | 'week'
  /** The snapshot's reset instant the window was cut from (ISO), when basis is `snapshot`. */
  resetsAt?: string
}

export type UsageRow = Record<string, string | number | null>

export interface UsageResult {
  rows: UsageRow[]
  totals: Partial<Record<Measure, number | null>>
  /** Models seen in the window that carry no list price (their tokens count, their dollars do not). */
  unpriced: string[]
  priceVer: string | null
  coverage: {
    sources: Record<string, { events: number; firstTs: number; lastTs: number }>
    cursors: { files: number; newestMtime: number | null }
    /** Oldest hour whose rollup may be stale, or null when the rollup is current. */
    dirtyFrom: number | null
  }
  window: ResolvedWindow
  /** Places the answer is narrower than asked (e.g. a filter the hourly rollup cannot apply). */
  notes: string[]
}

const LAST_MS: Record<Exclude<LastWindow, 'all'>, number> = {
  '5h': 5 * HOUR_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}
const KIND_MS = { '5h': 5 * HOUR_MS, week: 7 * DAY_MS } as const

// ---- shared store and quota snapshot ----

let shared: KitStore | null = null
/** The daemon's analytics.db, opened on first use. */
export function sharedKitStore(): KitStore {
  shared ??= new KitStore()
  return shared
}

/**
 * An account's latest quota snapshot: the usage cache entry of an instance the account's calls came
 * from (usage_event.instance is the cache key), newest reading first.
 */
export function cachedQuota(db: Database): (account: string) => QuotaReset | null {
  return (account) => {
    const insts = db
      .query(
        'select instance from usage_event where account = ? and instance is not null group by instance order by max(ts) desc limit 8',
      )
      .all(account) as { instance: string }[]
    let best: { at: string; q: QuotaReset } | null = null
    for (const { instance } of insts) {
      const snap = getCachedUsage(instance)
      if (!snap) continue
      const q = {
        sessionResetsAt: snap.session?.resetsAt ?? null,
        weekResetsAt: snap.weekAll?.resetsAt ?? null,
      }
      if (!q.sessionResetsAt && !q.weekResetsAt) continue
      if (!best || snap.capturedAt > best.at) best = { at: snap.capturedAt, q }
    }
    return best?.q ?? null
  }
}

/**
 * `[resetsAt - span, now]` from the account's snapshot. A reset instant already in the past means the
 * snapshot predates the current window: it began at that reset plus whole spans (so never more than one
 * span back), basis `snapshot-past`. With no snapshot the window rolls back `span` from now.
 */
export function resolveWindow(
  w: UsageWindow | undefined,
  now: number,
  quota: (account: string) => QuotaReset | null,
): ResolvedWindow {
  if (w && 'account' in w) {
    const span = KIND_MS[w.kind]
    const q = quota(w.account)
    const iso = w.kind === '5h' ? q?.sessionResetsAt : q?.weekResetsAt
    const reset = iso ? Date.parse(iso) : Number.NaN
    const base = { to: now, account: w.account, kind: w.kind }
    if (Number.isFinite(reset) && reset > now) {
      return {
        ...base,
        from: reset - span,
        basis: 'snapshot',
        resetsAt: new Date(reset).toISOString(),
      }
    }
    if (Number.isFinite(reset)) {
      // A reset already past: the snapshot predates the current window but still fixes the cadence, so
      // the window began at the latest reset instant not after now (never more than one span back).
      const from = reset + Math.floor((now - reset) / span) * span
      return { ...base, from, basis: 'snapshot-past', resetsAt: new Date(reset).toISOString() }
    }
    return { ...base, from: now - span, basis: 'rolling' }
  }
  if (w && 'last' in w) {
    return {
      from: w.last === 'all' ? 0 : now - LAST_MS[w.last],
      to: now,
      basis: 'last',
    }
  }
  return { from: w?.from ?? 0, to: w?.to ?? now, basis: 'explicit' }
}

// ---- query building ----

const toList = <T>(v: One<T> | undefined): T[] | null =>
  v === undefined ? null : Array.isArray(v) ? v : [v]

interface Where {
  sql: string
  args: (string | number)[]
}

/** `col in (...)` clauses for the dimension filters both tables share. `nul` maps the rollup's '' back. */
function dimWhere(filter: NonNullable<UsageQueryParams['filter']>): Where {
  const parts: string[] = []
  const args: (string | number)[] = []
  for (const k of ['account', 'instance', 'pc', 'source', 'model', 'provider', 'agent'] as const) {
    const vals = toList(filter[k])
    if (!vals) continue
    if (vals.length === 0) {
      parts.push('0')
      continue
    }
    // `pc=self`: this machine's own events. The sweep stamps every row with machineId(); rows from before
    // that carry no pc (the rollup stores ''), so "self" is this machine's id or the empty pc, alone or
    // alongside named PCs.
    if (k === 'pc') {
      const named = vals.filter((v) => v !== 'self')
      const self = named.length !== vals.length
      const names = self ? [...new Set([...named, machineId()])] : named
      const clause = names.length ? [`pc in (${names.map(() => '?').join(',')})`] : []
      if (self) clause.push("(pc is null or pc = '')")
      parts.push(`(${clause.join(' or ')})`)
      args.push(...names)
      continue
    }
    parts.push(`${k} in (${vals.map(() => '?').join(',')})`)
    args.push(...vals)
  }
  return { sql: parts.length ? ` and ${parts.join(' and ')}` : '', args }
}

const DIM_COLS: Record<Exclude<GroupBy, 'day' | 'hour'>, string> = {
  account: 'account',
  instance: 'instance',
  pc: 'pc',
  source: 'source',
  model: 'model',
  provider: 'provider',
  session: 'session',
  ref: 'ref',
}

const TOKEN_SUM = 'input + output + cache_read + cache_write_5m + cache_write_1h'

interface RawRow {
  h: number | null
  tokens: number
  list_usd: number | null
  billed_usd: number | null
  unbilled_usd: number
  cost_usd: number
  weighted: number
  calls: number
  ok: number
  failed: number
  seconds: number | null
  input: number
  output: number
  cache_read: number
  cache_write: number
  [dim: string]: string | number | null
}

type DimCol = Exclude<GroupBy, 'day' | 'hour'>

function selectRows(
  db: Database,
  table: 'usage_event' | 'usage_hour' | 'usage_session',
  dims: DimCol[],
  withHour: boolean,
  where: Where,
  bucketMs = HOUR_MS,
  flagUnpriced = false,
): RawRow[] {
  const raw = table === 'usage_event'
  // The hourly rollup keeps no session or ref; both rollups store NULL as ''.
  const noSess = table === 'usage_hour'
  const dimSel = dims.map((d) => {
    if (raw) return DIM_COLS[d]
    return noSess && (d === 'session' || d === 'ref')
      ? `null as ${d}`
      : `nullif(${DIM_COLS[d]}, '') as ${d}`
  })
  const hourSel = withHour ? (raw ? `ts - (ts % ${bucketMs}) as h` : 'hour as h') : 'null as h'
  const group = [
    withHour ? 'h' : null,
    ...dims.filter((d) => !noSess || (d !== 'session' && d !== 'ref')).map((d) => DIM_COLS[d]),
  ]
    .filter(Boolean)
    .join(', ')
  const measures = raw
    ? `sum(${TOKEN_SUM}) as tokens, sum(list_usd) as list_usd, sum(billed_usd) as billed_usd,
       ${eventMeasureSql('unbilled_usd')} as unbilled_usd, ${eventMeasureSql('cost_usd')} as cost_usd,
       sum(weighted) as weighted, count(*) as calls, sum(case when ok = 1 then 1 else 0 end) as ok,
       sum(case when ok = 0 then 1 else 0 end) as failed, sum(seconds) as seconds`
    : `sum(${TOKEN_SUM}) as tokens, sum(list_usd) as list_usd, sum(billed_usd) as billed_usd,
       sum(unbilled_usd) as unbilled_usd, sum(cost_usd) as cost_usd,
       sum(weighted) as weighted, sum(calls) as calls, sum(ok_calls) as ok,
       sum(failed_calls) as failed, sum(seconds) as seconds`
  const kinds =
    'sum(input) as input, sum(output) as output, sum(cache_read) as cache_read, sum(cache_write_5m + cache_write_1h) as cache_write'
  // The ledger's unpriced models ride on the same pass: a second read of its wide rows costs as much again.
  const unp = flagUnpriced
    ? ", sum(case when list_usd is null and model != '' then 1 else 0 end) as unpriced_calls"
    : ''
  const sql = `select ${[hourSel, ...dimSel].join(', ')}, ${measures}, ${kinds}${unp} from ${table} where ${where.sql}${group ? ` group by ${group}` : ''}`
  return db.query(sql).all(...where.args) as RawRow[]
}

/** The same row with every measure negated: what a window leaves out, taken off a ledger row. */
function negated(r: RawRow): RawRow {
  const out: RawRow = { ...r }
  for (const k of NEGATED) if (out[k] !== null) out[k] = -(out[k] as number)
  return out
}
const NEGATED = [
  'tokens',
  'list_usd',
  'billed_usd',
  'weighted',
  'calls',
  'ok',
  'failed',
  'seconds',
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const

const addNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b

const dayFmt = new Map<string, Intl.DateTimeFormat>()
function dayOf(ts: number, tz: string | undefined): string {
  const key = tz ?? ''
  let f = dayFmt.get(key)
  if (!f) {
    // en-CA formats as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayFmt.set(key, f)
  }
  return f.format(ts)
}

/**
 * Changes on this connection plus other connections' commits: it moves on every store write
 * (events, rollups, prunes, meta, cursors) and holds still between them.
 */
export function storeGeneration(db: Database): string {
  const c = db.query('select total_changes() as c').get() as { c: number }
  const v = db.query('pragma data_version').get() as { data_version: number }
  return `${c.c}:${v.data_version}`
}

interface ResultCache {
  gen: string
  results: Map<string, UsageResult>
}
const resultCaches = new WeakMap<Database, ResultCache>()
const RESULT_CACHE_MAX = 64
const CACHE_BUCKET_MS = 60_000

function cacheFor(db: Database, gen: string): ResultCache {
  let c = resultCaches.get(db)
  if (!c || c.gen !== gen) {
    c = { gen, results: new Map() }
    resultCaches.set(db, c)
  }
  return c
}

/**
 * The same query answers the same until the store is written, so a result is reused until then
 * (and within one minute of a rolling window, whose edge moves with the clock).
 */
export function usageQuery(params: UsageQueryParams = {}, opts: UsageQueryOpts = {}): UsageResult {
  const store = opts.store ?? sharedKitStore()
  const gen = storeGeneration(store.db)
  const win = resolveWindow(
    params.window,
    opts.now ?? Date.now(),
    opts.quota ?? cachedQuota(store.db),
  )
  const key = JSON.stringify([
    params,
    opts.now ?? Math.floor(Date.now() / CACHE_BUCKET_MS),
    win.basis === 'snapshot' || win.basis === 'snapshot-past' ? win.from : null,
    opts.coverage === false,
  ])
  const cache = cacheFor(store.db, gen)
  const hit = cache.results.get(key)
  if (hit) return structuredClone(hit)
  const res = computeUsage(params, opts, store)
  // A query that wrote (the sessions temp table) moved the generation: do not file it under the old one.
  if (storeGeneration(store.db) === gen) {
    if (cache.results.size >= RESULT_CACHE_MAX) cache.results.clear()
    cache.results.set(key, structuredClone(res))
  }
  return res
}

function computeUsage(
  params: UsageQueryParams,
  opts: UsageQueryOpts,
  store: KitStore,
): UsageResult {
  const db = store.db
  const now = opts.now ?? Date.now()
  if (params.tz) new Intl.DateTimeFormat('en-CA', { timeZone: params.tz }) // throws RangeError on a bad zone
  const win = resolveWindow(params.window, now, opts.quota ?? cachedQuota(db))
  const filter = params.filter ?? {}
  const groupBy = params.groupBy ?? []
  const measures: Measure[] = params.measures ?? [...MEASURES]
  const notes: string[] = []

  const dims = [...new Set(groupBy.filter((g): g is DimCol => g !== 'day' && g !== 'hour'))]
  const wantDay = groupBy.includes('day')
  const wantHour = groupBy.includes('hour')
  const withHour = wantDay || wantHour
  // Raw rows bucket by quarter hour when only days are wanted, so a zone offset by 30 or 45 minutes
  // still puts each call on its local day.
  const dayBucket = wantDay && !wantHour ? 15 * 60_000 : HOUR_MS

  const cutoff = hourStart(now - RAW_RETENTION_DAYS * DAY_MS)
  const dim = dimWhere(filter)
  const okVals = toList(filter.ok)
  const sessVals = toList(filter.session)
  const refVals = toList(filter.ref)
  const sessionLike = Boolean(
    sessVals || refVals || dims.includes('session') || dims.includes('ref'),
  )
  const hourFilter = okVals ? 'ok' : sessVals ? 'session' : refVals ? 'ref' : null

  // Sessions mode: a ledger row (one per session, ref, source, account, instance, model, ...) whose
  // whole span lies inside the window comes from usage_session; the raw rows of the rows the window
  // cuts through, and of any session with calls newer than the last rollup, are counted instead.
  const inSessions = sessionLike && !okVals && !withHour
  const sessWhere = sessionWhere(filter)
  const inside: Where = {
    sql: `${sessWhere.sql}${dim.sql} and first_ts >= ? and last_ts <= ?`,
    args: [...sessWhere.args, ...dim.args, win.from, win.to],
  }
  // What to AND onto a raw read: one scope per statement (a sessions-mode read is one per ledger key,
  // each an index seek, never a scan of the window's raw rows).
  let scopes: Where[] = [{ sql: '', args: [] }]
  // Ledger rows the window cuts through, as [first_ts, scope], and the sessions to leave out of the ledger.
  let cutFirst: number[] = []
  let ledger: Where = inside
  const unsettled: { s: string; r: string }[] = []
  const tailLedger: RawRow[] = []
  const tailBefore: RawRow[] = []
  if (inSessions) {
    // Calls ingested since the last rollup are not in the ledger yet: every pair with a raw row at or
    // after the first stale hour is counted from its raw rows, whole. Past MAX_PAIR_SEEKS pairs (a bulk
    // re-read is running) the ledger is served as it stands, so a load does not scan the store.
    const dirtyFrom = store.dirtyFrom()
    if (dirtyFrom !== null) {
      // Bounded by rows, not pairs: DISTINCT alone reads on until it has found enough pairs.
      const rows = db
        .query(
          `select coalesce(session, '') as s, coalesce(ref, '') as r from usage_event indexed by usage_event_ts where ts >= ? limit ${MAX_FRESH_ROWS + 1}`,
        )
        .all(hourStart(dirtyFrom)) as { s: string; r: string }[]
      const fresh = [...new Map(rows.map((x) => [`${x.s}${x.r}`, x])).values()]
      if (rows.length > MAX_FRESH_ROWS || fresh.length > MAX_PAIR_SEEKS) {
        notes.push('sessions are behind: the store is re-reading old transcripts')
      } else unsettled.push(...fresh)
    }
    const unsettledKeys = new Set(unsettled.map((x) => `${x.s}${x.r}`))
    const cut = (
      db
        .query(
          `select ${KIT_SESSION_KEY.join(', ')}, first_ts, last_ts from usage_session
          where ${sessWhere.sql}${dim.sql} and +first_ts <= ? and last_ts >= ? and (first_ts < ? or last_ts > ?)`,
        )
        .all(...sessWhere.args, ...dim.args, win.to, win.from, win.from, win.to) as Record<
        string,
        string | number
      >[]
    ).filter((r) => !unsettledKeys.has(`${r.session}${r.ref}`))
    if (unsettled.length) {
      ledger = {
        sql: `${inside.sql} and session || char(31) || ref not in (${unsettled.map(() => '?').join(',')})`,
        args: [...inside.args, ...unsettled.map((x) => `${x.s}${x.r}`)],
      }
    }
    cutFirst = cut.map((r) => r.first_ts as number)
    const keyScope = (r: Record<string, string | number>): Where => ({
      sql: ` and ${KIT_SESSION_KEY.map((k) => `coalesce(${k}, '') = ?`).join(' and ')}`,
      args: KIT_SESSION_KEY.map((k) => r[k] as string),
    })
    // A row that began shortly before the window is its ledger row less the few calls before it (a
    // seek on the key and a ts range), not a read of all its calls inside the window.
    const direct: typeof cut = []
    for (const r of cut) {
      const first = r.first_ts as number
      const last = r.last_ts as number
      if (
        first >= cutoff &&
        first < win.from &&
        last <= win.to &&
        win.from - first < last - win.from
      ) {
        const key = keyScope(r)
        tailLedger.push(
          ...selectRows(
            db,
            'usage_session',
            dims,
            false,
            {
              sql: `${KIT_SESSION_KEY.map((k) => `${k} = ?`).join(' and ')}`,
              args: key.args,
            },
            HOUR_MS,
            dims.includes('model'),
          ),
        )
        tailBefore.push(
          ...selectRows(db, 'usage_event', dims, false, {
            sql: `ts >= ? and ts < ?${key.sql}`,
            args: [first, win.from, ...key.args],
          }).map(negated),
        )
      } else direct.push(r)
    }
    scopes = [
      ...unsettled.map((x) => ({
        sql: " and coalesce(session, '') = ? and coalesce(ref, '') = ?",
        args: [x.s, x.r],
      })),
      ...direct.map(keyScope),
    ]
    if (scopes.length > MAX_PAIR_SEEKS) {
      scopes = scopes.slice(0, MAX_PAIR_SEEKS)
      notes.push('very many sessions touch the window edge: the oldest are left out')
    }
  }

  // Time ranges answered from raw rows and from whole hours of the rollup. Raw rows older than the
  // cutoff are gone, so those hours always come from the rollup; newer hours come from the rollup
  // too once it is current (below the first stale hour) so a long window scans no raw rows except
  // its partial edge hours. Filters the rollup lacks keep to raw rows.
  const rawFrom = Math.max(win.from, cutoff)
  const rawRanges: Range[] = rawFrom <= win.to ? [[rawFrom, win.to]] : []
  const rollRanges: Range[] = []
  if (!inSessions && !hourFilter) {
    const rollTo = Math.min(cutoff - 1, win.to)
    if (win.from < cutoff && hourStart(win.from) <= rollTo) {
      rollRanges.push([hourStart(win.from), rollTo])
    }
    if (!sessionLike) {
      const dirty = store.dirtyFrom()
      const lo = hourCeil(rawFrom)
      const hi = Math.min(
        hourStart(win.to + 1),
        dirty === null ? Number.POSITIVE_INFINITY : hourStart(dirty),
      )
      if (rawFrom <= win.to && lo < hi) {
        rawRanges.length = 0
        if (rawFrom < lo) rawRanges.push([rawFrom, lo - 1])
        if (hi <= win.to) rawRanges.push([hi, win.to])
        rollRanges.push([lo, hi - 1])
      }
    }
  }
  const rawRows = tailBefore.concat(
    rawRanges.flatMap(([from, to]) =>
      scopes.flatMap((scope) =>
        selectRows(
          db,
          'usage_event',
          dims,
          withHour,
          {
            sql: `ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)}${scope.sql}`,
            args: [from, to, ...dim.args, ...rawExtraArgs(filter), ...scope.args],
          },
          dayBucket,
        ),
      ),
    ),
  )

  let rollRows: RawRow[] = []
  let ledgerUnpriced: string[] | null = null
  if (inSessions) {
    rollRows = [
      ...selectRows(db, 'usage_session', dims, false, ledger, HOUR_MS, dims.includes('model')),
      ...tailLedger,
    ]
    if (dims.includes('model')) {
      ledgerUnpriced = [
        ...new Set(
          rollRows
            .filter((r) => Number((r as Record<string, unknown>).unpriced_calls) > 0)
            .map((r) => r.model as string),
        ),
      ]
    }
    // Sessions the window cuts through, reaching back past the raw cut: their older part is in
    // usage_hour, which cannot attribute it.
    if (win.from < cutoff && cutFirst.some((f) => f < cutoff)) {
      notes.push(
        `sessions the window does not cover whole count only their usage since ${new Date(cutoff).toISOString()}`,
      )
    }
  } else {
    if (hourFilter) {
      if (win.from < cutoff && hourStart(win.from) <= Math.min(cutoff - 1, win.to)) {
        notes.push(
          `${hourFilter} filter cannot be applied to hourly rollups: usage before ${new Date(cutoff).toISOString()} is not included`,
        )
      }
    } else {
      rollRows = rollRanges.flatMap(([from, to]) =>
        selectRows(db, 'usage_hour', dims, withHour, {
          sql: `hour >= ? and hour <= ?${dim.sql}`,
          args: [from, to, ...dim.args],
        }),
      )
      if (sessionLike && win.from < cutoff && hourStart(win.from) <= Math.min(cutoff - 1, win.to)) {
        notes.push(
          'usage before the raw retention line has no session or ref: it groups under null',
        )
      }
    }
  }

  if (
    wantDay &&
    !wantHour &&
    rollRows.length > 0 &&
    params.tz &&
    !wholeHourZone(params.tz, win.to)
  ) {
    notes.push(
      'days from the hourly rollup are cut on whole UTC hours: in a zone offset by a part of an hour the first minutes of a local day can fall on the day before',
    )
  }

  // merge both ranges onto the requested keys
  const merged = new Map<string, UsageRow>()
  for (const r of [...rawRows, ...rollRows]) {
    const key: UsageRow = {}
    for (const g of groupBy) {
      if (g === 'day') key.day = dayOf(r.h as number, params.tz)
      else if (g === 'hour') key.hour = new Date(r.h as number).toISOString()
      else key[g] = r[g] as string | null
    }
    const id = JSON.stringify(key)
    const cur = merged.get(id)
    if (!cur) {
      merged.set(id, { ...key, ...pick(r) })
    } else {
      cur.tokens = (cur.tokens as number) + r.tokens
      for (const k of TOKEN_KIND_MEASURES) cur[k] = (cur[k] as number) + r[k]
      cur.list_usd = addNullable(cur.list_usd as number | null, r.list_usd)
      cur.billed_usd = addNullable(cur.billed_usd as number | null, r.billed_usd)
      cur.unbilled_usd = (cur.unbilled_usd as number) + r.unbilled_usd
      cur.cost_usd = (cur.cost_usd as number) + r.cost_usd
      cur.weighted = (cur.weighted as number) + r.weighted
      cur.calls = (cur.calls as number) + r.calls
      cur.ok = (cur.ok as number) + r.ok
      cur.failed = (cur.failed as number) + r.failed
      cur.seconds = addNullable(cur.seconds as number | null, r.seconds)
    }
  }
  if (groupBy.length === 0 && merged.size === 0) merged.set('{}', pick(emptyRow()))

  const keep = new Set<string>([...groupBy, ...measures])
  const rows = [...merged.values()]
    .sort(compareRows(groupBy))
    .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))))
  const totals: UsageResult['totals'] = {}
  for (const m of measures) {
    let t: number | null = null
    for (const r of merged.values()) t = addNullable(t, r[m] as number | null)
    totals[m] = t ?? (m === 'list_usd' || m === 'billed_usd' || m === 'seconds' ? null : 0)
  }

  return {
    rows,
    totals,
    unpriced: unpricedModels(
      db,
      rawRanges,
      rollRanges,
      dim,
      filter,
      inSessions ? ledger : null,
      scopes,
      ledgerUnpriced,
    ),
    priceVer: store.getMeta('price_ver'),
    coverage:
      opts.coverage === false
        ? { sources: {}, cursors: { files: 0, newestMtime: null }, dirtyFrom: null }
        : coverage(store),
    window: win,
    notes,
  }
}

/** True when the zone's UTC offset at `ts` is a whole number of hours. */
function wholeHourZone(tz: string, ts: number): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(hourStart(ts))
  return Number(parts.find((p) => p.type === 'minute')?.value ?? 0) === 0
}

type Range = [from: number, to: number]
const hourCeil = (ts: number): number => hourStart(ts + HOUR_MS - 1)
const hourStart = (ts: number): number => ts - (((ts % HOUR_MS) + HOUR_MS) % HOUR_MS)

/** Raw-only filters: usage_event has the columns the rollup lacks (session, ok). Session and ref are
 *  written as the expression usage_event_session indexes, or SQLite scans every raw row in the window. */
function rawExtra(filter: NonNullable<UsageQueryParams['filter']>): string {
  const parts: string[] = []
  const sess = toList(filter.session)
  if (sess)
    parts.push(sess.length ? `coalesce(session, '') in (${sess.map(() => '?').join(',')})` : '0')
  const ref = toList(filter.ref)
  if (ref) parts.push(ref.length ? `coalesce(ref, '') in (${ref.map(() => '?').join(',')})` : '0')
  const ok = toList(filter.ok)
  if (ok) parts.push(ok.length ? `ok in (${ok.map(() => '?').join(',')})` : '0')
  return parts.length ? ` and ${parts.join(' and ')}` : ''
}
function rawExtraArgs(filter: NonNullable<UsageQueryParams['filter']>): (string | number)[] {
  return [
    ...(toList(filter.session) ?? []),
    ...(toList(filter.ref) ?? []),
    ...(toList(filter.ok) ?? []).map((v) => (v ? 1 : 0)),
  ]
}

/** The session / ref filters as usage_session sees them (its columns are never null). */
function sessionWhere(filter: NonNullable<UsageQueryParams['filter']>): Where {
  const parts: string[] = []
  const args: string[] = []
  for (const k of ['session', 'ref'] as const) {
    const vals = toList(filter[k])
    if (!vals) continue
    parts.push(vals.length ? `${k} in (${vals.map(() => '?').join(',')})` : '0')
    args.push(...vals)
  }
  return { sql: parts.length ? parts.join(' and ') : '1', args }
}

const emptyRow = (): RawRow => ({
  h: null,
  tokens: 0,
  list_usd: null,
  billed_usd: null,
  unbilled_usd: 0,
  cost_usd: 0,
  weighted: 0,
  calls: 0,
  ok: 0,
  failed: 0,
  seconds: null,
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
})

const pick = (r: RawRow): UsageRow => ({
  input: r.input,
  output: r.output,
  cache_read: r.cache_read,
  cache_write: r.cache_write,
  tokens: r.tokens ?? 0,
  list_usd: r.list_usd,
  billed_usd: r.billed_usd,
  unbilled_usd: r.unbilled_usd ?? 0,
  cost_usd: r.cost_usd ?? 0,
  weighted: r.weighted ?? 0,
  calls: r.calls ?? 0,
  ok: r.ok ?? 0,
  failed: r.failed ?? 0,
  seconds: r.seconds,
})

function compareRows(groupBy: GroupBy[]) {
  return (a: UsageRow, b: UsageRow): number => {
    for (const g of groupBy) {
      const x = a[g]
      const y = b[g]
      if (x === y) continue
      if (x === null) return 1
      if (y === null) return -1
      return x < y ? -1 : 1
    }
    return 0
  }
}

function unpricedModels(
  db: Database,
  rawRanges: Range[],
  rollRanges: Range[],
  dim: Where,
  filter: NonNullable<UsageQueryParams['filter']>,
  ledger: Where | null,
  scopes: Where[],
  ledgerUnpriced: string[] | null,
): string[] {
  const out = new Set<string>()
  for (const [from, to] of rawRanges) {
    for (const scope of scopes) {
      const rows = db
        .query(
          `select distinct model from usage_event where ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)}${scope.sql} and list_usd is null and model is not null`,
        )
        .all(from, to, ...dim.args, ...rawExtraArgs(filter), ...scope.args) as { model: string }[]
      for (const r of rows) out.add(r.model)
    }
  }
  if (ledger && ledgerUnpriced) return [...new Set([...out, ...ledgerUnpriced])].sort()
  if (ledger) {
    const rows = db
      .query(
        `select distinct model from usage_session where ${ledger.sql} and list_usd is null and model != ''`,
      )
      .all(...ledger.args) as { model: string }[]
    for (const r of rows) out.add(r.model)
    return [...out].sort()
  }
  for (const [from, to] of rollRanges) {
    const rows = db
      .query(
        `select distinct model from usage_hour where hour >= ? and hour <= ?${dim.sql} and list_usd is null and model != ''`,
      )
      .all(from, to, ...dim.args) as { model: string }[]
    for (const r of rows) out.add(r.model)
  }
  return [...out].sort()
}

// Coverage is kept until the store changes: total_changes() moves on a write through this connection,
// data_version on one through another. It never scans every raw row (1.6 s on 1.6M rows, measured
// 2026-10-04): counts are the rollup's below the first stale hour plus a raw count from there.
const coverageCache = new WeakMap<KitStore, { key: string; value: UsageResult['coverage'] }>()
/** A first stale hour older than this is a bulk re-read: the last coverage is served until it ends. */
const STALE_EXACT_MS = 48 * HOUR_MS
/** Most (session, ref) pairs read from raw rows by one seek each before one scan of the window does it. */
const MAX_PAIR_SEEKS = 3000
/** Most raw rows read to find the sessions with calls newer than the last rollup. */
const MAX_FRESH_ROWS = 30_000

function coverage(store: KitStore): UsageResult['coverage'] {
  const t = store.db.query('select total_changes() as t').get() as { t: number }
  const v = store.db.query('pragma data_version').get() as { data_version: number }
  const key = `${v.data_version}:${t.t}`
  const hit = coverageCache.get(store)
  if (hit && hit.key === key) return hit.value
  const dirty = store.dirtyFrom()
  if (hit && dirty !== null && Date.now() - dirty > STALE_EXACT_MS) return hit.value
  const value = scanCoverage(store)
  coverageCache.set(store, { key, value })
  return value
}

function scanCoverage(store: KitStore): UsageResult['coverage'] {
  const sources: UsageResult['coverage']['sources'] = {}
  const dirty = store.dirtyFrom()
  const dirtyHour = dirty === null ? null : hourStart(dirty)
  const counts = new Map<string, number>()
  // Raw counts are the rollup's calls from the raw cut to the first stale hour, plus the raw rows from
  // there (an index range); each source's first and last raw ts is one index seek.
  const rolled = store.db
    .query(
      `select source, sum(calls) as n from usage_hour where hour >= ?${dirtyHour === null ? '' : ' and hour < ?'} group by source`,
    )
    .all(...(dirtyHour === null ? [store.rawCut() ?? 0] : [store.rawCut() ?? 0, dirtyHour])) as {
    source: string
    n: number
  }[]
  for (const r of rolled) counts.set(r.source, r.n)
  if (dirtyHour !== null) {
    const fresh = store.db
      .query('select source, count(*) as n from usage_event where ts >= ? group by source')
      .all(dirtyHour) as { source: string; n: number }[]
    for (const r of fresh) counts.set(r.source, (counts.get(r.source) ?? 0) + r.n)
  }
  // Sources that only survive in the rollup (their raw rows aged out), and each source's hourly edges.
  const hourly = store.db
    .query(
      'select source, sum(calls) as n, min(hour) as a, max(hour) as b from usage_hour group by source',
    )
    .all() as { source: string; n: number; a: number; b: number }[]
  const edges = new Map(hourly.map((r) => [r.source, r]))
  // The (source, ts) index is built off the main thread after an upgrade (ensureIndexes): until it
  // exists a min or max over a source is a scan of every raw row (12 s measured), so the rollup's hour
  // edges stand in, with the newest raw rows (ts index, from the first stale hour) for the last call.
  const indexed = store.db
    .query(
      "select 1 as x from sqlite_master where type = 'index' and name = 'usage_event_source_ts'",
    )
    .get()
  const newestRaw = (source: string): number | null =>
    (
      store.db
        .query('select max(ts) as t from usage_event where ts >= ? and source = ?')
        .get(dirtyHour ?? Number.MAX_SAFE_INTEGER, source) as { t: number | null }
    ).t
  for (const [source, n] of counts) {
    if (n <= 0) continue
    // SQLite seeks an index for one min or max per statement, not for both together.
    const edge = (fn: 'min' | 'max') =>
      (
        store.db.query(`select ${fn}(ts) as t from usage_event where source = ?`).get(source) as {
          t: number
        }
      ).t
    const h = edges.get(source)
    if (indexed) sources[source] = { events: n, firstTs: edge('min'), lastTs: edge('max') }
    else {
      const last = Math.max(newestRaw(source) ?? 0, h ? h.b + HOUR_MS - 1 : 0)
      sources[source] = { events: n, firstTs: h?.a ?? last, lastTs: last }
    }
  }
  for (const r of hourly) {
    const cur = sources[r.source]
    if (!cur) sources[r.source] = { events: r.n, firstTs: r.a, lastTs: r.b + HOUR_MS - 1 }
    else cur.firstTs = Math.min(cur.firstTs, r.a)
  }
  const cur = store.db.query('select count(*) as n, max(mtime) as m from ingest_cursor').get() as {
    n: number
    m: number | null
  }
  return {
    sources,
    cursors: { files: cur.n, newestMtime: cur.m },
    dirtyFrom: store.dirtyFrom(),
  }
}
