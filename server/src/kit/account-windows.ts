// Per-account token windows for the instance tables (docs/ANALYTICS-PLAN.md piece 9): what each
// account has run in its current 5-hour window, its current week and all time, read from the kit.
// Windows are cut by the one resolver in query.ts (the account's quota snapshot, else rolling). Each
// account's 5h, week and all-time sums are one statement each: whole hours from the hourly rollup, raw
// rows only for the partial start hour and the newest two hours (KitStore.readSplit). The answer is
// reused until the store is written.
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
 * Token sums per account from each account's own start to now: whole hours from the hourly rollup
 * (every hour below the first stale one), raw rows only for the partial hour at the start and for the
 * stale tail. Other PCs' imported hours (kit/sync.ts) have no raw rows here, so their stale-tail hours are
 * read from the rollup too. `starts` maps account to start; 0 reads all time. One statement per account
 * (an all-time sum over every hour of one account is tens of milliseconds, over all of them a few
 * hundred), and a step of the event loop between them when the caller is async.
 */
function* windowSums(
  db: Database,
  split: number,
  starts: Map<string, number>,
): Generator<void, Map<string, TokenParts>, void> {
  const sql = `select sum(input) as input, sum(output) as output, sum(cache_read) as cache_read,
      sum(cache_write) as cache_write from (
        select h.input, h.output, h.cache_read, h.cache_write_5m + h.cache_write_1h as cache_write
          from usage_hour h where h.account = $id and h.hour >= $fc and h.hour < $split
        union all
        select e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
          from usage_event e where e.account = $id and e.ts >= $f and e.ts < $fc
        union all
        select e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
          from usage_event e where e.account = $id and e.ts >= max($fc, $split)
        union all
        select h.input, h.output, h.cache_read, h.cache_write_5m + h.cache_write_1h
          from usage_hour h where h.account = $id and h.hour >= max($fc, $split)
            and h.pc in (select pc from imported_pc)
      )`
  const stmt = db.query(sql)
  const out = new Map<string, TokenParts>()
  for (const [id, from] of starts) {
    const r = stmt.get({
      $id: id,
      $f: from,
      $fc: Math.ceil(from / HOUR_MS) * HOUR_MS,
      $split: split,
    }) as Record<string, string | number | null>
    yield
    if (r.input === null) continue
    const input = Number(r.input)
    const output = Number(r.output)
    const cacheRead = Number(r.cache_read)
    const cacheWrite = Number(r.cache_write)
    out.set(id, {
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

function* tokenWindowSteps(
  accounts: string[],
  opts: UsageQueryOpts,
): Generator<void, Map<string, AccountTokens>, void> {
  const ids = [...new Set(accounts)]
  const out = new Map<string, AccountTokens>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { fiveHour: zero(), week: zero(), total: zero() })
  const store = opts.store ?? sharedKitStore()
  const db = store.db
  const now = opts.now ?? Date.now()
  const quota = opts.quota ?? cachedQuota(db)
  const split = Math.min(store.readSplit(now), NEVER)

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
  const five = yield* windowSums(db, split, fiveFrom)
  const week = yield* windowSums(db, split, weekFrom)
  const all = yield* windowSums(db, split, new Map(ids.map((id) => [id, 0])))
  for (const [id, t] of out) {
    t.fiveHour = five.get(id) ?? zero()
    t.week = week.get(id) ?? zero()
    t.total = all.get(id) ?? zero()
  }
  if (storeGeneration(db) === JSON.parse(key)[0])
    cache.set(db, { key, value: structuredClone(out) })
  return out
}

/** `accounts` are kit account ids (`acct-…`). An account with no events reads as zeros. */
export function accountTokenWindows(
  accounts: string[],
  opts: UsageQueryOpts = {},
): Map<string, AccountTokens> {
  const steps = tokenWindowSteps(accounts, opts)
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value
}

/** The same answer with a turn of the event loop between the per-account statements. */
export async function accountTokenWindowsAsync(
  accounts: string[],
  opts: UsageQueryOpts = {},
): Promise<Map<string, AccountTokens>> {
  const steps = tokenWindowSteps(accounts, opts)
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
