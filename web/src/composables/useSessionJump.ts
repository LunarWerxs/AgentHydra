// useSessionJump — jump to ONE session, asked from a dialog here or from another view. "Filter to
// exactly that chat and open it" (owner ask, 2026-09-03): the search box takes the session id,
// which the list filter matches on, so the list shows that one row; select mode is left, because in
// select mode the pane shows the composer rather than the transcript. A chat not in the fetched
// window (the move dialogs list everything, the list defaults to 24 hours) widens the period to
// everything and selects the row the moment the refetch carries it.

import type { Ref } from 'vue'
import { onMounted, watch } from 'vue'
import type { SessionPeriod, SessionSummary } from '@/lib/api'
import { pendingSessionJump, takeSessionJump } from '@/lib/session-jump'

export function useSessionJump(deps: {
  sessions: Ref<SessionSummary[]>
  sessionPeriod: Ref<SessionPeriod>
  selectMode: Ref<boolean>
  toggleSelectMode: () => void
  search: Ref<string>
  select: (s: SessionSummary) => void
  clearBulkConfirm: () => void
}) {
  function jumpToSession(s: Pick<SessionSummary, 'session_id' | 'source'>) {
    if (deps.selectMode.value) deps.toggleSelectMode()
    deps.search.value = s.session_id
    const hit = deps.sessions.value.find(
      (x) => x.session_id === s.session_id && x.source === s.source,
    )
    if (hit) {
      deps.select(hit)
      return
    }
    if (deps.sessionPeriod.value !== 'all') deps.sessionPeriod.value = 'all'
    const stop = watch(deps.sessions, (list) => {
      const found = list.find((x) => x.session_id === s.session_id && x.source === s.source)
      if (!found) return
      deps.select(found)
      stop()
    })
    // A chat that never arrives (deleted since, or filtered by a scope the search cannot override)
    // must not leave a watcher running for the life of the view.
    window.setTimeout(stop, 20_000)
  }
  function consumeSessionJump() {
    const j = takeSessionJump()
    if (j) jumpToSession(j)
  }
  onMounted(consumeSessionJump)
  watch(pendingSessionJump, (j) => {
    if (j) consumeSessionJump()
  })
  function openFromBulkDialog(s: SessionSummary) {
    deps.clearBulkConfirm()
    jumpToSession(s)
  }

  return { jumpToSession, consumeSessionJump, openFromBulkDialog }
}
