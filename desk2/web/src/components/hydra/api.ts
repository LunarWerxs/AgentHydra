// Hydra Desk 2's AgentHydra side, shared across the window: whether it is open (DeskFrame slides it in),
// the session the sidebar asked it to show, and the one it reports showing. The pane is Desk 2's own copy
// of AgentHydra's window (desk2/hydra at /ah/); while it is open the sidebar is its session list.
import { ref } from 'vue'

export const OPEN_HYDRA_EVENT = 'hydra-desk:open-hydra'

/** Asks the window frame to slide AgentHydra in, from anywhere in the window (the cloud list's "Session
 *  settings" lives in AgentHydra). */
export function openHydra(): void {
  window.dispatchEvent(new CustomEvent(OPEN_HYDRA_EVENT))
}

export const hydraOpen = ref(false)

/** The sidebar's newest ask; `n` makes asking for the same session again a new ask. */
export const hydraAsk = ref<{ id: string; source: string; n: number } | null>(null)

/** The session AgentHydra's Sessions view says it shows, for the sidebar to mark. */
export const hydraShowing = ref<string | null>(null)

export function openInHydra(id: string, source: string): void {
  hydraAsk.value = { id, source, n: (hydraAsk.value?.n ?? 0) + 1 }
}
