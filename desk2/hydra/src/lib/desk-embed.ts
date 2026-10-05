// Hydra Desk 2: this copy of AgentHydra's window runs inside Desk 2, in a frame at /ah/?embed=desk. It has
// no Sessions tab (Michael, 2026-10-04): Desk's cloud list is the session list and Desk's own view shows a
// session, with AgentHydra's session header over it. So "open this chat" (the Instances move dialog, the
// landing page's session tiles) is asked of Desk, which slides back and opens it. Messages go only to the
// parent window on this same origin; their shapes are desk2/shared/hydra-embed.ts.
//
// Desk also owns the one sidebar (Michael, 2026-10-04: "we only have two things, the sidebar and the
// content"): a tab that had a sidebar of its own (CliMayte, HSwarm) describes it with useDeskSidebar and
// hides its own, Desk draws it, and Desk's clicks on it come back here to that tab. Desk can also ask
// for an account's row in Instances (its session header's account chip) or a CliMayte task (its sidebar's
// task rows).
import { onScopeDispose, ref, watch } from 'vue'
import type { AhMessage, DeskMessage, SidebarModel } from '@desk/shared/hydra-embed'
import type { SessionJump } from '@/lib/session-jump'

export const EMBEDDED =
  typeof window !== 'undefined' &&
  window.parent !== window &&
  new URLSearchParams(window.location.search).get('embed') === 'desk'

function tellDesk(message: AhMessage): void {
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

export type SidebarEvent = Extract<DeskMessage, { type: 'desk:sidebar' }>

const sidebarHandlers = new Map<string, (e: SidebarEvent) => void>()
// What Desk was last sent, so a rebuild that changed nothing it shows sends nothing.
let lastSent = ''

/** The current tab's sidebar to Desk, or null for a tab without one (App.vue, on a change of tab). */
export function publishSidebar(model: SidebarModel | null): void {
  if (!EMBEDDED) return
  const json = JSON.stringify(model)
  if (json === lastSent) return
  lastSent = json
  tellDesk({ type: 'ah:sidebar', model })
}

/** In Desk: describes this tab's sidebar (`build` re-runs when what it reads changes) and takes Desk's
 *  clicks on it. Outside Desk it does nothing and the tab draws its own sidebar. The tab after it sends
 *  its own (or App.vue sends null), so leaving sends nothing: Desk never flashes another list between. */
export function useDeskSidebar(
  view: string,
  build: () => SidebarModel | null,
  onEvent: (e: SidebarEvent) => void,
): void {
  if (!EMBEDDED) return
  sidebarHandlers.set(view, onEvent)
  watch(build, publishSidebar, { immediate: true })
  onScopeDispose(() => {
    if (sidebarHandlers.get(view) === onEvent) sidebarHandlers.delete(view)
  })
}

/** Desk asked for an instance's row in Instances (App.vue switches tab and marks it). */
export const deskInstanceAsk = ref<{ num: number; kind: 'desktop' | 'cli' } | null>(null)
/** Desk asked for a CliMayte task (CliMayteView opens it once its list is in). */
export const deskWorkerAsk = ref<string | null>(null)

/** The row of instance #num once the tab shows it, or null after `ms`. */
export async function findInstanceRow(num: number, ms: number): Promise<HTMLElement | null> {
  const end = Date.now() + ms
  for (;;) {
    const el = document.querySelector<HTMLElement>(`[data-instance-num="${num}"]`)
    if (el || Date.now() >= end) return el
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Scrolls a row into the middle and rings it for two seconds (style.css .desk-flash). */
export function flashRow(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('desk-flash')
  void el.offsetWidth
  el.classList.add('desk-flash')
  setTimeout(() => el.classList.remove('desk-flash'), 2200)
}

if (EMBEDDED) {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return
    const m = e.data as DeskMessage | null
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
    if (m.type === 'desk:sidebar') sidebarHandlers.get(m.view)?.(m)
    else if (m.type === 'desk:show-instance') deskInstanceAsk.value = { num: m.num, kind: m.kind }
    else if (m.type === 'desk:open-worker') deskWorkerAsk.value = m.id
  })
  tellDesk({ type: 'ah:ready' })
}
