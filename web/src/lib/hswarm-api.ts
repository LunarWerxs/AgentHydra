import { computed, ref } from 'vue'

interface HswarmStatus {
  running: boolean
  port?: number
  pid?: number
  lastError?: string
}

export interface HswarmState {
  providers: any[]
  models: any[]
  priority?: Record<string, number>
  [key: string]: any
}

const status = ref<HswarmStatus>({ running: false })
const state = ref<HswarmState | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

async function apiCall(path: string, options: RequestInit = {}) {
  // The daemon forwards /api/hswarm/<rest> to hswarm as /<rest>; the console's routes live under /api/.
  const response = await fetch(`/api/hswarm/api/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new Error(data.error || `HTTP ${response.status}`)
  }

  return response.json()
}

async function fetchStatus() {
  try {
    const response = await fetch('/api/hswarm-status')
    const data = await response.json()
    status.value = data
    error.value = data.error ? data.lastError : null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to fetch status'
    status.value = { running: false }
  }
}

async function fetchState() {
  if (!status.value.running) {
    error.value = 'HSwarm is not running'
    return
  }

  loading.value = true
  try {
    const data = await apiCall('state')
    state.value = data
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load state'
    state.value = null
  } finally {
    loading.value = false
  }
}

async function fetchStats(days: number) {
  return apiCall(`stats?days=${days}`)
}

export interface HswarmAccountName {
  num?: number
  label: string
  kind?: string
  /** Signed out or moved: named from what AgentHydra remembers, not from a current login. */
  former?: boolean
}

/** How one acct id reads in a table: former accounts say so, an id nobody knows stays raw with a hint. */
export function accountDisplay(
  id: string,
  names: Record<string, HswarmAccountName>,
  t: (key: string, params?: Record<string, unknown>) => string,
): { text: string; muted: boolean; title?: string } {
  const n = names[id]
  if (!n) return { text: id, muted: false, title: t('swarmStats.accountUnknown') }
  if (!n.former) return { text: `#${n.num} ${n.label}`, muted: false }
  const text =
    n.num != null
      ? t('swarmStats.accountWas', { name: n.label, num: n.num })
      : t('swarmStats.accountSignedOut', { name: n.label })
  return { text, muted: true }
}

/** The money fields a ledger report carries: value at list price for every call, and the part known to be billed. */
export interface HswarmMoney {
  value_usd?: number
  /** Calls known to be billed (a paid key). */
  spent_usd?: number
  /** Calls known to be free or trial. */
  free_usd?: number
  /** Calls written before the ledger said whether they were billed. */
  unknown_usd?: number
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * The secondary money line under a token headline: "$X spent · $Y value at list price", where spending is known.
 * Lines from before the ledger recorded it are counted apart and said so, never folded into spent. Empty when there
 * is no money to show.
 */
export function moneyLine(
  m: HswarmMoney,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const value = m.value_usd ?? 0
  if (value <= 0) return ''
  const unknown = m.unknown_usd ?? 0
  const sep = ` ${t('hswarm.v.money.separator')} `
  const parts: string[] = []
  if (unknown < value) parts.push(t('hswarm.v.money.spent', { usd: formatUsd(m.spent_usd ?? 0) }))
  parts.push(t('hswarm.v.money.value', { usd: formatUsd(value) }))
  if (unknown > 0) parts.push(t('hswarm.v.money.unknown', { usd: formatUsd(unknown) }))
  return parts.join(sep)
}

/** acct id (as hswarm's report names it) -> the instance signed in as it (or `former` ones); empty when the daemon cannot say. */
export async function fetchAccountNames(): Promise<Record<string, HswarmAccountName>> {
  try {
    const response = await fetch('/api/hswarm-accounts')
    return response.ok ? await response.json() : {}
  } catch {
    return {}
  }
}

async function refresh() {
  await fetchStatus()
  if (status.value.running) {
    await fetchState()
  }
}

export function useHswarmApi() {
  return {
    status: computed(() => status.value),
    state: computed(() => state.value),
    error: computed(() => error.value),
    loading: computed(() => loading.value),
    fetchStatus,
    fetchState,
    refresh,
    apiCall,
    fetchStats,
    fetchAccountNames,
  }
}
