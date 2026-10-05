// Hydra Desk 2's AgentHydra side, shared across the window: whether it is open (DeskFrame slides it in), the
// sidebar its current tab describes (drawn in Desk's own sidebar while it is open), and what Desk says to
// it. The pane is Desk 2's own copy of AgentHydra's window (desk2/hydra at /ah/); the messages both ways
// are in shared/hydra-embed.ts. A session clicked anywhere opens in Desk's own view.
import { ref, shallowRef } from 'vue'
import type { DeskMessage, SidebarModel } from '@shared/hydra-embed'

export const OPEN_HYDRA_EVENT = 'hydra-desk:open-hydra'

/** Asks the window frame to slide AgentHydra in, from anywhere in the window (the cloud list's "Session
 *  settings" lives in AgentHydra). */
export function openHydra(): void {
  window.dispatchEvent(new CustomEvent(OPEN_HYDRA_EVENT))
}

export const hydraOpen = ref(false)

/** The current tab's sidebar, or null when that tab has none (or the frame is not up). */
export const hydraSidebar = shallowRef<SidebarModel | null>(null)

// The frame, and what was said to it before it was listening (the first open loads it).
let frame: Window | null = null
let ready = false
const held: DeskMessage[] = []

/** HydraPane: a frame was (re)created, or went away. Its sidebar is gone until it describes one again. */
export function attachHydraFrame(win: Window | null): void {
  frame = win
  ready = false
  hydraSidebar.value = null
}

/** HydraPane: the frame said ah:ready. */
export function hydraReady(): void {
  ready = true
  for (const m of held.splice(0)) frame?.postMessage(m, window.location.origin)
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

/** Slides AgentHydra in on a CliMayte task, open on the CliMayte tab. */
export function openWorkerInHydra(id: string): void {
  tellHydra({ type: 'desk:open-worker', id })
  openHydra()
}
