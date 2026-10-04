// useSessionFilters — the sidebar filter menu's derived state: the named-instance list, every
// scope's trigger label, the "something is narrowing this list" flag, the all / none / toggle
// actions the multi-select submenus call, and the watchers that keep the fetched window in sync
// with the scopes. Split out of SessionsView.vue because this is one coherent feature (the ⋯
// list-options menu) with its own refetch wiring, not several unrelated computeds that happen to
// live near each other.

import type { Ref } from 'vue'
import { computed, onMounted, onScopeDispose, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstances } from '@/composables/useInstances'
import { piiDisplayName } from '@/composables/usePrivacy'
import type { SessionPeriod, SessionSource } from '@/lib/api'
import {
  ARCHIVED_LABEL,
  DISPATCHED_LABEL,
  PERIOD_LABEL,
  RATE_LIMIT_LABEL,
  SHAPE_LABEL,
  SOURCE_LABEL,
} from '@/lib/session-labels'
import {
  ARCHIVED_VALUES,
  type ArchivedValue,
  DEFAULT_ARCHIVED,
  DEFAULT_SOURCES,
  DISPATCHED_VALUES,
  type DispatchedValue,
  isAllSelected,
  type ListScopes,
  RATE_LIMIT_VALUES,
  type RateLimitValue,
  SHAPE_VALUES,
  SOURCE_VALUES,
  summarizeSelection,
  toggleValue,
} from '@/lib/session-scopes'
import type { SessionShape } from '@/lib/session-shape'

export interface SessionFilterRefs {
  /** null = every instance; a list = just those ticked. */
  sessionInstanceFilter: Ref<string[] | null>
  sessionArchivedScope: Ref<ArchivedValue[]>
  sessionPeriod: Ref<SessionPeriod>
  sessionSourceFilter: Ref<SessionSource[]>
  sessionDispatchedScope: Ref<DispatchedValue[]>
  sessionRateLimitScope: Ref<RateLimitValue[]>
  sessionShapeScope: Ref<SessionShape[]>
  /** The scopes the list is fetched with right now: the view's, or the wide ones while searching. */
  activeScopes: Ref<ListScopes>
  /** The sidebar search text; the daemon matches it over every session in scope. */
  search: Ref<string>
  refreshSessions: () => void | Promise<void>
}

const SEARCH_DEBOUNCE_MS = 300

