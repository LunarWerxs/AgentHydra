// What an account's Claude config dirs spent, read from the kit (docs/ANALYTICS-PLAN.md piece 14):
// the quota budget's window sum and the dollar calibration's per-turn rows, in place of a walk over
// transcript files. A config dir is the kit's `instance`: a CLI instance's own dir is `cli:<id>`, and
// the plain default login's dir is shared with desktop chats, so it is every instance that is not a
// CLI instance's (`default` and `desktop:*`).
import { resolve } from 'node:path'
import { listCliInstances } from '../core/cli-instances'
import type { TokenSpend } from '../types'
import { defaultConfigDir, emptySpend } from '../usage-tokens'
import { sharedKitStore, type UsageQueryOpts, usageQuery } from './query'

const sameDir = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** The kit instances whose calls ran under these config dirs, among those seen since `sinceMs`. */
export function instancesForConfigDirs(
  configDirs: string[],
  sinceMs: number,
  opts: UsageQueryOpts = {},
): string[] {
  const out = new Set<string>()
  const clis = listCliInstances()
  let wantShared = false
  for (const dir of configDirs) {
    const cli = clis.find((i) => sameDir(i.configDir, dir))
    if (cli) out.add(`cli:${cli.id}`)
    else if (sameDir(dir, defaultConfigDir())) wantShared = true
  }
  if (wantShared) {
    // Hop through the (instance, ts) index one instance at a time: a `select distinct` would scan every row.
    const db = (opts.store ?? sharedKitStore()).db
    const next = db.query('select min(instance) as i from usage_event where instance > ?')
    // No source filter here (it would scan a whole non-Claude instance); the later reads filter by source.
    const last = db.query('select max(ts) as t from usage_event where instance = ?')
    let prev = ''
    for (;;) {
      const i = (next.get(prev) as { i: string | null }).i
      if (i === null) break
      prev = i
      if (i.startsWith('cli:')) continue
      const t = (last.get(i) as { t: number | null }).t
      if (t !== null && t >= sinceMs) out.add(i)
    }
  }
  return [...out]
}

/** Total spend since `since` across the config dirs, as the budget reads it: one kit query. */
export function spendSince(
  since: Date,
  configDirs: string[],
  opts: UsageQueryOpts = {},
): TokenSpend {
  const spend = emptySpend()
  const sinceMs = since.getTime()
  const instance = instancesForConfigDirs(configDirs, sinceMs, opts)
  if (instance.length === 0) return spend
  const now = opts.now ?? Date.now()
  const res = usageQuery(
    {
      window: { from: sinceMs, to: now },
      filter: { instance, source: ['cli', 'desktop'] },
      groupBy: ['model'],
      measures: ['input', 'output', 'cache_read', 'cache_write', 'weighted', 'calls'],
    },
    { ...opts, now },
  )
  for (const r of res.rows) {
    const input = Number(r.input)
    const output = Number(r.output)
    const cacheRead = Number(r.cache_read)
    const cacheWrite = Number(r.cache_write)
    const weighted = Number(r.weighted)
    const turns = Number(r.calls)
    spend.input += input
    spend.output += output
    spend.cacheRead += cacheRead
    spend.cacheCreation += cacheWrite
    spend.raw += input + output + cacheRead + cacheWrite
    spend.weighted += weighted
    spend.turns += turns
    // The query cannot split writes by TTL, so the whole write reads as 5-minute here.
    spend.byModel[String(r.model ?? 'unknown')] = {
      weighted,
      output,
      turns,
      input,
      cacheRead,
      cacheCreation5m: cacheWrite,
      cacheCreation1h: 0,
    }
  }
  return spend
}

const HOUR = 3_600_000
type CallRow = [number, string | null, number, number, number, number, number, number, number]

/**
 * The calls since `since` under the config dirs, summed per model: per minute for the last one to two hours and
 * the first partial hour, per hour (stamped at its middle) in between. The calibration prices intervals
 * between quota readings, and a 7-day window of raw calls is too many rows to hand to JS one by one.
 * `ts` is the group's time.
 */
export function forEachCallSince(
  since: Date,
  configDirs: string[],
  visit: (ts: number, byModel: TokenSpend['byModel']) => void,
  opts: UsageQueryOpts = {},
): void {
  const sinceMs = since.getTime()
  const instance = instancesForConfigDirs(configDirs, sinceMs, opts)
  if (instance.length === 0) return
  const marks = instance.map(() => '?').join(',')
  const store = opts.store ?? sharedKitStore()
  const db = store.db
  const now = opts.now ?? Date.now()
  // Whole hours from the rollup: from the first hour boundary after `since` up to the hour before the last full one.
  const hourFrom = Math.ceil(sinceMs / HOUR) * HOUR
  // ...and never past the first hour whose rollup may be stale.
  const dirty = store.getMeta('dirty_from')
  const hourTo = Math.min(
    Math.floor((now - HOUR) / HOUR) * HOUR,
    dirty === null ? Number.POSITIVE_INFINITY : Math.floor(Number(dirty) / HOUR) * HOUR,
  )
  const useHours = hourTo > hourFrom
  const rows: CallRow[] = []
  const minutes = (from: number, to: number): void => {
    rows.push(
      ...(db
        .query(
          `select cast(ts / 60000 as integer) * 60000 as m, model, count(*), sum(input), sum(output), sum(cache_read),
                  sum(cache_write_5m), sum(cache_write_1h), sum(weighted)
             from usage_event where ts >= ? and ts < ? and instance in (${marks}) and source in ('cli', 'desktop')
             group by m, model`,
        )
        .values(from, to, ...instance) as CallRow[]),
    )
  }
  if (useHours) {
    minutes(sinceMs, hourFrom)
    rows.push(
      ...(db
        .query(
          `select hour + ${HOUR / 2}, model, sum(calls), sum(input), sum(output), sum(cache_read),
                  sum(cache_write_5m), sum(cache_write_1h), sum(weighted)
             from usage_hour where hour >= ? and hour < ? and instance in (${marks}) and source in ('cli', 'desktop')
             group by hour, model`,
        )
        .values(hourFrom, hourTo, ...instance) as CallRow[]),
    )
    minutes(hourTo, Number.MAX_SAFE_INTEGER)
  } else minutes(sinceMs, Number.MAX_SAFE_INTEGER)
  rows.sort((x, y) => x[0] - y[0])
  for (const [ts, model, turns, input, output, cacheRead, w5, w1, weighted] of rows) {
    visit(ts, {
      [model ?? 'unknown']: {
        weighted,
        output,
        turns,
        input,
        cacheRead,
        cacheCreation5m: w5,
        cacheCreation1h: w1,
      },
    })
  }
}
