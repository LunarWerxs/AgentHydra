import { app } from '../http-app'
import {
  FILTER_KEYS,
  GROUP_BYS,
  type GroupBy,
  LAST_WINDOWS,
  type LastWindow,
  MEASURES,
  type Measure,
  type UsageQueryParams,
  type UsageWindow,
  usageQuery,
} from '../kit/query'

/** Analytics toolkit routes (kit/query.ts). Each filter / groupBy / measures value is a comma list. */
const list = (raw: string | undefined): string[] | undefined =>
  raw === undefined || raw === '' ? undefined : raw.split(',').map((s) => s.trim())

function oneOf<T extends string>(
  vals: string[] | undefined,
  allowed: readonly T[],
  what: string,
): T[] | undefined {
  if (!vals) return undefined
  const bad = vals.find((v) => !(allowed as readonly string[]).includes(v))
  if (bad !== undefined) throw new Error(`${what} "${bad}" is not one of ${allowed.join(', ')}`)
  return vals as T[]
}

/** Parse the same fields usageQuery takes from a query string. Throws Error with a plain message. */
export function parseKitUsageQuery(q: (k: string) => string | undefined): UsageQueryParams {
  let window: UsageWindow | undefined
  const kind = q('kind')
  if (kind !== undefined) {
    if (kind !== '5h' && kind !== 'week') throw new Error('kind must be 5h or week')
    // The window's account is `windowAccount`, else the (first) account filter.
    const account = q('windowAccount') ?? list(q('account'))?.[0]
    if (!account) throw new Error('kind needs windowAccount (or account)')
    window = { account, kind }
  } else if (q('last') !== undefined) {
    const last = q('last') as LastWindow
    if (!LAST_WINDOWS.includes(last))
      throw new Error(`last must be one of ${LAST_WINDOWS.join(', ')}`)
    window = { last }
  } else if (q('from') !== undefined || q('to') !== undefined) {
    const num = (k: string) => {
      const v = q(k)
      if (v === undefined) return undefined
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`${k} must be epoch milliseconds`)
      return n
    }
    window = { from: num('from'), to: num('to') }
  }
  const filter: NonNullable<UsageQueryParams['filter']> = {}
  for (const k of FILTER_KEYS) {
    const v = list(q(k))
    if (!v) continue
    if (k === 'ok') {
      filter.ok = v.map((x) => {
        if (x !== 'true' && x !== 'false') throw new Error('ok must be true or false')
        return x === 'true'
      })
    } else filter[k] = v
  }
  return {
    window,
    filter,
    groupBy: oneOf<GroupBy>(list(q('groupBy')), GROUP_BYS, 'groupBy'),
    measures: oneOf<Measure>(list(q('measures')), MEASURES, 'measures'),
    tz: q('tz'),
  }
}

// Temporary (piece 18 removes it): the kit's numbers next to each old producer's, same window.
app.get('/api/kit/reconcile', async (c) => {
  try {
    const last = c.req.query('last') as LastWindow | undefined
    if (last !== undefined && !LAST_WINDOWS.includes(last))
      throw new Error(`last must be one of ${LAST_WINDOWS.join(', ')}`)
    const num = (k: string) => {
      const v = c.req.query(k)
      if (v === undefined) return undefined
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`${k} must be epoch milliseconds`)
      return n
    }
    const { reconcile, liveReaders } = await import('../kit/reconcile')
    return c.json(
      await reconcile(last ? { last } : { from: num('from'), to: num('to') }, liveReaders),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.get('/api/kit/usage', (c) => {
  try {
    return c.json(usageQuery(parseKitUsageQuery((k) => c.req.query(k))))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
