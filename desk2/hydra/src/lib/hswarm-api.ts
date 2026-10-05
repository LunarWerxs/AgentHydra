import { computed, ref, shallowRef } from 'vue'
import { API_BASE } from '@/lib/api'
import { pii, piiName } from '@/composables/usePrivacy'
import { formatUsd as kitUsd, readShared } from '@/lib/kit'
import { reconcileList, sameData } from '@/lib/reconcile'
import { loadStats, statsKey } from '@/lib/swarm-stats'

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
// Shallow: the state is only ever replaced whole, so its providers and models need no deep proxy.
const state = shallowRef<HswarmState | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

// A list the tree and its page both ask for when one is selected (Clients, Jobs, Overview): one request,
// shared while it is in flight and for a moment after, so the page that mounts right behind the tree's
// load does not ask again. Later calls (Reload, Refresh) fetch afresh.
const SHARED_GETS = new Set(['clients', 'jobs'])
const SHARE_MS = 1000
const shared = new Map<string, Promise<any>>()

function apiCall(path: string, options: RequestInit = {}): Promise<any> {
  if (!SHARED_GETS.has(path) || (options.method ?? 'GET') !== 'GET') {
    // A write may change what a shared list says, so the next read asks again.
    if (options.method && options.method !== 'GET') shared.clear()
    return request(path, options)
  }
  let pending = shared.get(path)
  if (!pending) {
    const fresh = request(path, options)
    pending = fresh
    shared.set(path, fresh)
    const drop = () => {
      if (shared.get(path) === fresh) shared.delete(path)
    }
    fresh.then(() => setTimeout(drop, SHARE_MS), drop)
  }
  return pending
}

async function request(path: string, options: RequestInit) {
  // The daemon forwards /api/hswarm/<rest> to hswarm as /<rest>; the console's routes live under /api/.
  const response = await fetch(`${API_BASE}/api/hswarm/api/${path}`, {
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
    const response = await fetch(`${API_BASE}/api/hswarm-status`)
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
    // An unchanged state writes nothing; a changed one keeps each unchanged list as it was.
    const prev = state.value
    if (!prev) state.value = data
    else if (!sameData(prev, data)) {
      state.value = {
        ...data,
        providers: reconcileList(prev.providers ?? [], data.providers ?? [], (p) => p.name),
        models: reconcileList(prev.models ?? [], data.models ?? [], (m) => `${m.provider}/${m.name}`),
      }
    }
    if (error.value !== null) error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load state'
    state.value = null
  } finally {
    loading.value = false
  }
}

/** The stats feed for a window, through the shared poll: no request of its own when a card already
 *  polls the same window. */
async function fetchStats<T = any>(days: number): Promise<T> {
  return (await readShared(statsKey(days), () => loadStats(days))) as T
}

export interface HswarmAccountName {
  num?: number
  label: string
  kind?: string
  /** Signed out or moved: named from what AgentHydra remembers, not from a current login. */
  former?: boolean
}

/** How one acct id reads in a table: former accounts say so, an id nobody knows stays raw with a hint.
 *  Privacy mode masks the label: an instance name may be the account's address, and a former account
 *  with no number is named by its profile name or address alone. */
export function accountDisplay(
  id: string,
  names: Record<string, HswarmAccountName>,
  t: (key: string, params?: Record<string, unknown>) => string,
): { text: string; muted: boolean; title?: string } {
  const n = names[id]
  if (!n) return { text: id, muted: false, title: t('swarmStats.accountUnknown') }
  if (!n.former) return { text: `#${n.num} ${pii(n.label)}`, muted: false }
  const text =
    n.num != null
      ? t('swarmStats.accountWas', { name: pii(n.label), num: n.num })
      : t('swarmStats.accountSignedOut', { name: piiName(n.label) })
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

const formatUsd = (value: number): string => kitUsd(value, { style: 'fine' })

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
    const response = await fetch(`${API_BASE}/api/hswarm-accounts`)
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
