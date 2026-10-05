// The cloud list's state, one per window: whether the sidebar shows it, its filters (remembered), the rows
// AgentHydra answered, the search box and the multi-select. Fetched on demand and every 30 s while shown.
// Its order is the desk list's own (sidebar/order.ts), so a refresh or the cloud button moves nothing.
import { computed, ref, shallowRef, watch } from 'vue'
import type { CloudInstance, CloudList, CloudSession } from '@shared/protocol'
import { readCache, writeCache } from '@/lib/list-cache'
import { useShellSource } from '@/components/shell/source'
import { dropHidden, recordCloudOrder } from '@/components/sidebar/logic'
import { useHiddenGroups } from '@/components/sidebar/hidden'
import { useSidebarOrder } from '@/components/sidebar/order'
import { cloudOnlyKeys, cloudQuery, deskPlaces, effectiveScopes, groupCloud, parseScopes, pcsIn, rowOrderKey, type CloudScopes } from './logic'

/** The last plain (unsearched) answer and the query it answered, for the next reload (lib/list-cache.ts). */
interface CachedCloud {
  query: string
  list: CloudList
}

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
  // The whole question the rows answer (filters and search), so a list can tell rows a new answer left out.
  const answeredQuery = ref('')
  // A reload starts from the last answer to the same filters, then asks again.
  const cached = readCache<CachedCloud>('cloud')
  const fresh =
    cached?.query === cloudQuery(effectiveScopes(scopes.value, ''), '') && Array.isArray(cached.list?.sessions) ? cached.list : null
  // Replaced whole by each answer, never edited in place, so it is not made deeply reactive.
  const sessions = shallowRef<CloudSession[]>(fresh?.sessions ?? [])
  // The text of the rows held, so an unchanged 30 s answer replaces and writes nothing.
  let heldRows = JSON.stringify(sessions.value)
  let keptCache = ''
  const thisPc = ref(fresh?.thisPc ?? 'This PC')
  // Replaced whole by each answer, never edited in place.
  const instances = shallowRef<CloudInstance[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(!!fresh)
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
      const query = cloudQuery(effectiveScopes(scopes.value, asked), asked)
      const list = await getJson<CloudList>(`/cloud/sessions?${query}`)
      const rows = JSON.stringify(list.sessions)
      if (rows !== heldRows) {
        heldRows = rows
        sessions.value = list.sessions
      }
      // A plain answer is kept for the next reload, but only when it differs from what is kept.
      const kept = `${query}
${list.thisPc}
${rows}`
      if (!asked.trim() && kept !== keptCache) {
        keptCache = kept
        writeCache('cloud', { query, list } satisfies CachedCloud)
      }
      answered.value = asked
      answeredQuery.value = query
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

  // The chats and outside sessions the desk list draws, read the way Sidebar reads them (the Gallery's
  // fixture source, else the desk store): every session it shows is listed here, in the same group at the
  // same place (logic.ts groupCloud). The first useCloud() runs in a component's setup, where the source
  // can be injected.
  const desk = useShellSource()
  const placed = computed(() => deskPlaces(desk.chats.value, desk.external.value))
  const answeredIds = computed(() => new Set(sessions.value.map((r) => r.id)))
  const { order, save: saveOrder } = useSidebarOrder()

  const searching = computed(() => !!answered.value.trim())
  // The groups the desk list hides are hidden here too (sidebar/hidden.ts); a search's answer is one group.
  const hiddenGroups = useHiddenGroups()
  const visible = computed(() =>
    dropHidden(
      groupCloud(sessions.value, effectiveScopes(scopes.value, answered.value), thisPc.value, {
        ranked: searching.value,
        desk: placed.value,
        order: order.value
      }),
      (g) => g.orderKey,
      hiddenGroups.hidden.value,
      hiddenGroups.showHidden.value || searching.value
    )
  )
  const groups = computed(() => visible.value.shown)
  const pcs = computed(() => pcsIn(sessions.value, thisPc.value))

  // The rows and groups only this list has join the saved order at its end once shown, newest first, and
  // keep their places from then on; the desk list records its own at the top (Sidebar.vue). A search's
  // answer records nothing.
  watch(
    () => (on.value && !searching.value ? groups.value : null),
    (shown) => {
      if (!shown) return
      saveOrder(recordCloudOrder(order.value, cloudOnlyKeys(shown, placed.value)))
    },
    { immediate: true }
  )

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
    /** The filters and search the rows answer: a change means rows went because the question changed. */
    answeredQuery,
    thisPc,
    instances,
    loading,
    error,
    loaded,
    groups,
    /** The groups Hide left out of `groups`. */
    hiddenOut: computed(() => visible.value.out),
    pcs,
    selectMode,
    selected,
    refresh,
    toggleSelected,
    setSelectMode,
    /** The desk list lists this session too (with the cloud button off); a row it does not wears a cloud. */
    onDesk: (id: string): boolean => placed.value.has(id),
    /** The row's place in the saved order: its desk row's id, else its session id (logic.ts rowOrderKey). */
    orderKey: (id: string): string => rowOrderKey({ id }, placed.value),
    /** The row is made of the desk's facts: AgentHydra's answer left the session out (logic.ts groupCloud). */
    fromDesk: (id: string): boolean => !answeredIds.value.has(id),
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
