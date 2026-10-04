// Asks the window frame to slide AgentHydra in (DeskFrame listens), from anywhere in the window: the
// cloud list's "Session settings" lives in AgentHydra.
export const OPEN_HYDRA_EVENT = 'hydra-desk:open-hydra'

export function openHydra(): void {
  window.dispatchEvent(new CustomEvent(OPEN_HYDRA_EVENT))
}
