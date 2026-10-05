// What size hint (WINDOW_SIZE_HINT_PARAM, shared/constants.ts) a portable window's URL
// should carry, decided from the Chromium profile the daemon owns. Its one caller is
// the portable-window route (http/core.ts); the hint exists because forwarded `--app`
// launches ignore both `--window-size` and the saved placement, so the page corrects
// itself (web/src/lib/window-size-hint.ts).
//
// Deliberately its own module with no daemon imports, so tests can exercise it against
// a scratch profile without dragging in the runtime/instance config machinery.
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatWindowSizeHint } from "../../shared/constants";
import { appWindowPlacementKey } from "./portable-window.mjs";

/**
 * Below this, a stored rect is treated as junk rather than a size the user chose:
 * Chromium's own drag-resize minimum sits well above it, so real placements never get
 * here, while degenerate rects (zero-area, monitor-reconciliation leftovers) do. Also
 * keeps every emitted hint parseable by parseWindowSizeHint's two-digit floor.
 */
const MIN_REMEMBERED_PX = 50;

/**
 * The placement Chromium has saved for `url`'s window in `profileDir`, or null when
 * nothing usable is stored (fresh profile, unreadable Preferences, zero-area rect).
 *
 * The lookup tries the placement key flat AND as a dotted pref path: Chromium writes
 * preferences by path, so a key containing dots — every focus URL does, the process id
 * is `<projectId>.<localId>` — lands as nested dicts ("localhost_/focus/p1" → {"main":
 * {...}}), not as the flat key its own `GenerateApplicationNameFromURL` produces
 * (observed against Edge 150, 2026-07-16). One consequence Chromium owns, we just
 * survive: sibling ids where one is a dotted prefix of the other ("web" / "web.dev")
 * share a node, so whichever Chromium clobbers degrades here to null → first-run size.
 *
 * `maximized` is Chromium's own flag on the entry (verified present on Edge 150): when
 * true, the rect holds the pre-maximize RESTORE bounds, not the window's real size.
 */
export function rememberedPlacement(
  profileDir: string,
  url: string,
): { width: number; height: number; maximized: boolean } | null {
  const key = appWindowPlacementKey(url);
  if (!profileDir || !key) return null;
  try {
    const prefs = JSON.parse(readFileSync(path.join(profileDir, "Default", "Preferences"), "utf8"));
    const placements = prefs?.browser?.app_window_placement;
    if (!placements || typeof placements !== "object") return null;
    return placementBounds(placementNode(placements, key));
  } catch {
    return null; // no profile yet / corrupt Preferences: same as "nothing remembered"
  }
}

/**
 * The placement entry for `key`. A dotted process id ("web.dev") is stored NESTED, one
 * object per segment; an id without dots sits at the top level as a flat key. Try the
 * flat key first and only then walk the dotted path.
 */
function placementNode(placements: Record<string, unknown>, key: string): unknown {
  const direct = placements[key];
  if (direct !== undefined) return direct;
  return key
    .split(".")
    .reduce<unknown>(
      (n, seg) => (n && typeof n === "object" ? (n as Record<string, unknown>)[seg] : undefined),
      placements,
    );
}

/** A usable rect from a placement node, or null when the fields are missing, non-numeric,
 *  or degenerate (Chromium can leave a 0×0 entry behind). */
function placementBounds(
  node: unknown,
): { width: number; height: number; maximized: boolean } | null {
  const b = node as {
    left?: unknown;
    top?: unknown;
    right?: unknown;
    bottom?: unknown;
    maximized?: unknown;
  };
  if (
    typeof b?.left !== "number" ||
    typeof b.top !== "number" ||
    typeof b.right !== "number" ||
    typeof b.bottom !== "number"
  )
    return null;
  const width = b.right - b.left;
  const height = b.bottom - b.top;
  if (width < MIN_REMEMBERED_PX || height < MIN_REMEMBERED_PX) return null;
  return { width, height, maximized: b.maximized === true };
}

/**
 * The WINDOW_SIZE_HINT_PARAM value to send for a window about to be opened at `url`,
 * or null to send NO hint. One decision, all in one place:
 *
 * - The user left this window MAXIMIZED → null. The saved rect is only the restore
 *   bounds; hinting it would make the page resizeTo() a maximized window back down —
 *   visibly un-maximizing a window the user deliberately maximized. With no hint,
 *   a fresh launch restores the maximized state natively and a forwarded launch is
 *   left alone (Chromium gives us no way to maximize from the page).
 * - The user has a real remembered size → that size (a forwarded launch inherits a
 *   sibling's geometry, so the page must know the size THIS window should have).
 * - Nothing usable remembered → the measured first-run size.
 */
export function windowSizeHintFor(
  profileDir: string,
  url: string,
  initialSize: { width: number; height: number },
): string | null {
  const placement = rememberedPlacement(profileDir, url);
  if (placement?.maximized) return null;
  return formatWindowSizeHint(placement ?? initialSize);
}
