// useMultiSelect: pick several sessions, message them all at once - or move them. Ways in: the
// Select switch in the toolbar, a Ctrl/Cmd-click or Shift-click straight on a row, Ctrl/Cmd+A with
// the list focused, or a box dragged over the rows; each flips select mode on by itself so the
// gesture means what it means everywhere else. Every gesture ends as a SelectionRequest applied
// to the checked set (lib/session-multiselect.ts), so they all share one contract. Split out of
// SessionsView.vue because the checkbox state, the range-select math, and the bulk row actions are
// one feature that several other features (migration, the composer) merely consume.

import type { ComputedRef, Ref } from 'vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import type { SessionSource, SessionSummary } from '@/lib/api'
import {
  applySelectionRequests,
  bandRange,
  type RowBand,
  type SelectionRequest,
} from '@/lib/session-multiselect'

/** How far the pointer must travel before a press on the list becomes a box drag, so a slightly
 *  shaky click still clicks. */
const BOX_THRESHOLD_PX = 6
/** Within this distance of the list's top or bottom edge a box drag scrolls the list. */
const BOX_EDGE_PX = 24
/** How far the list scrolls per animation frame while a box drag sits in that edge zone. */
const BOX_SCROLL_STEP_PX = 10

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
  /** The selectable (Claude) rows in the order the list shows them: what a request resolves in. */
  const selectableKeys = () =>
    deps.filtered.value.filter((s) => s.source === 'claude').map(sessionKey)
  function request(reqs: SelectionRequest[], base: ReadonlySet<string> = checkedIds.value) {
    checkedIds.value = applySelectionRequests(selectableKeys(), base, reqs)
  }

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
    request([{ type: 'setAll', selected: true }])
  }
  function clearChecked() {
    request([{ type: 'setAll', selected: false }])
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
        request([{ type: 'setRange', first: rangeAnchor, last: sessionKey(s), selected: true }])
        return // the anchor stays put, so a second Shift-click re-ranges from the same row
      }
      toggleChecked(s)
      return
    }
    if (selectMode.value) toggleChecked(s)
    else deps.select(s)
  }

  // Ctrl/Cmd+A while focus is in the list (a row button is focused after any click on it) selects
  // every visible Claude row. Bound on the list, not globally, so Ctrl+A in the filter box still
  // selects its text. Escape there clears the selection first and stops, so the window-level
  // Escape shortcut does not also close the open session. Scoping it to the list is also what
  // keeps an Escape that dismisses a context menu or dialog (focus is in that layer, not the list)
  // from wiping the selection the user built.
  function listKeydown(ev: KeyboardEvent) {
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey
    if (ev.key === 'Escape' && plain) {
      if (!selectMode.value || checkedIds.value.size === 0) return
      ev.preventDefault()
      ev.stopPropagation()
      clearChecked()
      return
    }
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'a')
      return
    ev.preventDefault()
    selectMode.value = true
    checkAllFiltered()
  }

  // BOX SELECT. A press on the list that travels past the threshold draws a band; every Claude row
  // it touches is one contiguous range, applied live as a setRange request over the selection the
  // drag started from. A plain drag replaces the selection, Ctrl/Cmd/Shift-drag adds to it. Outside
  // select mode only a modified drag starts one (a plain press there still opens the session), and
  // touch never does, because on touch a drag is how the list scrolls. Rows carry their key in
  // data-select-key; positions are in the scroll container's content coordinates, so wheel or
  // edge scrolling mid-drag keeps extending the same band.
  const box = ref<{ top: number; height: number } | null>(null)
  let drag: {
    el: HTMLElement
    startX: number
    startClientY: number
    startY: number
    clientY: number
    additive: boolean
    active: boolean
    base: Set<string>
  } | null = null
  let suppressClick = false
  let edgeFrame = 0

  const contentY = (el: HTMLElement, clientY: number) =>
    clientY - el.getBoundingClientRect().top + el.scrollTop

  function updateBox() {
    if (!drag?.active) return
    const { el } = drag
    const top0 = el.getBoundingClientRect().top - el.scrollTop
    const rows: RowBand[] = []
    for (const row of el.querySelectorAll<HTMLElement>('[data-select-key]')) {
      const r = row.getBoundingClientRect()
      rows.push({ key: row.dataset.selectKey ?? '', top: r.top - top0, bottom: r.bottom - top0 })
    }
    const y = contentY(el, drag.clientY)
    box.value = { top: Math.min(drag.startY, y), height: Math.abs(y - drag.startY) }
    const band = bandRange(rows, drag.startY, y)
    request(band ? [{ type: 'setRange', ...band, selected: true }] : [], drag.base)
    if (band) rangeAnchor = y >= drag.startY ? band.last : band.first
  }
  // Edge auto-scroll runs per frame, not per pointermove, so a pointer held still in the edge zone
  // keeps the list scrolling; each scroll event re-runs updateBox, which extends the band.
  function edgeScroll() {
    edgeFrame = 0
    if (!drag?.active) return
    const r = drag.el.getBoundingClientRect()
    const dy =
      drag.clientY < r.top + BOX_EDGE_PX
        ? -BOX_SCROLL_STEP_PX
        : drag.clientY > r.bottom - BOX_EDGE_PX
          ? BOX_SCROLL_STEP_PX
          : 0
    if (!dy) return
    drag.el.scrollBy(0, dy)
    edgeFrame = window.requestAnimationFrame(edgeScroll)
  }
  function onBoxMove(ev: PointerEvent) {
    if (!drag) return
    drag.clientY = ev.clientY
    if (!drag.active) {
      const dist = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startClientY)
      if (dist < BOX_THRESHOLD_PX) return
      drag.active = true
      selectMode.value = true
      drag.base = drag.additive ? new Set(checkedIds.value) : new Set()
      window.getSelection()?.removeAllRanges()
    }
    if (!edgeFrame) edgeScroll()
    updateBox()
  }
  function endBox() {
    if (!drag) return
    // The pointerup that ends a real drag is followed by a click on whatever row it ended over;
    // that click must not toggle the row the band just set. It fires before any timer, so the
    // zero-delay reset only matters when no click follows at all.
    if (drag.active) {
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
    }
    if (edgeFrame) window.cancelAnimationFrame(edgeFrame)
    edgeFrame = 0
    drag.el.removeEventListener('scroll', updateBox)
    window.removeEventListener('pointermove', onBoxMove)
    window.removeEventListener('pointerup', endBox)
    window.removeEventListener('pointercancel', endBox)
    drag = null
    box.value = null
  }
  function boxPointerDown(ev: PointerEvent) {
    if (ev.button !== 0 || ev.pointerType === 'touch' || drag) return
    const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey
    if (!selectMode.value && !additive) return
    const el = ev.currentTarget as HTMLElement
    // a press on the list's own scrollbar is a scroll, not the start of a band
    if (ev.clientX - el.getBoundingClientRect().left >= el.clientLeft + el.clientWidth) return
    drag = {
      el,
      startX: ev.clientX,
      startClientY: ev.clientY,
      startY: contentY(el, ev.clientY),
      clientY: ev.clientY,
      additive,
      active: false,
      base: new Set(),
    }
    el.addEventListener('scroll', updateBox)
    window.addEventListener('pointermove', onBoxMove)
    window.addEventListener('pointerup', endBox)
    window.addEventListener('pointercancel', endBox)
  }
  /** Bound as a capture-phase click on the list, so the row's own click never sees it. */
  function boxClickGuard(ev: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    ev.stopPropagation()
    ev.preventDefault()
  }
  onBeforeUnmount(endBox)

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
    clearChecked,
    rowClick,
    listKeydown,
    box,
    boxPointerDown,
    boxClickGuard,
    checkedSessions,
    bulkCount,
    copyCheckedIds,
  }
}
