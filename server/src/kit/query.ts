// Analytics toolkit query API (docs/ANALYTICS-PLAN.md §4.4): the one function every usage reader asks.
// Inside the raw retention period it reads usage_event; older hours read the hourly rollup usage_hour.
// The two ranges are disjoint (cut at an hour boundary, the same one pruneRaw uses), so a window that
// straddles the line never counts a call twice.
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
  table: 'usage_event' | 'usage_hour',
  dims: DimCol[],
  withHour: boolean,
  where: Where,
): RawRow[] {
  const raw = table === 'usage_event'
  const dimSel = dims.map((d) => {
    if (raw) return DIM_COLS[d]
    // The rollup keeps no session and stores NULL as ''.
    return d === 'session' ? `null as session` : `nullif(${DIM_COLS[d]}, '') as ${d}`
  })
  const hourSel = withHour ? (raw ? `ts - (ts % ${HOUR_MS}) as h` : 'hour as h') : 'null as h'
  const group = [
    withHour ? 'h' : null,
    ...dims.filter((d) => raw || d !== 'session').map((d) => DIM_COLS[d]),
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

export function usageQuery(params: UsageQueryParams = {}, opts: UsageQueryOpts = {}): UsageResult {
  const store = opts.store ?? sharedKitStore()
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

  // raw range: [max(from, cutoff), to]
  const rawFrom = Math.max(win.from, cutoff)
  const rawRows =
    rawFrom <= win.to
      ? selectRows(db, 'usage_event', dims, withHour, {
          sql: `ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)}`,
          args: [rawFrom, win.to, ...dim.args, ...rawExtraArgs(filter)],
        })
      : []

  // rollup range: whole hours below the cutoff that overlap the window
  let rollRows: RawRow[] = []
  const rollFrom = hourStart(win.from)
  const rollTo = Math.min(cutoff - 1, win.to)
  if (win.from < cutoff && rollFrom <= rollTo) {
    if (okVals || sessVals) {
      notes.push(
        `${okVals ? 'ok' : 'session'} filter cannot be applied to hourly rollups: usage before ${new Date(cutoff).toISOString()} is not included`,
      )
    } else {
      rollRows = selectRows(db, 'usage_hour', dims, withHour, {
        sql: `hour >= ? and hour <= ?${dim.sql}`,
        args: [rollFrom, rollTo, ...dim.args],
      })
      if (dims.includes('session')) {
        notes.push('usage before the raw retention line has no session: it groups under null')
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
    unpriced: unpricedModels(db, win, cutoff, dim, filter, !okVals && !sessVals),
    priceVer: store.getMeta('price_ver'),
    coverage: coverage(store),
    window: win,
    notes,
  }
}

const hourStart = (ts: number): number => ts - (((ts % HOUR_MS) + HOUR_MS) % HOUR_MS)

/** Raw-only filters: usage_event has the columns the rollup lacks (session, ok). */
function rawExtra(filter: NonNullable<UsageQueryParams['filter']>): string {
  const parts: string[] = []
  const sess = toList(filter.session)
  if (sess) parts.push(sess.length ? `session in (${sess.map(() => '?').join(',')})` : '0')
  const ok = toList(filter.ok)
  if (ok) parts.push(ok.length ? `ok in (${ok.map(() => '?').join(',')})` : '0')
  return parts.length ? ` and ${parts.join(' and ')}` : ''
}
function rawExtraArgs(filter: NonNullable<UsageQueryParams['filter']>): (string | number)[] {
  return [...(toList(filter.session) ?? []), ...(toList(filter.ok) ?? []).map((v) => (v ? 1 : 0))]
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
  win: ResolvedWindow,
  cutoff: number,
  dim: Where,
  filter: NonNullable<UsageQueryParams['filter']>,
  withRollup: boolean,
): string[] {
  const out = new Set<string>()
  const rawFrom = Math.max(win.from, cutoff)
  if (rawFrom <= win.to) {
    const rows = db
      .query(
        `select distinct model from usage_event where ts >= ? and ts <= ?${dim.sql}${rawExtra(filter)} and list_usd is null and model is not null`,
      )
      .all(rawFrom, win.to, ...dim.args, ...rawExtraArgs(filter)) as { model: string }[]
    for (const r of rows) out.add(r.model)
  }
  const rollTo = Math.min(cutoff - 1, win.to)
  if (withRollup && win.from < cutoff && hourStart(win.from) <= rollTo) {
    const rows = db
      .query(
        `select distinct model from usage_hour where hour >= ? and hour <= ?${dim.sql} and list_usd is null and model != ''`,
      )
      .all(hourStart(win.from), rollTo, ...dim.args) as { model: string }[]
    for (const r of rows) out.add(r.model)
  }
  return [...out].sort()
}

function coverage(store: KitStore): UsageResult['coverage'] {
  const sources: UsageResult['coverage']['sources'] = {}
  const raw = store.db
    .query(
      'select source, count(*) as n, min(ts) as a, max(ts) as b from usage_event group by source',
    )
    .all() as { source: string; n: number; a: number; b: number }[]
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
