// useSessionFilters — the sidebar filter menu's derived state: the named-instance list, every
// scope's display label, the "something is narrowing this list" flag, and the watchers that keep
// the fetched window in sync with the scopes. Split out of SessionsView.vue because this is one
// coherent feature (the ⋯ list-options menu) with its own refetch wiring, not several unrelated
// computeds that happen to live near each other.

import type { Ref } from 'vue'
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstances } from '@/composables/useInstances'
import type {
  ArchivedScope,
  DispatchedScope,
  RateLimitScope,
  SessionPeriod,
  SessionSourceScope,
} from '@/lib/api'
import { displayName } from '@/lib/instance-appearance'
import {
  ARCHIVED_LABEL,
  DISPATCHED_LABEL,
  PERIOD_LABEL,
  RATE_LIMIT_LABEL,
  SHAPE_LABEL,
  SOURCE_LABEL,
} from '@/lib/session-labels'
import type { ShapeScope } from '@/lib/session-shape'

export interface SessionFilterRefs {
  sessionInstanceFilter: Ref<string>
  sessionArchivedScope: Ref<ArchivedScope>
  sessionPeriod: Ref<SessionPeriod>
  sessionSourceFilter: Ref<SessionSourceScope>
  sessionDispatchedScope: Ref<DispatchedScope>
  sessionRateLimitScope: Ref<RateLimitScope>
  sessionShapeScope: Ref<ShapeScope>
  refreshSessions: () => void | Promise<void>
}

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
    desktopInstances.value.map((i) => ({ name: i.name, label: displayName(i) })),
  )
  const instanceLabelFor = (folder: string) =>
    namedInstances.value.find((i) => i.name === folder)?.label ?? folder
  // silent: this view has no instance-list spinner to drive, and the toolbar Refresh icon it would
  // toggle belongs to a different view entirely.
  onMounted(() => void refreshInstances({ silent: true }))

  // Every scope is applied server-side, so any of them changing needs a refetch, not a re-filter.
  watch(
    [
      sessionInstanceFilter,
      sessionArchivedScope,
      sessionPeriod,
      sessionDispatchedScope,
      sessionRateLimitScope,
    ],
    () => refreshSessions(),
  )
  watch(sessionSourceFilter, (source) => {
    // Desktop-instance metadata belongs to Claude sessions only. Clear a stale instance scope when
    // switching providers so "Codex" or "OpenCode" cannot appear empty for an invisible old filter.
    if (source !== 'all' && source !== 'claude' && sessionInstanceFilter.value) {
      sessionInstanceFilter.value = ''
      return
    }
    refreshSessions()
  })

  /** The ⋯ trigger reports "something is narrowing this list". Otherwise a filter set once and
   *  forgotten reads as an empty/short list with no visible cause, now that the controls are a
   *  menu rather than a row of lit-up buttons. */
  const filtersActive = computed(
    () =>
      !!sessionInstanceFilter.value ||
      sessionArchivedScope.value !== 'include' ||
      sessionSourceFilter.value !== 'all' ||
      sessionDispatchedScope.value !== 'all' ||
      sessionRateLimitScope.value !== 'all' ||
      sessionShapeScope.value !== 'all' ||
      // Only a WIDENED window counts. 24h is the default, so flagging it would light the trigger up
      // permanently and the signal would stop meaning anything.
      sessionPeriod.value !== '24h',
  )

  const sourceFilterLabel = computed(() => t(SOURCE_LABEL[sessionSourceFilter.value]))
  const rateLimitScopeLabel = computed(() => t(RATE_LIMIT_LABEL[sessionRateLimitScope.value]))
  const instanceFilterLabel = computed(() => {
    const v = sessionInstanceFilter.value
    if (!v) return t('sessions.instanceAll')
    if (v === 'default') return t('sessions.instanceDefault')
    if (v === 'other') return t('sessions.instanceOther')
    return instanceLabelFor(v)
  })
  const archivedScopeLabel = computed(() => t(ARCHIVED_LABEL[sessionArchivedScope.value]))
  const periodLabel = computed(() => t(PERIOD_LABEL[sessionPeriod.value]))
  const dispatchedScopeLabel = computed(() => t(DISPATCHED_LABEL[sessionDispatchedScope.value]))
  const shapeScopeLabel = computed(() => t(SHAPE_LABEL[sessionShapeScope.value]))

  return {
    namedInstances,
    instanceLabelFor,
    filtersActive,
    sourceFilterLabel,
    rateLimitScopeLabel,
    instanceFilterLabel,
    archivedScopeLabel,
    periodLabel,
    dispatchedScopeLabel,
    shapeScopeLabel,
  }
}
