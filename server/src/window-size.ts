// What size hint a portable window's URL should carry (the `?window-size=WxH` param the
// quick-instances window's opener appends), decided from the Chromium profile the daemon owns.
// The hint exists because a forwarded `--app` launch (a window already open on the profile)
// ignores both `--window-size` and the saved placement, so the page corrects itself
// (desk2/hydra/src/lib/window-size-hint.ts). Its one caller is instance-mode-window.ts.
//
// The param name and the "WxH" shape are a contract shared with the web applier and the
// tray (misc/Tray-Host.ps1) — keep the three in step. Deliberately its own module with no
// daemon imports, so tests can exercise it against a scratch profile without dragging in the
// runtime/instance config machinery.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { appWindowPlacementKey } from './portable-window.mjs'

/** The URL query param carrying a portable window's intended outer size, as `"<w>x<h>"`. */
export const WINDOW_SIZE_HINT_PARAM = 'window-size'

/** Serialize a size for {@link WINDOW_SIZE_HINT_PARAM}: `{840,760}` → `"840x760"`. */
export function formatWindowSizeHint(size: { width: number; height: number }): string {
  return `${Math.round(size.width)}x${Math.round(size.height)}`
}

/**
 * Below this, a stored rect is treated as junk rather than a size the user chose:
 * Chromium's own drag-resize minimum sits well above it, so real placements never get here,
 * while degenerate rects (zero-area, monitor-reconciliation leftovers) do. Also keeps every
 * emitted hint parseable by the page's two-digit floor.
 */
const MIN_REMEMBERED_PX = 50

/**
 * The placement Chromium has saved for `url`'s window in `profileDir`, or null when nothing
 * usable is stored (fresh profile, unreadable Preferences, zero-area rect).
 *
 * The lookup tries the placement key flat AND as a dotted pref path: Chromium writes
 * preferences by path, so a key containing dots lands as nested dicts, not as the flat key
 * its own `GenerateApplicationNameFromURL` produces (observed against Edge 150, 2026-07-16).
 *
 * `maximized` is Chromium's own flag on the entry: when true, the rect holds the
 * pre-maximize RESTORE bounds, not the window's real size.
 */
export function rememberedPlacement(
  profileDir: string,
  url: string,
): { width: number; height: number; maximized: boolean } | null {
  const key = appWindowPlacementKey(url)
  if (!profileDir || !key) return null
  try {
    const prefs = JSON.parse(readFileSync(path.join(profileDir, 'Default', 'Preferences'), 'utf8'))
    const placements = prefs?.browser?.app_window_placement
    if (!placements || typeof placements !== 'object') return null
    let node: unknown = placements[key]
    if (node === undefined) {
      node = key
        .split('.')
        .reduce<unknown>(
          (n, seg) =>
            n && typeof n === 'object' ? (n as Record<string, unknown>)[seg] : undefined,
          placements,
        )
    }
    const b = node as {
      left?: unknown
      top?: unknown
      right?: unknown
      bottom?: unknown
      maximized?: unknown
    }
    if (
      typeof b?.left !== 'number' ||
      typeof b.top !== 'number' ||
      typeof b.right !== 'number' ||
      typeof b.bottom !== 'number'
    )
      return null
    const width = b.right - b.left
    const height = b.bottom - b.top
    if (width < MIN_REMEMBERED_PX || height < MIN_REMEMBERED_PX) return null
    return { width, height, maximized: b.maximized === true }
  } catch {
    return null // no profile yet / corrupt Preferences: same as "nothing remembered"
  }
}

/**
 * The WINDOW_SIZE_HINT_PARAM value to send for a window about to be opened at `url`, or null
 * to send NO hint. One decision, all in one place:
 *
 * - The user left this window MAXIMIZED → null. The saved rect is only the restore bounds;
 *   hinting it would make the page resizeTo() a maximized window back down. A fresh launch
 *   restores the maximized state natively and a forwarded launch is left alone.
 * - The user has a real remembered size → that size (a forwarded launch inherits a sibling's
 *   geometry, so the page must know the size THIS window should have).
 * - Nothing usable remembered → the measured first-run size.
 */
export function windowSizeHintFor(
  profileDir: string,
  url: string,
  initialSize: { width: number; height: number },
): string | null {
  const placement = rememberedPlacement(profileDir, url)
  if (placement?.maximized) return null
  return formatWindowSizeHint(placement ?? initialSize)
}
