// Hydra Desk 2's AgentHydra side, shared across the window: whether it is open (DeskFrame slides it in), the
// sidebar its current tab describes (drawn in Desk's own sidebar while it is open), and what Desk says to
// it. The pane is Desk 2's own copy of AgentHydra's window (desk2/hydra at /ah/); the messages both ways
// are in shared/hydra-embed.ts. A session clicked anywhere opens in Desk's own view.
import { computed, ref, shallowRef } from 'vue'
import type { DeskMessage, SidebarModel } from '@shared/hydra-embed'

export const OPEN_HYDRA_EVENT = 'hydra-desk:open-hydra'

/** Asks the window frame to slide AgentHydra in, from anywhere in the window (the cloud list's "Session
 *  settings" lives in AgentHydra). */
export function openHydra(): void {
  window.dispatchEvent(new CustomEvent(OPEN_HYDRA_EVENT))
}

export const hydraOpen = ref(false)

// A newer AgentHydra is waiting (the pane's ah:update-dot): a dot on the sidebar's Settings gear, the door to
// Settings → Updates, as the pane's own gear had before it went (owner, 2026-10-06). A click on the gear
// with the dot on opens Updates and quiets it for the rest of this run; the next launch shows it again.
const updateWaiting = ref(false)
const updateDotSeen = ref(false)
export const ahUpdateDot = computed(() => updateWaiting.value && !updateDotSeen.value)
export function setAhUpdateWaiting(on: boolean): void {
  updateWaiting.value = on
}
export function seeAhUpdateDot(): void {
  updateDotSeen.value = true
}

/** The current tab's sidebar, or null when that tab has none (or the frame is not up). */
export const hydraSidebar = shallowRef<SidebarModel | null>(null)
// Whether the pane has said anything about its sidebar yet (a null counts: that tab has none). Until it
// has, the pane's remembered tab decides what is drawn, so opening on HSwarm never flashes the cloud list.
const hydraSidebarKnown = ref(false)
// Whether a frame is attached: with none (daemon down, never started) nothing will ever describe a sidebar.
const hydraFrameUp = ref(false)

// The pane's remembered tab (hydra/src/lib/app-view.ts) and the tabs that have a sidebar of their own.
const PANE_VIEW_KEY = 'agenthydra.app.view'
const KEPT_PREFIX = 'hydra-desk2.hydra-sidebar.'
const OWN_SIDEBAR: Record<string, { title: string; icon: SidebarModel['icon'] }> = {
  hswarm: { title: 'HSwarm', icon: 'network' }
}

// A copy of the renames in hydra/src/lib/app-view.ts (RENAMED_VIEWS; desk2/web cannot import from hydra/).
const RENAMED_VIEWS: Record<string, string> = { corch: 'cli', instances: 'desktop', sessions: 'hswarm', climayte: 'hswarm' }

/** The tab the pane will open on, as app-view.ts decides: its own window's sessionStorage first, then the
 *  durable localStorage value, each through the renames. Only tabs with a sidebar matter here, so an
 *  unreadable value is skipped like a missing one. */
export function resolvePaneView(session: string | null, durable: string | null): string | null {
  for (const raw of [session, durable]) {
    if (raw == null) continue
    const v = Object.hasOwn(RENAMED_VIEWS, raw) ? RENAMED_VIEWS[raw] : raw
    if (v) return v
  }
  return null
}

function readKept(view: string): SidebarModel | null {
  try {
    const m = JSON.parse(localStorage.getItem(KEPT_PREFIX + view) ?? 'null') as SidebarModel | null
    return m && m.view === view && Array.isArray(m.sections) ? m : null
  } catch {
    return null
  }
}

/** What Desk's sidebar draws for AgentHydra: the live model; before the pane has spoken, the kept tree of
 *  its remembered tab (stale), or that tab's empty shape; `null` is the cloud list (a tab without a
 *  sidebar of its own keeps it). Plain so the choice is testable. */
