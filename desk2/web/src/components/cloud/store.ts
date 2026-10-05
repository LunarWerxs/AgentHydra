// The cloud list's state, one per window: whether the sidebar shows it, its filters (remembered), the rows
// AgentHydra answered, the search box and the multi-select. Fetched on demand and every 30 s while shown.
import { computed, ref, watch } from 'vue'
import type { CloudInstance, CloudList, CloudSession } from '@shared/protocol'
import { cloudQuery, effectiveScopes, groupCloud, parseScopes, pcsIn, type CloudScopes } from './logic'

const storage = typeof localStorage === 'undefined' ? null : localStorage
const ON_KEY = 'hydra-desk.cloud.on'
const SCOPES_KEY = 'hydra-desk.cloud.scopes'
const POLL_MS = 30_000
const SEARCH_DEBOUNCE_MS = 300

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) {
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' && error ? error : `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

function createCloud() {
  const on = ref(storage?.getItem(ON_KEY) === '1')
  const scopes = ref<CloudScopes>(parseScopes(storage?.getItem(SCOPES_KEY)))
  const search = ref('')
  // The search the rows answer, not what the box says now: until a search's answer arrives the rows are
  // still the plain list, and they keep their folder groups.
  const answered = ref('')
  const sessions = ref<CloudSession[]>([])
  const thisPc = ref('This PC')
  const instances = ref<CloudInstance[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)
  const selectMode = ref(false)
  const selected = ref(new Set<string>())

  watch(on, (v) => storage?.setItem(ON_KEY, v ? '1' : '0'))
  watch(scopes, (s) => storage?.setItem(SCOPES_KEY, JSON.stringify(s)), { deep: true })

  // A refresh asked for while one runs runs once more after it, with whatever the filters are by then.
  let inFlight = false
  let again = false
  async function refresh(): Promise<void> {
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    loading.value = true
    try {
      const asked = search.value
      const list = await getJson<CloudList>(`/cloud/sessions?${cloudQuery(effectiveScopes(scopes.value, asked), asked)}`)
      sessions.value = list.sessions
      answered.value = asked
      thisPc.value = list.thisPc
      error.value = null
      loaded.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      inFlight = false
      loading.value = false
      if (again) {
        again = false
        void refresh()
      }
    }
  }
  async function loadInstances(): Promise<void> {
    try {
      instances.value = await getJson<CloudInstance[]>('/cloud/instances')
    } catch {
      // floor-ok: the Instance menu then offers Default and Other only; the next open asks again.
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  function startPolling() {
    if (timer) return
    void refresh()
    void loadInstances()
    timer = setInterval(() => document.visibilityState !== 'hidden' && void refresh(), POLL_MS)
  }
  function stopPolling() {
    if (timer) clearInterval(timer)
    timer = null
  }
  watch(on, (v) => (v ? startPolling() : stopPolling()), { immediate: true })
  watch(
    () => JSON.stringify(scopes.value),
    () => on.value && void refresh()
  )
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  watch(search, () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => on.value && void refresh(), SEARCH_DEBOUNCE_MS)
  })

  const searching = computed(() => !!answered.value.trim())
  const groups = computed(() => groupCloud(sessions.value, effectiveScopes(scopes.value, answered.value), thisPc.value, searching.value))
  const pcs = computed(() => pcsIn(sessions.value, thisPc.value))

  function toggleSelected(id: string) {
    const next = new Set(selected.value)
    if (!next.delete(id)) next.add(id)
    selected.value = next
  }
  function setSelectMode(v: boolean) {
    selectMode.value = v
    if (!v) selected.value = new Set()
  }

  return {
    on,
    scopes,
    search,
    sessions,
    thisPc,
    instances,
    loading,
    error,
    loaded,
    groups,
    pcs,
    selectMode,
    selected,
    refresh,
    toggleSelected,
    setSelectMode,
    /** Every filter back to AgentHydra's Sessions defaults. */
    reset(): void {
      scopes.value = parseScopes(null)
    }
  }
}

let cloud: ReturnType<typeof createCloud> | null = null

/** The window's one cloud list. */
export function useCloud(): ReturnType<typeof createCloud> {
  if (!cloud) cloud = createCloud()
  return cloud
}
