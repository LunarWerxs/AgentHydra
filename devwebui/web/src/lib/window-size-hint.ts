// Applies the daemon's window-size hint (see WINDOW_SIZE_HINT_PARAM in
// shared/constants.ts): when a portable window is launched while another window on the
// profile is already open, Chromium forwards the launch into the running instance and
// the new window inherits THAT window's geometry — --window-size and the saved
// placement are both ignored (verified Edge 150, 2026-07-16). The daemon can't stop
// that from outside, so it tags the URL with the size the window should have and the
// page fixes itself here, once, at startup.
import { WINDOW_SIZE_HINT_PARAM, parseWindowSizeHint } from "../constants";

/**
 * Resize this window to the daemon's hint, then strip the param from the address so a
 * reload or copied URL doesn't carry it (cosmetic only — the query string is not part
 * of Chromium's geometry key, and the placement slot was fixed at window creation).
 *
 * Gated to real `--app` windows via `display-mode: standalone`: in a normal browser
 * tab resizeTo would be a popup-blocked no-op at best and a whole-browser resize at
 * worst, and a tab has no business obeying a size a URL told it. The resize saves onto
 * this window's OWN placement slot (verified 2026-07-16), so from then on Chromium
 * itself remembers the corrected size.
 */
export function applyWindowSizeHint(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(WINDOW_SIZE_HINT_PARAM)) return;
  const hint = parseWindowSizeHint(params.get(WINDOW_SIZE_HINT_PARAM));
  if (
    hint &&
    window.matchMedia("(display-mode: standalone)").matches &&
    (window.outerWidth !== hint.width || window.outerHeight !== hint.height)
  ) {
    window.resizeTo(hint.width, hint.height);
    // A forwarded launch inherits a SIBLING's position, so growing from there can push
    // past the monitor's edge (a launcher parked bottom-right spawns a mostly-offscreen
    // dashboard). Clamp back inside THIS monitor's available area — availLeft/availTop
    // keep the correction on the window's own monitor rather than yanking it to the
    // primary. Only after an actual resize: an untouched window is never repositioned.
    const s = window.screen as Screen & { availLeft?: number; availTop?: number };
    const minX = s.availLeft ?? 0;
    const minY = s.availTop ?? 0;
    const maxX = Math.max(minX, minX + s.availWidth - hint.width);
    const maxY = Math.max(minY, minY + s.availHeight - hint.height);
    const x = Math.min(Math.max(window.screenX, minX), maxX);
    const y = Math.min(Math.max(window.screenY, minY), maxY);
    if (x !== window.screenX || y !== window.screenY) window.moveTo(x, y);
  }
  params.delete(WINDOW_SIZE_HINT_PARAM);
  const qs = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
  );
}
