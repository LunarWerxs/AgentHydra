// useMultiSelect — pick several sessions, message them all at once - or move them. Two ways in:
// the Select switch in the toolbar, or a Ctrl/Cmd-click or Shift-click straight on a row, which
// flips select mode on by itself so the modifier means what it means everywhere else. Split out of
// SessionsView.vue because the checkbox state, the range-select math, and the bulk row actions are
// one feature that several other features (migration, the composer) merely consume.

import type { ComputedRef, Ref } from 'vue'
import { computed, ref } from 'vue'
import type { SessionSource, SessionSummary } from '@/lib/api'
import { rangeBetween } from '@/lib/session-multiselect'

export function useMultiSelect(deps: {
  filtered: ComputedRef<SessionSummary[]>
  selectedId: Ref<string | null>
  selectedSource: Ref<SessionSource | null>
  select: (s: SessionSummary) => void
  copy: (text: string) => void
}) {
  const selectMode = ref(false)
  const checkedIds = ref<Set<string>>(new Set())
  const sessionKey = (s: Pick<SessionSummary, 'source' | 'session_id'>) =>
    `${s.source}:${s.session_id}`
  const isChecked = (s: SessionSummary) => checkedIds.value.has(sessionKey(s))
  // The row a Shift-range extends FROM: the last row deliberately clicked, or the open transcript's
  // row when the very first modifier click is a Shift-click, which is what a keyboard user expects.
  let rangeAnchor: string | null = null

  function toggleSelectMode() {
    selectMode.value = !selectMode.value
    if (!selectMode.value) {
      checkedIds.value = new Set()
      rangeAnchor = null
    }
  }
  function toggleChecked(s: SessionSummary) {
    if (s.source !== 'claude') return
    const next = new Set(checkedIds.value)
    const key = sessionKey(s)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    checkedIds.value = next
    rangeAnchor = key
  }
  function checkAllFiltered() {
    checkedIds.value = new Set(
      deps.filtered.value.filter((s) => s.source === 'claude').map(sessionKey),
    )
  }
  function rowClick(s: SessionSummary, ev?: MouseEvent) {
    const modifier = !!ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)
    if (modifier && s.source === 'claude') {
      if (!selectMode.value) {
        selectMode.value = true
        if (ev.shiftKey && deps.selectedId.value && deps.selectedSource.value)
          rangeAnchor = `${deps.selectedSource.value}:${deps.selectedId.value}`
      }
      if (ev.shiftKey && rangeAnchor) {
        const keys = deps.filtered.value.filter((x) => x.source === 'claude').map(sessionKey)
        const next = new Set(checkedIds.value)
        for (const k of rangeBetween(keys, rangeAnchor, sessionKey(s))) next.add(k)
        checkedIds.value = next
        return // the anchor stays put, so a second Shift-click re-ranges from the same row
      }
      toggleChecked(s)
      return
    }
    if (selectMode.value) toggleChecked(s)
    else deps.select(s)
  }
  const checkedSessions = computed(() => deps.filtered.value.filter((s) => isChecked(s)))
  const bulkCount = computed(() => checkedIds.value.size)

  function copyCheckedIds() {
    deps.copy(checkedSessions.value.map((s) => s.session_id).join('\n'))
  }

  return {
    selectMode,
    checkedIds,
    sessionKey,
    isChecked,
    toggleSelectMode,
    toggleChecked,
    checkAllFiltered,
    rowClick,
    checkedSessions,
    bulkCount,
    copyCheckedIds,
  }
}
