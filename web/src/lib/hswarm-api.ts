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

/** acct id (as hswarm's report names it) -> the instance signed in as it; empty when the daemon cannot say. */
async function fetchAccountNames(): Promise<
  Record<string, { num: number; label: string; kind: string }>
> {
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
