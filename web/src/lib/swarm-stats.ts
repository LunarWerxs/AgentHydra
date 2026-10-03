import { computed, getCurrentScope, onScopeDispose, reactive } from 'vue'

export interface SwarmStatsDay {
  day: string
  saved_usd: number | null
}

export interface SwarmStatsData {
  source: string
  empty: boolean
  total: { saved_usd: number | null; est_tokens?: number | null }
  /** Oldest first, as the server sends it. */
  days: SwarmStatsDay[]
  today: { saved_usd: number | null; tasks: number; est_tokens: number | null }
  accounts?: { rows: SwarmAccountRow[]; worked?: number; open?: number }
}

export interface SwarmAccountRow {
  account: string
  tier?: string
  runs: number
  tasks: number
  est_usd: number
  worker_usd: number
  last?: string | null
}

interface PollState {
  stats: SwarmStatsData | null
  loading: boolean
  error: string | null
  offline: boolean
}

interface Poll {
  state: PollState
  refs: number
  timer: ReturnType<typeof setInterval> | undefined
}

export const POLL_MS = 120_000
const polls = new Map<number, Poll>()

async function load(days: number, state: PollState) {
  state.loading = state.stats === null
  try {
    const res = await fetch(`/api/hswarm/api/stats?days=${days}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state.stats = (await res.json()) as SwarmStatsData
    state.error = null
    state.offline = false
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
    state.offline = true
  } finally {
    state.loading = false
  }
}

function acquire(days: number): PollState {
  let poll = polls.get(days)
  if (!poll) {
    poll = {
      state: reactive<PollState>({ stats: null, loading: false, error: null, offline: false }),
      refs: 0,
      timer: undefined,
    }
    polls.set(days, poll)
  }
  poll.refs++
  if (poll.refs === 1) {
    const state = poll.state
    void load(days, state)
    poll.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void load(days, state)
    }, POLL_MS)
  }
  return poll.state
}

function release(days: number) {
  const poll = polls.get(days)
  if (!poll) return
  poll.refs--
  if (poll.refs <= 0) {
    clearInterval(poll.timer)
    polls.delete(days)
  }
}

/** One shared poll per `days`: starts with the first user, stops with the last. Call inside a
 *  component setup or an effect scope; the user is released when that scope ends. */
export function useSwarmStats(days = 14) {
  const state = acquire(days)
  let released = false
  const stop = () => {
    if (released) return
    released = true
    release(days)
  }
  if (getCurrentScope()) onScopeDispose(stop)
  return {
    stats: computed(() => state.stats),
    loading: computed(() => state.loading),
    error: computed(() => state.error),
    offline: computed(() => state.offline),
    stop,
  }
}

export interface WindowSum {
  /** Sum of the measured days, or null when no day in the window was measured. */
  sum: number | null
  measured: number
  total: number
}

/** The newest `n` days (the feed is oldest first, so the last `n`). A null `saved_usd` is a day
 *  that was not measured: it is left out of the sum and out of `measured`, never counted as 0. */
export function lastDaysSaved(days: SwarmStatsDay[], n = 7): WindowSum {
  const window = days.slice(-n)
  let sum = 0
  let measured = 0
  for (const d of window) {
    if (d.saved_usd == null) continue
    sum += d.saved_usd
    measured++
  }
  return { sum: measured > 0 ? sum : null, measured, total: window.length }
}

/** Saved per day for the sparkline, in the given (oldest to newest) order; null = not measured. */
export function sparklineSeries(
  days: SwarmStatsDay[],
): Array<{ day: string; value: number | null }> {
  return days.map((d) => ({ day: d.day, value: d.saved_usd ?? null }))
}
