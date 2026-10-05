export interface ChromiumBrowser {
  /** Short identifier: "msedge", "chrome", "chromium", ... */
  name: string;
  /** Absolute path of the executable. */
  path: string;
}

export type PortableWindowResult =
  | { ok: true; browser: string }
  | { ok: false; reason: "no-browser" | "spawn-failed" };

/**
 * Locate a Chromium-family browser that can host an `--app=` window.
 * Returns null when none is installed.
 */
export function resolveChromiumBrowser(): ChromiumBrowser | null;

/** The `(command, args, detached)` used to spawn the window so it escapes the daemon's tree. */
export interface PortableSpawn {
  command: string;
  args: string[];
  detached: boolean;
}

/**
 * Build the spawn command for the window so it OUTLIVES the daemon (a tray Quit / auto-update
 * relaunch tree-kills the daemon). On win32 it goes through a WMI `Win32_Process.Create` hand-off,
 * falling back to a PowerShell `Start-Process` (a hand-off is the only reliable Windows detach;
 * `.unref()`/`detached:true` do not break the process tree); POSIX spawns the browser directly with
 * `detached:true`. Pure + exported for unit tests.
 */
export function buildPortableSpawn(
  platform: NodeJS.Platform,
  browserPath: string,
  browserArgs: string[],
): PortableSpawn;

/** Outer window size in device pixels (what Chromium's `--window-size` sets). */
export interface WindowSize {
  width: number;
  height: number;
}

/**
 * Chromium's key for a saved app-window placement (`host + "_" + path`). NOTE it carries
 * neither the port nor the query string, so windows differing only by `?query=` share one
 * saved geometry — vary the PATH to give a window its own. Null for an unparseable URL.
 */
export function appWindowPlacementKey(url: string): string | null;

/**
 * True when Chromium has already stored bounds for this window in `profileDir` — i.e. the
 * user has moved or resized it. False for a never-opened window, an unreadable profile, or
 * a size we merely imposed via `--window-size` (Chromium does not persist those).
 * Handles both storage forms: the flat key, and the nested dicts Chromium writes a dotted
 * key as (prefs go by dotted path: `localhost_/focus/p1.main` lands under
 * `["localhost_/focus/p1"]["main"]`).
 */
export function hasRememberedBounds(profileDir: string | undefined, url: string): boolean;

export interface PortableWindowOptions {
  /**
   * Dedicated Chromium profile dir for the window (`--user-data-dir`), so the
   * app window remembers its own size/position across launches. Family
   * convention: `<configDir>/portable-profile`, a sibling of runtime.json.
   */
  profileDir?: string;
  /**
   * First-run geometry: the size to open a window Chromium has never seen. Ignored once
   * the user has sized the window themselves, so their resize is never undone. Omit to
   * take Chromium's default, which is close to the full work area.
   */
  initialSize?: WindowSize;
}

/**
 * Open `url` in a detached chromeless app window (`--app=url`). Best-effort:
 * resolves with `{ ok: false }` instead of throwing when no browser is found
 * or the spawn fails.
 */
export function openPortableWindow(url: string, opts?: PortableWindowOptions): Promise<PortableWindowResult>;
