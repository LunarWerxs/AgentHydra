// Analytics toolkit query API (docs/ANALYTICS-PLAN.md §4.4): the one function every usage reader asks.
// Inside the raw retention period it reads usage_event; older hours read the hourly rollup usage_hour.
// The two ranges are disjoint (cut at an hour boundary, the same one pruneRaw uses), so a window that
// straddles the line never counts a call twice.
// A query on a session or ref (filter or group) cannot use usage_hour, which has neither. It reads the
// per-session ledger usage_session for every (session, ref) the window covers whole, and raw rows (this
// side excluding those) for the rest, so no event is counted in both.
import type { Database } from 'bun:sqlite'
import { getCachedUsage } from '../usage-cache'
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
  basis: 'explicit' | 'last' | 'snapshot' | 'rolling'
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
 * snapshot predates the current window, so it cannot say where that window began: roll back `span`
 * from now instead, the same as with no snapshot.
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
    // `pc=self`: this machine's own events. The local ingest leaves pc empty (the rollup stores ''),
    // so "self" is the empty pc, alone or alongside named PCs.
    if (k === 'pc') {
      const named = vals.filter((v) => v !== 'self')
      const clause = named.length ? [`pc in (${named.map(() => '?').join(',')})`] : []
      if (named.length !== vals.length) clause.push("(pc is null or pc = '')")
      parts.push(`(${clause.join(' or ')})`)
      args.push(...named)
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
  const hourSel = withHour ? (raw ? `ts - (ts % ${HOUR_MS}) as h` : 'hour as h') : 'null as h'
  const group = [
    withHour ? 'h' : null,
    ...dims.filter((d) => !noSess || (d !== 'session' && d !== 'ref')).map((d) => DIM_COLS[d]),
  ]
    .filter(Boolean)
    .join(', ')
  const measures = raw
    ? `sum(${TOKEN_SUM}) as tokens, sum(list_usd) as list_usd, sum(billed_usd) as billed_usd,
       sum(weighted) as weighted, count(*) as calls, sum(case when ok = 1 then 1 else 0 end) as ok,
       sum(case when ok = 0 then 1 else 0 end) as failed, sum(seconds) as seconds`
    : `sum(${TOKEN_SUM}) as tokens, sum(list_usd) as list_usd, sum(billed_usd) as billed_usd,
       sum(weighted) as weighted, sum(calls) as calls, sum(ok_calls) as ok,
       sum(failed_calls) as failed, sum(seconds) as seconds`
  const kinds =
    'sum(input) as input, sum(output) as output, sum(cache_read) as cache_read, sum(cache_write_5m + cache_write_1h) as cache_write'
  const sql = `select ${[hourSel, ...dimSel].join(', ')}, ${measures}, ${kinds} from ${table} where ${where.sql}${group ? ` group by ${group}` : ''}`
  return db.query(sql).all(...where.args) as RawRow[]
}

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
    win.basis === 'snapshot' ? win.from : null,
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

  const cutoff = hourStart(now - RAW_RETENTION_DAYS * DAY_MS)
  const dim = dimWhere(filter)
  const okVals = toList(filter.ok)
  const sessVals = toList(filter.session)
  const refVals = toList(filter.ref)
  const sessionLike = Boolean(
    sessVals || refVals || dims.includes('session') || dims.includes('ref'),
  )
  const hourFilter = okVals ? 'ok' : sessVals ? 'session' : refVals ? 'ref' : null

  // Sessions mode: (session, ref) pairs wholly inside the window come from the ledger.
  const inSessions = sessionLike && !okVals && !withHour
  const sessWhere = sessionWhere(filter)
  // The (session, ref) pairs the window covers whole, as a subquery (no temp table: a query must not
  // write, or it moves the store generation and is never served from cache).
  let whole: Where | null = null
  if (inSessions) {
    whole = {
      sql: `select session, ref from usage_session where ${sessWhere.sql}${dim.sql} group by session, ref
            having min(first_ts) >= ? and max(last_ts) <= ?`,
      args: [...sessWhere.args, ...dim.args, win.from, win.to],
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
      const dirty = store.getMeta('dirty_from')
      const lo = hourCeil(rawFrom)
      const hi = Math.min(
        hourStart(win.to + 1),
        dirty === null ? Number.POSITIVE_INFINITY : hourStart(Number(dirty)),
      )
      if (rawFrom <= win.to && lo < hi) {
        rawRanges.length = 0
        if (rawFrom < lo) rawRanges.push([rawFrom, lo - 1])
        if (hi <= win.to) rawRanges.push([hi, win.to])
        rollRanges.push([lo, hi - 1])
      }
    }
  }
  const rawRows = rawRanges.flatMap(([from, to]) =>
    selectRows(db, 'usage_event', dims, withHour, {
      sql: `ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)}${whole ? ` and (coalesce(session, ''), coalesce(ref, '')) not in (${whole.sql})` : ''}`,
      args: [from, to, ...dim.args, ...rawExtraArgs(filter), ...(whole?.args ?? [])],
    }),
  )

  let rollRows: RawRow[] = []
  if (inSessions) {
    rollRows = selectRows(db, 'usage_session', dims, false, {
      sql: `${sessWhere.sql}${dim.sql} and (session, ref) in (${whole?.sql})`,
      args: [...sessWhere.args, ...dim.args, ...(whole?.args ?? [])],
    })
    // Sessions the window cuts through, reaching back past the raw cut: their older part is in
    // usage_hour, which cannot attribute it.
    if (win.from < cutoff) {
      const cut = db
        .query(
          `select 1 from usage_session where ${sessWhere.sql} and first_ts < ?
             and last_ts >= ? and (first_ts < ? or last_ts > ?)
             and (session, ref) not in (${whole?.sql}) limit 1`,
        )
        .get(...sessWhere.args, cutoff, win.from, win.from, win.to, ...(whole?.args ?? []))
      if (cut) {
        notes.push(
          `sessions the window does not cover whole count only their usage since ${new Date(cutoff).toISOString()}`,
        )
      }
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
      inSessions ? sessWhere : null,
      whole,
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
  sessions: Where | null,
  whole: Where | null,
): string[] {
  const out = new Set<string>()
  for (const [from, to] of rawRanges) {
    const rows = db
      .query(
        `select distinct model from usage_event where ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)} and list_usd is null and model is not null`,
      )
      .all(from, to, ...dim.args, ...rawExtraArgs(filter)) as { model: string }[]
    for (const r of rows) out.add(r.model)
  }
  if (sessions) {
    const rows = db
      .query(
        `select distinct model from usage_session where ${sessions.sql}${dim.sql} and list_usd is null and model != ''
           and (session, ref) in (${whole?.sql})`,
      )
      .all(...sessions.args, ...dim.args, ...(whole?.args ?? [])) as { model: string }[]
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

// Coverage scans every raw row (1.6 s on 1.6M rows, measured 2026-10-04), so it is kept until the store
// changes: total_changes() moves on a write through this connection, data_version on one through another.
const coverageCache = new WeakMap<KitStore, { key: string; value: UsageResult['coverage'] }>()

function coverage(store: KitStore): UsageResult['coverage'] {
  const t = store.db.query('select total_changes() as t').get() as { t: number }
  const v = store.db.query('pragma data_version').get() as { data_version: number }
  const key = `${v.data_version}:${t.t}`
  const hit = coverageCache.get(store)
  if (hit && hit.key === key) return hit.value
  const value = scanCoverage(store)
  coverageCache.set(store, { key, value })
  return value
}

function scanCoverage(store: KitStore): UsageResult['coverage'] {
  const sources: UsageResult['coverage']['sources'] = {}
  // With a current rollup the raw counts are the rollup's calls since the raw cut (a few thousand
  // rows) and each source's first and last raw ts one index seek; a stale rollup scans the raw rows.
  const stale = store.getMeta('dirty_from') !== null
  const raw = stale
    ? (store.db
        .query(
          'select source, count(*) as n, min(ts) as a, max(ts) as b from usage_event group by source',
        )
        .all() as { source: string; n: number; a: number; b: number }[])
    : (
        store.db
          .query(
            'select source, sum(calls) as n from usage_hour where hour >= ? group by source having sum(calls) > 0',
          )
          .all(store.rawCut() ?? 0) as { source: string; n: number }[]
      ).map((r) => {
        // SQLite seeks an index for one min or max per statement, not for both together.
        const edge = (fn: 'min' | 'max') =>
          (
            store.db
              .query(`select ${fn}(ts) as t from usage_event where source = ?`)
              .get(r.source) as { t: number }
          ).t
        const e = { a: edge('min'), b: edge('max') }
        return { ...r, ...e }
      })
  for (const r of raw) sources[r.source] = { events: r.n, firstTs: r.a, lastTs: r.b }
  // Sources that only survive in the rollup (their raw rows aged out).
  const hourly = store.db
    .query(
      'select source, sum(calls) as n, min(hour) as a, max(hour) as b from usage_hour group by source',
    )
    .all() as { source: string; n: number; a: number; b: number }[]
  for (const r of hourly) {
    const cur = sources[r.source]
    if (!cur) sources[r.source] = { events: r.n, firstTs: r.a, lastTs: r.b + HOUR_MS - 1 }
    else cur.firstTs = Math.min(cur.firstTs, r.a)
  }
  const cur = store.db.query('select count(*) as n, max(mtime) as m from ingest_cursor').get() as {
    n: number
    m: number | null
  }
  const dirty = store.getMeta('dirty_from')
  return {
    sources,
    cursors: { files: cur.n, newestMtime: cur.m },
    dirtyFrom: dirty === null ? null : Number(dirty),
  }
}
