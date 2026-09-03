// web/src/lib/session-jump.ts - "open this chat in Sessions", asked from somewhere that is not the
// Sessions view.
//
// The Instances move dialog lists the chats about to move, and the natural thing to do with a chat
// in a list is click it and see it. Sessions and Instances are sibling views mounted one at a time
// by App.vue with no props between them, so the request travels through this one module-level ref:
// the asker sets it, App.vue switches the tab, and SessionsView takes it when it mounts (or at once
// if it is already showing). A ref rather than an event because the consumer may not exist yet at
// the moment of asking, and a ref holds the value until it does.

import { ref } from 'vue'
import type { SessionSummary } from '@/lib/api'

export type SessionJump = Pick<SessionSummary, 'session_id' | 'source'>

/** The one outstanding request, or null. Read by App.vue (to switch tabs) and SessionsView (to act). */
export const pendingSessionJump = ref<SessionJump | null>(null)

export function requestSessionJump(s: SessionJump): void {
  pendingSessionJump.value = { session_id: s.session_id, source: s.source }
}

/** Take the request and clear it, so a later mount does not replay a jump that already happened. */
export function takeSessionJump(): SessionJump | null {
  const j = pendingSessionJump.value
  pendingSessionJump.value = null
  return j
}