export function pickHydraSidebar(
  live: SidebarModel | null,
  known: boolean,
  frameUp: boolean,
  rememberedView: string | null,
  kept: (view: string) => SidebarModel | null
): { model: SidebarModel; stale: boolean } | null {
  if (known) return live ? { model: live, stale: false } : null
  if (!frameUp) return null
  const own = rememberedView ? OWN_SIDEBAR[rememberedView] : undefined
  if (!rememberedView || !own) return null
  const model = kept(rememberedView)
  return { model: model ?? { view: rememberedView, title: own.title, icon: own.icon, sections: [] }, stale: true }
}

/** What Sidebar draws while AgentHydra is open, and whether it is the kept tree not yet replaced (inert). */
export const hydraShown = computed(() => {
  if (!hydraOpen.value) return null
  let session: string | null = null
  let durable: string | null = null
  try {
    session = sessionStorage.getItem(PANE_VIEW_KEY)
  } catch {
    // blocked: the durable value
  }
  try {
    durable = localStorage.getItem(PANE_VIEW_KEY)
  } catch {
    // no storage: the cloud list
  }
  return pickHydraSidebar(hydraSidebar.value, hydraSidebarKnown.value, hydraFrameUp.value, resolvePaneView(session, durable), readKept)
})

/** HydraPane: the pane's current sidebar (null for a tab without one). Each tree replaces the one kept for
 *  its tab, so the next open draws it at once. */
export function setHydraSidebar(model: SidebarModel | null): void {
  hydraSidebar.value = model
  hydraSidebarKnown.value = true
  if (!model) return
  try {
    localStorage.setItem(KEPT_PREFIX + model.view, JSON.stringify(model))
  } catch {
    // full or blocked: nothing kept
  }
}

// The frame, and what was said to it before it was listening (the first open loads it).
let frame: Window | null = null
let ready = false
const held: DeskMessage[] = []
// Whether the pane is in view: the frame stays loaded behind the chat, and out of view its polls rest.
let visible = false

/** HydraPane: a frame was (re)created, or went away. Its sidebar is gone until it describes one again.
 *  The same frame again changes nothing: dropping its sidebar then would leave Desk with none, since a
 *  frame that is already listening never says ah:ready again. */
export function attachHydraFrame(win: Window | null): void {
  if (win === frame) return
  frame = win
  ready = false
  hydraSidebar.value = null
  hydraSidebarKnown.value = false
  hydraFrameUp.value = win !== null
}

/** HydraPane: the frame said ah:ready (it loaded, or reloaded in place). It is told whether it is in
 *  view, and on desk:visible true it sends its current sidebar again, so what Desk holds is never one
 *  from before (lib/desk-embed.ts in the copy). */
export function hydraReady(win: Window): void {
  frame = win
  ready = true
  win.postMessage({ type: 'desk:visible', visible } satisfies DeskMessage, window.location.origin)
  for (const m of held.splice(0)) win.postMessage(m, window.location.origin)
}

/** HydraPane: the pane slid in or out. Only the latest counts, so it is never held. Sliding in, the copy
 *  answers with its current sidebar (desk:visible true), whatever Desk held while it was away. */
export function setHydraVisible(v: boolean): void {
  if (v === visible) return
  visible = v
  if (ready && frame) frame.postMessage({ type: 'desk:visible', visible } satisfies DeskMessage, window.location.origin)
}

export function tellHydra(message: DeskMessage): void {
  if (ready && frame) frame.postMessage(message, window.location.origin)
  else held.push(message)
}

/** Slides AgentHydra in on an instance's row in Instances, its desktop or CLI table, marked. */
export function showInstanceInHydra(num: number, kind: 'desktop' | 'cli'): void {
  tellHydra({ type: 'desk:show-instance', num, kind })
  openHydra()
}

/** Slides AgentHydra in on the HSwarm tab, on that job of its Jobs node when one is named. */
export function openSwarmInHydra(job?: string): void {
  tellHydra({ type: 'desk:open-hswarm', job })
  openHydra()
}

/** Slides AgentHydra in on a CliMayte task, open on the CliMayte node of the HSwarm tab; `pc` for another PC's. */
export function openWorkerInHydra(id: string, pc?: string | null): void {
  tellHydra(pc ? { type: 'desk:open-worker', id, pc } : { type: 'desk:open-worker', id })
  openHydra()
}
