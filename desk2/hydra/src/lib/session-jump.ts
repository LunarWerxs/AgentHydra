// lib/session-jump.ts - "open this chat", asked from somewhere in the window (the Instances move
// dialog lists the chats about to move, and the natural thing to do with a chat in a list is click
// it and see it). In Hydra Desk 2's copy there is no Sessions tab: App.vue takes the request and Desk
// opens the chat in its own view (lib/desk-embed.ts). A ref rather than an event because the request
// can be made before App.vue's watcher runs, and a ref holds the value until it does.

import { ref } from 'vue'
import type { SessionSummary } from '@/lib/api'

export type SessionJump = Pick<SessionSummary, 'session_id' | 'source'>

/** The one outstanding request, or null. Read by App.vue, which hands it to Desk. */
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
