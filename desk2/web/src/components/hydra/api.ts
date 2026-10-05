// Hydra Desk 2's AgentHydra side, shared across the window: whether it is open (DeskFrame slides it in).
// The pane is Desk 2's own copy of AgentHydra's window (desk2/hydra at /ah/); while it is open the
// sidebar is the cloud list, and a session clicked there (or asked for by the copy) opens in Desk's own view.
import { ref } from 'vue'

export const OPEN_HYDRA_EVENT = 'hydra-desk:open-hydra'

/** Asks the window frame to slide AgentHydra in, from anywhere in the window (the cloud list's "Session
 *  settings" lives in AgentHydra). */
export function openHydra(): void {
  window.dispatchEvent(new CustomEvent(OPEN_HYDRA_EVENT))
}

export const hydraOpen = ref(false)
