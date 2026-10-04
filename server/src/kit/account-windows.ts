// Per-account token windows for the instance tables (docs/ANALYTICS-PLAN.md piece 9): what each
// account has run in its current 5-hour window, its current week and all time, read from the kit.
// Windows are cut by the one resolver in query.ts (the account's quota snapshot, else rolling). The
// each account's 5h, week and all-time sums are one statement each over all accounts (per-account
// starts in a VALUES CTE): whole hours from the hourly rollup, raw rows only for the partial start
// hour and the rollup's stale tail. The answer is reused until the store is written.
import type { Database } from 'bun:sqlite'
import type { AccountTokens, TokenParts } from '../types'
import {
  cachedQuota,
  resolveWindow,
  sharedKitStore,
  storeGeneration,
  type UsageQueryOpts,
} from './query'

const zero = (): TokenParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

const HOUR_MS = 3_600_000
const NEVER = 8.64e15

/**
 * Token sums per account from each account's own start to now, in one statement: whole hours from
 * the hourly rollup (every hour below the first stale one), raw rows only for the partial hour at
 * the start and for the stale tail. `starts` maps account to start; 0 reads all time.
 */
function windowSums(
  db: Database,
  split: number,
  starts: Map<string, number>,
): Map<string, TokenParts> {
  const rows = [...starts].map(([id, from]) => [id, from, Math.ceil(from / HOUR_MS) * HOUR_MS])
  const sql = `with w(account, f, fc) as (values ${rows.map(() => '(?, ?, ?)').join(', ')})
    select account, sum(input) as input, sum(output) as output, sum(cache_read) as cache_read,
      sum(cache_write) as cache_write from (
        select h.account, h.input, h.output, h.cache_read, h.cache_write_5m + h.cache_write_1h as cache_write
          from w join usage_hour h on h.account = w.account and h.hour >= w.fc and h.hour < ?
        union all
        select e.account, e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
          from w join usage_event e on e.account = w.account and e.ts >= w.f and e.ts < w.fc
        union all
        select e.account, e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
          from w join usage_event e on e.account = w.account and e.ts >= max(w.fc, ?)
      ) group by account`
  const res = db.query(sql).all(...rows.flat(), split, split) as Record<string, string | number>[]
  const out = new Map<string, TokenParts>()
  for (const r of res) {
    const input = Number(r.input)
    const output = Number(r.output)
    const cacheRead = Number(r.cache_read)
    const cacheWrite = Number(r.cache_write)
    out.set(String(r.account), {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    })
  }
  return out
}

const cache = new WeakMap<Database, { key: string; value: Map<string, AccountTokens> }>()

/** `accounts` are kit account ids (`acct-…`). An account with no events reads as zeros. */
export function accountTokenWindows(
  accounts: string[],
  opts: UsageQueryOpts = {},
): Map<string, AccountTokens> {
  const ids = [...new Set(accounts)]
  const out = new Map<string, AccountTokens>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { fiveHour: zero(), week: zero(), total: zero() })
  const store = opts.store ?? sharedKitStore()
  const db = store.db
  const now = opts.now ?? Date.now()
  const quota = opts.quota ?? cachedQuota(db)
  const dirty = store.getMeta('dirty_from')
  const split = dirty === null ? NEVER : Math.floor(Number(dirty) / HOUR_MS) * HOUR_MS

  const from = (kind: '5h' | 'week') =>
    new Map(ids.map((id) => [id, resolveWindow({ account: id, kind }, now, quota).from]))
  const fiveFrom = from('5h')
  const weekFrom = from('week')
  // Rolling starts move with the clock: a minute's drift reads the same answer.
  const key = JSON.stringify([
    storeGeneration(db),
    ids.map((id) => [
      id,
      Math.floor((fiveFrom.get(id) ?? 0) / 60_000),
      Math.floor((weekFrom.get(id) ?? 0) / 60_000),
    ]),
  ])
  const hit = cache.get(db)
  if (hit?.key === key) return structuredClone(hit.value)
  const five = windowSums(db, split, fiveFrom)
  const week = windowSums(db, split, weekFrom)
  const all = windowSums(db, split, new Map(ids.map((id) => [id, 0])))
  for (const [id, t] of out) {
    t.fiveHour = five.get(id) ?? zero()
    t.week = week.get(id) ?? zero()
    t.total = all.get(id) ?? zero()
  }
  if (storeGeneration(db) === JSON.parse(key)[0])
    cache.set(db, { key, value: structuredClone(out) })
  return out
}
