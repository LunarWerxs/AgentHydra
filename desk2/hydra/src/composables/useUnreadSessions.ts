// Which sessions moved since you last opened them (lib/session-unread.ts). Kept in this browser's
// localStorage: the shared UI prefs carry only flags, numbers and strings, and what you have read
// here is this screen's business.
import { useStorage } from '@vueuse/core'
import { type Ref, watch } from 'vue'
import { isUnread, markSeen, pruneSeen, type SeenState, unreadKey } from '@/lib/session-unread'

type Row = { source: string; session_id: string; last_activity_at: number }

const state = useStorage<SeenState>('agenthydra.sessions.seen', { since: Date.now(), seen: {} })
let pruned = false

export function useUnreadSessions(open: Ref<Row | null>) {
  if (!pruned) {
    pruned = true
    state.value = pruneSeen(state.value, Date.now())
  }
  // The open session is read as it moves, so closing it never leaves it bold.
  watch(
    () => open.value && ([unreadKey(open.value), open.value.last_activity_at] as const),
    (o) => {
      if (o) state.value = markSeen(state.value, o[0], o[1])
    },
    { immediate: true },
  )
  return {
    unread: (s: Row) =>
      !(open.value && unreadKey(open.value) === unreadKey(s)) &&
      isUnread(state.value, unreadKey(s), s.last_activity_at),
  }
}
