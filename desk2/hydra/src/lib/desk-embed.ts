// Hydra Desk 2: this copy of AgentHydra's window runs inside Desk 2, in a frame at /ah/?embed=desk. It has
// no Sessions tab (Michael, 2026-10-04): Desk's cloud list is the session list and Desk's own view shows a
// session, with AgentHydra's session header over it. So "open this chat" (the Instances move dialog, the
// landing page's session tiles) is asked of Desk, which slides back and opens it. Messages go only to the
// parent window on this same origin.
import type { SessionJump } from '@/lib/session-jump'

export const EMBEDDED =
  typeof window !== 'undefined' &&
  window.parent !== window &&
  new URLSearchParams(window.location.search).get('embed') === 'desk'

function tellDesk(message: Record<string, unknown>): void {
  if (EMBEDDED) window.parent.postMessage(message, window.location.origin)
}

/** Desk opens this session in its own view. */
export function openInDesk(s: SessionJump): void {
  tellDesk({ type: 'ah:open-session', session_id: s.session_id, source: s.source })
}

/** Desk shows its cloud list, every session of both PCs. */
export function showSessionsInDesk(): void {
  tellDesk({ type: 'ah:show-sessions' })
}
