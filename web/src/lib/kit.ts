// The web's one analytics layer: one fetch of the toolkit's usage query (server/src/kit/query.ts,
// GET /api/kit/usage), a shared ref-counted poll, and the one token and USD formatter set.
// docs/ANALYTICS-PLAN.md section 4.7 and piece 16.
import { computed, getCurrentScope, onScopeDispose, reactive } from 'vue'
import { j } from '@/lib/api'

// ---- the query -----------------------------------------------------------------------------------

export type KitUsageRow = Record<string, string | number | null>

export interface KitUsageResult {
  rows: KitUsageRow[]
  totals: Record<string, number | null>
  coverage: { sources: Record<string, { events: number; firstTs: number; lastTs: number }> }
}

export type KitUsageQuery = Record<string, string | number | string[] | undefined>

/** The query as a canonical query string: keys sorted, so the same question is the same key. */
export function kitQueryString(query: KitUsageQuery): string {
  const qs = new URLSearchParams()
  for (const k of Object.keys(query).sort()) {
    const v = query[k]
    if (v !== undefined) qs.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  return qs.toString()
}

export const fetchKitUsage = (query: KitUsageQuery): Promise<KitUsageResult> =>
  j<KitUsageResult>(`/api/kit/usage?${kitQueryString(query)}`)

const DAY_MS = 86_400_000

/** Epoch ms of local midnight `days - 1` days back: a window of `days` calendar days ending now. */
export function localDaysFrom(days: number, now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return d.getTime()
}

/** `days` rolling days ending now. */
export const rollingDaysFrom = (days: number, now = Date.now()): number => now - days * DAY_MS

export const localTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

// ---- the shared poll -----------------------------------------------------------------------------

export interface PollState<T> {
  data: T | null
  loading: boolean
  error: string | null
  offline: boolean
}

interface Poll<T> {
  state: PollState<T>
  refs: number
  timer: ReturnType<typeof setInterval> | undefined
  load: () => Promise<void>
  first: Promise<void>
}

export const KIT_POLL_MS = 120_000
const polls = new Map<string, Poll<unknown>>()

/** One poll per distinct key: the first user starts the request and the timer, every other user
 *  shares them, and the timer stops with the last release. Returns the shared state. */
export function acquirePoll<T>(
  key: string,
  fetcher: () => Promise<T>,
  ms = KIT_POLL_MS,
): { state: PollState<T>; ready: Promise<void>; shared: boolean; release: () => void } {
  let poll = polls.get(key) as Poll<T> | undefined
  const shared = poll !== undefined
  if (!poll) {
    const state = reactive({
      data: null,
      loading: false,
      error: null,
      offline: false,
    }) as PollState<T>
    const load = async () => {
      state.loading = state.data === null
      try {
        state.data = await fetcher()
        state.error = null
        state.offline = false
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err)
        state.offline = true
      } finally {
        state.loading = false
      }
    }
    poll = { state, refs: 0, timer: undefined, load, first: Promise.resolve() }
    polls.set(key, poll as Poll<unknown>)
  }
  poll.refs++
  if (poll.refs === 1) {
    const p = poll
    p.first = p.load()
    p.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void p.load()
    }, ms)
  }
  const held = poll
  let released = false
  return {
    state: held.state,
    ready: held.first,
    shared,
    release: () => {
      if (released) return
      released = true
      held.refs--
      if (held.refs <= 0) {
        clearInterval(held.timer)
        if (polls.get(key) === held) polls.delete(key)
      }
    },
  }
}

/** A one-off read that shares with whoever already polls the same key: when the poll is live its
 *  data is returned without a request, else one request is made. Never leaves a timer behind. */
export async function readShared<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const h = acquirePoll<T>(key, fetcher)
  try {
    await h.ready
    if (h.state.data === null) throw new Error(h.state.error ?? 'no data')
    return h.state.data
  } finally {
    h.release()
  }
}

/** Run a poll for the life of the calling component or effect scope. */
export function usePoll<T>(key: string, fetcher: () => Promise<T>, ms = KIT_POLL_MS) {
  const h = acquirePoll(key, fetcher, ms)
  if (getCurrentScope()) onScopeDispose(h.release)
  const state = h.state
  return {
    data: computed(() => state.data),
    loading: computed(() => state.loading),
    error: computed(() => state.error),
    offline: computed(() => state.offline),
    stop: h.release,
  }
}

/** The kit's usage query, polled and shared: two components asking the same question share one
 *  request and one timer. */
export function useKit(query: KitUsageQuery, ms = KIT_POLL_MS) {
  const qs = kitQueryString(query)
  return usePoll<KitUsageResult>(`kit:${qs}`, () => fetchKitUsage(query), ms)
}

/** All-time tokens one source moved, from the kit, shared by every card that shows it. Null until
 *  the kit has answered, or when it has no events for that source. */
export function useKitSourceTokens(source: string) {
  const { data } = useKit({ source, last: 'all', measures: 'tokens' })
  return computed(() => {
    const d = data.value
    if (!d?.coverage.sources[source]) return null
    return d.totals.tokens ?? null
  })
}

// ---- formatters ----------------------------------------------------------------------------------

/** The marker for a figure that is not there (the sentinel the tiles and tables already use). */
export const UNPRICED = '—'
/** What a figure reads when its price is not exact (a model without a published price, or a cache
 *  price that is a guess): never a made-up $0.00. */
export const NO_EXACT_PRICE = 'no exact price'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
/** "85.3M": token counts are read at a glance, not to the unit. */
export const formatTokens = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? UNPRICED : compact.format(n)

export type UsdStyle =
  /** "$1,234.50", "<$0.01" under a cent (the default). */
  | 'standard'
  /** "$0.0042": four decimals under a cent, for per-call prices. */
  | 'fine'
  /** "$1,235" from $100, else "$12.34", with a true minus sign (savings tables). */
  | 'whole'

export interface UsdOptions {
  style?: UsdStyle
  /** false when the price is not exact: the figure reads NO_EXACT_PRICE instead of a dollar amount. */
  exact?: boolean
}

const usdIntl = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** A dollar figure. Locked to USD: these are list prices, not an amount converted into the reader's
 *  currency. A missing figure reads UNPRICED and an inexact one NO_EXACT_PRICE, never $0.00. */
export function formatUsd(n: number | null | undefined, opts: UsdOptions = {}): string {
  if (opts.exact === false) return NO_EXACT_PRICE
  if (n == null || !Number.isFinite(n)) return UNPRICED
  const style = opts.style ?? 'standard'
  if (style === 'whole') {
    const a = Math.abs(n)
    const s = a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(2)
    return `${n < 0 ? '−' : ''}$${s}`
  }
  if (style === 'fine') {
    if (n === 0) return '$0.00'
    return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
  }
  return n > 0 && n < 0.01 ? `<${usdIntl.format(0.01)}` : usdIntl.format(n)
}

/** An account's credit amount in its own currency (usage.ts's rule), as part of the one formatter set. */
export { formatMoney as formatCredit } from './usage'
