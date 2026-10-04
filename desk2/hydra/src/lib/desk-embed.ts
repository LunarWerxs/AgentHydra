// Hydra Desk 2: this copy of AgentHydra's window runs inside Desk 2, in a frame at /ah/?embed=desk, and
// Desk's sidebar is its session list. Embedded, the Sessions view hides its own list, opens the session
// Desk's sidebar asks for (the same jump the Instances dialog uses, lib/session-jump.ts), and tells Desk
// which session it is showing so the sidebar can mark it. Messages are taken only from the parent window
// on this same origin.
import type { SessionSummary } from '@/lib/api'
import { requestSessionJump } from '@/lib/session-jump'

export const EMBEDDED =
  typeof window !== 'undefined' &&
  window.parent !== window &&
  new URLSearchParams(window.location.search).get('embed') === 'desk'

/** Desk asks: show this session. */
interface OpenSession {
  type: 'hdesk:open-session'
  session_id: string
  source: SessionSummary['source']
}

export function listenToDesk(): void {
  if (!EMBEDDED) return
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== window.location.origin || e.source !== window.parent) return
    const m = e.data as Partial<OpenSession> | null
    if (m?.type === 'hdesk:open-session' && typeof m.session_id === 'string' && typeof m.source === 'string')
      requestSessionJump({ session_id: m.session_id, source: m.source })
  })
  // Desk holds a request made before this window loaded until it hears this.
  window.parent.postMessage({ type: 'ah:ready' }, window.location.origin)
}

/** Tell Desk which session the Sessions view shows (null: none). */
export function tellDeskSelected(sessionId: string | null): void {
  if (EMBEDDED) window.parent.postMessage({ type: 'ah:selected', session_id: sessionId }, window.location.origin)
}
