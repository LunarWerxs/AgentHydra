// Applies the launcher's window-size hint: the `?window-size=WxH` param the daemon and the
// tray append to a portable window's URL. When a portable window is launched while another
// window on the profile is already open, Chromium FORWARDS the launch into the running
// instance and the new window inherits THAT window's geometry — `--window-size` and the
// saved placement are both ignored (verified Edge 150, 2026-07-16). Nothing outside the page
// can fix that, so the launcher tags the URL with the size the window should have and the
// page corrects itself here, once, at startup.
//
// The param name and the "WxH" shape are a contract shared with the daemon
// (server/src/window-size.ts) and the tray (misc/Tray-Host.ps1) — keep the three in step.
// AgentHydra has no web+server shared module, so the literal and the parser live here too
// rather than being imported (the daemon holds its own copies).
const WINDOW_SIZE_HINT_PARAM = 'window-size'

function parseWindowSizeHint(value: string | null): { width: number; height: number } | null {
  if (!value) return null
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(value)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Resize this window to the hint, then strip the param from the address so a reload or a
 * copied URL doesn't carry it (cosmetic only — the query string is not part of Chromium's
 * geometry key, and the placement slot was fixed at window creation).
 *
 * Gated to real `--app` windows via `display-mode: standalone`: in a normal browser tab
 * `resizeTo` would be a popup-blocked no-op at best and a whole-browser resize at worst, and
 * a tab has no business obeying a size a URL told it. The resize saves onto this window's OWN
 * placement slot, so from then on Chromium itself remembers the corrected size.
 */
export function applyWindowSizeHint(): void {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(WINDOW_SIZE_HINT_PARAM)) return
  const hint = parseWindowSizeHint(params.get(WINDOW_SIZE_HINT_PARAM))
  if (
    hint &&
    window.matchMedia('(display-mode: standalone)').matches &&
    (window.outerWidth !== hint.width || window.outerHeight !== hint.height)
  ) {
    window.resizeTo(hint.width, hint.height)
    // A forwarded launch inherits a SIBLING's position, so growing from there can push past
    // the monitor's edge (a launcher parked bottom-right spawns a mostly-offscreen window).
    // Clamp back inside THIS monitor's available area — availLeft/availTop keep the correction
    // on the window's own monitor rather than yanking it to the primary. Only after an actual
    // resize: an untouched window is never repositioned.
    const s = window.screen as Screen & { availLeft?: number; availTop?: number }
    const minX = s.availLeft ?? 0
    const minY = s.availTop ?? 0
    const maxX = Math.max(minX, minX + s.availWidth - hint.width)
    const maxY = Math.max(minY, minY + s.availHeight - hint.height)
    const x = Math.min(Math.max(window.screenX, minX), maxX)
    const y = Math.min(Math.max(window.screenY, minY), maxY)
    if (x !== window.screenX || y !== window.screenY) window.moveTo(x, y)
  }
  params.delete(WINDOW_SIZE_HINT_PARAM)
  const qs = params.toString()
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
  )
}
