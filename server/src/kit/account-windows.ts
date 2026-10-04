// Per-account token windows for the instance tables (docs/ANALYTICS-PLAN.md piece 9): what each
// account has run in its current 5-hour window, its current week and all time, read from the kit.
// Windows are cut by the one resolver in query.ts (the account's quota snapshot, else rolling), so
// accounts that share a window start share one grouped query; "total" is a single `last: all` query.
import type { AccountTokens, TokenParts } from '../types'
import {
  cachedQuota,
  resolveWindow,
  sharedKitStore,
  TOKEN_KIND_MEASURES,
  type UsageQueryOpts,
  type UsageRow,
  usageQuery,
} from './query'

const zero = (): TokenParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

const partsOf = (r: UsageRow): TokenParts => ({
  input: Number(r.input ?? 0),
  output: Number(r.output ?? 0),
  cacheRead: Number(r.cache_read ?? 0),
  cacheWrite: Number(r.cache_write ?? 0),
  total: Number(r.tokens ?? 0),
})

/** `accounts` are kit account ids (`acct-…`). An account with no events reads as zeros. */
export function accountTokenWindows(
  accounts: string[],
  opts: UsageQueryOpts = {},
): Map<string, AccountTokens> {
  const ids = [...new Set(accounts)]
  const out = new Map<string, AccountTokens>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { fiveHour: zero(), week: zero(), total: zero() })
  const now = opts.now ?? Date.now()
  const measures = ['tokens', ...TOKEN_KIND_MEASURES] as const

  const read = (kind: '5h' | 'week', put: (t: AccountTokens, p: TokenParts) => void): void => {
    const quota = opts.quota ?? cachedQuota((opts.store ?? sharedKitStore()).db)
    const byFrom = new Map<number, string[]>()
    for (const id of ids) {
      const from = resolveWindow({ account: id, kind }, now, quota).from
      byFrom.set(from, [...(byFrom.get(from) ?? []), id])
    }
    for (const [from, group] of byFrom) {
      const res = usageQuery(
        {
          window: { from, to: now },
          filter: { account: group },
          groupBy: ['account'],
          measures: [...measures],
        },
        opts,
      )
      for (const r of res.rows) {
        const t = out.get(String(r.account))
        if (t) put(t, partsOf(r))
      }
    }
  }
  read('5h', (t, p) => {
    t.fiveHour = p
  })
  read('week', (t, p) => {
    t.week = p
  })
  const all = usageQuery(
    {
      window: { last: 'all' },
      filter: { account: ids },
      groupBy: ['account'],
      measures: [...measures],
    },
    opts,
  )
  for (const r of all.rows) {
    const t = out.get(String(r.account))
    if (t) t.total = partsOf(r)
  }
  return out
}
