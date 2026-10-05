// ---------------------------------------------------------------------------
// Single source of truth for the daemon's network + buffering defaults. The
// daemon is authoritative; other surfaces (MCP client, Vite dev proxy, GUI log
// buffer) are documented to match these. Override the port with DEVWEBUI_PORT.
//
// This module is imported from BOTH the Bun daemon (which has @types/node) and
// the web bundle (which deliberately doesn't pull in Node's ambient types — see
// web/tsconfig.app.json). daemonPort()/daemonUrl() read `process.env`, so they
// reach it through a locally-typed `nodeGlobal` cast of `globalThis` rather than
// the ambient Node global, keeping the file typecheckable — and side-effect-free
// at module scope — on both sides. Neither function is ever called from web code.
// ---------------------------------------------------------------------------
type NodeGlobal = { process?: { env: Record<string, string | undefined> } };
const nodeGlobal = globalThis as NodeGlobal;

/** Default port the daemon (REST + SSE + built GUI) listens on. */
export const DEFAULT_DAEMON_PORT = 4000;

/** Resolve the daemon port from the environment, falling back to the default. */
export function daemonPort(): number {
  return Number(nodeGlobal.process?.env.DEVWEBUI_PORT) || DEFAULT_DAEMON_PORT;
}

/** Base URL the MCP client uses to reach the daemon (override with DEVWEBUI_URL). */
export function daemonUrl(): string {
  return nodeGlobal.process?.env.DEVWEBUI_URL || `http://localhost:${daemonPort()}`;
}

/**
 * Per-process log ring-buffer cap. The daemon owns this; the GUI keeps its own
 * SSE-accumulated buffer at the same size (see web/src/store.ts MAX_LOG_LINES).
 */
export const MAX_LOG_LINES = 500;

/**
 * URL prefix of the single-process focus view a desktop shortcut opens
 * (`/focus/<projectId>.<localId>`), served by the SPA fallback in http/index.ts.
 *
 * It is a PATH and not a query param (`/?process=<id>`, which is what this was until
 * 2026-07-15) for one concrete reason: Chromium keys a saved app-window placement by
 * host + path ONLY — the query string is not part of the key. Under `?process=` every
 * focus window and the dashboard shared the single `localhost_/` geometry slot, so no
 * focus window could keep its own size and sizing one silently resized the others. One
 * path per process gives each window its own remembered geometry.
 */
export const FOCUS_PATH_PREFIX = "/focus/";

/** The focus view's URL for a global process id (`<projectId>.<localId>`). */
export function focusPath(processId: string): string {
  return `${FOCUS_PATH_PREFIX}${encodeURIComponent(processId)}`;
}

/** The global process id in a focus URL's path, or null when it isn't one. */
export function processIdFromFocusPath(pathname: string): string | null {
  if (!pathname.startsWith(FOCUS_PATH_PREFIX)) return null;
  const raw = pathname.slice(FOCUS_PATH_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null; // malformed %-escape: the literal is still a better guess than nothing
  }
}

/**
 * First-run size of the focus window (outer pixels, what Chromium's `--window-size` takes).
 * Only applies until the user resizes it themselves — see the kit's openPortableWindow.
 *
 * Measured against the real view rather than guessed. The window renders ONE ProcessCard in
 * its `compact` launcher density: header 33 + 20 padding + card 92 + footer 33 = 178px of
 * content, which a 440x220 outer window fits exactly (a 424x178 viewport — Chromium draws
 * its own title bar inside the client area, so outer height = content + ~34 title + ~8
 * frame). Verified at that size: no scrolling, and the longest process name in a real
 * project still doesn't truncate. Chromium's own default for a window it has never seen is
 * close to the full work area (~1905x2092 on a 4K display), which is why this exists at all.
 *
 * Keep it hugging the content: dead space between the card and the Close bar is the exact
 * thing this window kept getting wrong. If the card grows a row, re-measure — don't pad.
 */
export const FOCUS_WINDOW_SIZE = { width: 440, height: 220 };

/**
 * First-run size of the dashboard window (outer pixels), for when the daemon opens `/`
 * as its own portable window — the launcher's "Open dashboard" button and the Settings
 * portable-mode toggle both land here. Without it, a window Chromium has never seen
 * opens at ~the whole work area (1905x2092 on a 4K display), which is the opposite
 * failure from the launcher's: comically large instead of uselessly small.
 *
 * Measured against the real dashboard (Edge 150, 2026-07-16), not guessed. Width: the
 * layout hard-caps content at `--container-max` = 800px (web/src/styles/kit-base.css),
 * so anything wider is dead margin — 800px container + 15px scrollbar = 824px viewport,
 * i.e. 840 outer. Height is a density pick, not a content hug (the dashboard scrolls):
 * a 718px viewport fits the 56px top bar, a project heading, the 40px table header and
 * 13 full 41px process rows against a real ~25-process dashboard — 760 outer. Same
 * outer-vs-viewport arithmetic as FOCUS_WINDOW_SIZE (outer = viewport + ~16 frame
 * width + ~34 title + ~8 frame height; Chromium draws its title bar inside the client
 * area).
 *
 * First-run only, like FOCUS_WINDOW_SIZE: `/` has its own Chromium geometry slot, so
 * the user's own resize is remembered per-window and wins from then on.
 */
export const DASHBOARD_WINDOW_SIZE = { width: 840, height: 760 };

/**
 * Query param the daemon appends to a portable window's URL, carrying the outer size
 * ("<width>x<height>") the window SHOULD have. It exists because `--window-size` and
 * even the slot's own saved placement are both IGNORED when a Chromium instance on the
 * profile is already running: the forwarded `--app` launch just inherits the existing
 * window's geometry (verified Edge 150, 2026-07-16). The launcher's "Open dashboard"
 * button always hits that case — the launcher itself is the running instance — so the
 * page corrects itself with `window.resizeTo` (web/src/lib/window-size-hint.ts).
 *
 * Safe by fact, not hope: Chromium keys saved app-window geometry by host + path ONLY,
 * so a query param can never re-key a window or perturb another window's slot — and a
 * resize made by the page saves onto the window's OWN slot (both verified 2026-07-16).
 */
export const WINDOW_SIZE_HINT_PARAM = "window-size";

/** Serialize a size for {@link WINDOW_SIZE_HINT_PARAM}: `{840,760}` → `"840x760"`. */
export function formatWindowSizeHint(size: { width: number; height: number }): string {
  return `${Math.round(size.width)}x${Math.round(size.height)}`;
}

/**
 * Parse a {@link WINDOW_SIZE_HINT_PARAM} value back into a size, or null for anything
 * that isn't a sane "WxH" — the page calls `window.resizeTo` with this, so a mangled
 * or hand-edited URL must degrade to "no hint", never to a bizarre window.
 */
export function parseWindowSizeHint(
  value: string | null,
): { width: number; height: number } | null {
  if (!value) return null;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}