export function useSessionFilters(refs: SessionFilterRefs) {
  const { t } = useI18n()
  const {
    sessionInstanceFilter,
    sessionArchivedScope,
    sessionPeriod,
    sessionSourceFilter,
    sessionDispatchedScope,
    sessionRateLimitScope,
    sessionShapeScope,
    activeScopes,
    search,
    refreshSessions,
  } = refs

  // Named instances for the filter dropdown; "default"/"other" are fixed options. The folder
  // name stays the stable filter key (sessions are tagged by it); displayName() is what we SHOW —
  // in the dropdown and in each row's instance chip.
  //
  // Reads the shared useInstances singleton rather than fetching the list itself, because
  // displayName() now prefers the ACCOUNT an instance is signed into, and only that composable
  // resolves accounts. A private fetch would show the folder name here while the Instances tab
  // showed the account name for the very same instance. `computed`, so the chips fill in on their
  // own as each account resolves. A failed load just leaves the named entries out.
  const { instances: desktopInstances, refreshInstances } = useInstances()
  const namedInstances = computed(() =>
    desktopInstances.value.map((i) => ({ name: i.name, label: piiDisplayName(i) })),
  )
  const instanceLabelFor = (folder: string) =>
    namedInstances.value.find((i) => i.name === folder)?.label ?? folder
  // silent: this view has no instance-list spinner to drive, and the toolbar Refresh icon it would
  // toggle belongs to a different view entirely.
  onMounted(() => void refreshInstances({ silent: true }))

  // Every scope is applied server-side except shape, so any of them changing needs a refetch. This
  // watches the scopes IN FORCE, not the view's: while a search runs over everything, a sidebar
  // change moves nothing. The search TEXT is matched by the daemon over every session in scope
  // before its row cap, so it is part of the request; it is debounced, so typing costs one request
  // per pause rather than one per keystroke. Clearing the box goes straight back to the view's list.
  let searchPending: ReturnType<typeof setTimeout> | null = null
  const cancelPending = () => {
    if (searchPending !== null) clearTimeout(searchPending)
    searchPending = null
  }
  watch(
    () => `${JSON.stringify(activeScopes.value)}|${search.value.trim()}`,
    () => {
      cancelPending()
      if (!search.value.trim()) return void refreshSessions()
      searchPending = setTimeout(() => void refreshSessions(), SEARCH_DEBOUNCE_MS)
    },
  )
  onScopeDispose(cancelPending)

  // Instance, queued work and usage wall describe CLAUDE sessions only, so their submenus are
  // available exactly while Claude is among the ticked sources.
  const claudeTicked = computed(() => sessionSourceFilter.value.includes('claude'))

  const instanceUniverse = computed(() => [
    'default',
    ...namedInstances.value.map((i) => i.name),
    'other',
  ])
  /** The instance scope as ticked values: null (every instance) reads as the whole list. */
  const instanceTicked = computed(() => sessionInstanceFilter.value ?? instanceUniverse.value)
  const toggleInstance = (name: string) => {
    const next = toggleValue(instanceTicked.value, instanceUniverse.value, name)
    sessionInstanceFilter.value = isAllSelected(next, instanceUniverse.value) ? null : next
  }
  const instanceAll = () => (sessionInstanceFilter.value = null)
  const instanceNone = () => (sessionInstanceFilter.value = [])

  // Every other scope is a plain list of ticked values over a fixed universe.
  const sourceToggle = (v: SessionSource) =>
    (sessionSourceFilter.value = toggleValue(sessionSourceFilter.value, SOURCE_VALUES, v))
  const dispatchedToggle = (v: DispatchedValue) =>
    (sessionDispatchedScope.value = toggleValue(sessionDispatchedScope.value, DISPATCHED_VALUES, v))
  const rateLimitToggle = (v: RateLimitValue) =>
    (sessionRateLimitScope.value = toggleValue(sessionRateLimitScope.value, RATE_LIMIT_VALUES, v))
  const shapeToggle = (v: SessionShape) =>
    (sessionShapeScope.value = toggleValue(sessionShapeScope.value, SHAPE_VALUES, v))
  const archivedToggle = (v: ArchivedValue) =>
    (sessionArchivedScope.value = toggleValue(sessionArchivedScope.value, ARCHIVED_VALUES, v))

  const everySelection = () => {
    sessionSourceFilter.value = [...SOURCE_VALUES]
    sessionInstanceFilter.value = null
    sessionDispatchedScope.value = [...DISPATCHED_VALUES]
    sessionRateLimitScope.value = [...RATE_LIMIT_VALUES]
    sessionShapeScope.value = [...SHAPE_VALUES]
    sessionArchivedScope.value = [...ARCHIVED_VALUES]
  }

  const sourceAll = () => (sessionSourceFilter.value = [...SOURCE_VALUES])
  const sourceNone = () => (sessionSourceFilter.value = [])
  const dispatchedAll = () => (sessionDispatchedScope.value = [...DISPATCHED_VALUES])
  const dispatchedNone = () => (sessionDispatchedScope.value = [])
  const rateLimitAll = () => (sessionRateLimitScope.value = [...RATE_LIMIT_VALUES])
  const rateLimitNone = () => (sessionRateLimitScope.value = [])
  const shapeAll = () => (sessionShapeScope.value = [...SHAPE_VALUES])
  const shapeNone = () => (sessionShapeScope.value = [])
  const archivedAll = () => (sessionArchivedScope.value = [...ARCHIVED_VALUES])
  const archivedNone = () => (sessionArchivedScope.value = [])

  /** Whether some scope has nothing ticked: the list is empty by request, not because it is broken.
   *  The Claude-only scopes only count while Claude is ticked, since they are disabled otherwise. */
  const filtersHideEverything = computed(
    () =>
      sessionSourceFilter.value.length === 0 ||
      sessionArchivedScope.value.length === 0 ||
      sessionShapeScope.value.length === 0 ||
      (claudeTicked.value &&
        (sessionInstanceFilter.value?.length === 0 ||
          sessionDispatchedScope.value.length === 0 ||
          sessionRateLimitScope.value.length === 0)),
  )

  /** Differs from what the menu starts at, which is the owner's baseline (HSwarm and archived are
   *  off), so only a CHANGE lights the trigger. */
  const sameSelection = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && b.every((v) => a.includes(v))

  /** The ⋯ trigger reports "something is narrowing this list". Otherwise a filter set once and
   *  forgotten reads as an empty/short list with no visible cause, now that the controls are a
   *  menu rather than a row of lit-up buttons. */
  const filtersActive = computed(
    () =>
      sessionInstanceFilter.value !== null ||
      !sameSelection(sessionArchivedScope.value, DEFAULT_ARCHIVED) ||
      !sameSelection(sessionSourceFilter.value, DEFAULT_SOURCES) ||
      !isAllSelected(sessionDispatchedScope.value, DISPATCHED_VALUES) ||
      !isAllSelected(sessionRateLimitScope.value, RATE_LIMIT_VALUES) ||
      !isAllSelected(sessionShapeScope.value, SHAPE_VALUES) ||
      // Only a WIDENED window counts. 24h is the default, so flagging it would light the trigger up
      // permanently and the signal would stop meaning anything.
      sessionPeriod.value !== '24h',
  )

  const summaryText = () => ({
    all: t('sessions.selectionAll'),
    none: t('sessions.selectionNone'),
    more: (first: string, extra: number) => t('sessions.selectionMore', { first, n: extra }),
  })
  const sourceFilterLabel = computed(() =>
    summarizeSelection(sessionSourceFilter.value, SOURCE_VALUES, {
      ...summaryText(),
      label: (v) => t(SOURCE_LABEL[v]),
    }),
  )
  const rateLimitScopeLabel = computed(() =>
    summarizeSelection(sessionRateLimitScope.value, RATE_LIMIT_VALUES, {
      ...summaryText(),
      label: (v) => t(RATE_LIMIT_LABEL[v]),
    }),
  )
  const instanceName = (v: string) =>
    v === 'default'
      ? t('sessions.instanceDefault')
      : v === 'other'
        ? t('sessions.instanceOther')
        : instanceLabelFor(v)
  const instanceFilterLabel = computed(() =>
    summarizeSelection(instanceTicked.value, instanceUniverse.value, {
      ...summaryText(),
      label: instanceName,
    }),
  )
  const archivedScopeLabel = computed(() =>
    summarizeSelection(sessionArchivedScope.value, ARCHIVED_VALUES, {
      ...summaryText(),
      label: (v) => t(ARCHIVED_LABEL[v]),
    }),
  )
  const periodLabel = computed(() => t(PERIOD_LABEL[sessionPeriod.value]))
  const dispatchedScopeLabel = computed(() =>
    summarizeSelection(sessionDispatchedScope.value, DISPATCHED_VALUES, {
      ...summaryText(),
      label: (v) => t(DISPATCHED_LABEL[v]),
    }),
  )
  const shapeScopeLabel = computed(() =>
    summarizeSelection(sessionShapeScope.value, SHAPE_VALUES, {
      ...summaryText(),
      label: (v) => t(SHAPE_LABEL[v]),
    }),
  )

  return {
    namedInstances,
    instanceLabelFor,
    instanceUniverse,
    instanceTicked,
    claudeTicked,
    filtersActive,
    filtersHideEverything,
    resetFilters: everySelection,
    sourceFilterLabel,
    rateLimitScopeLabel,
    instanceFilterLabel,
    archivedScopeLabel,
    periodLabel,
    dispatchedScopeLabel,
    shapeScopeLabel,
    toggleInstance,
    instanceAll,
    instanceNone,
    sourceToggle,
    sourceAll,
    sourceNone,
    dispatchedToggle,
    dispatchedAll,
    dispatchedNone,
    rateLimitToggle,
    rateLimitAll,
    rateLimitNone,
    shapeToggle,
    shapeAll,
    shapeNone,
    archivedToggle,
    archivedAll,
    archivedNone,
  }
}
