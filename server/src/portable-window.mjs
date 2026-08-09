/**
 * Shared "portable window" opener for the LunarWerx daemons. Opens the app's UI in a
 * chromeless Chromium app window (`msedge --app=URL`, falling back to Chrome) so the
 * app presents as its own desktop window instead of a browser tab. Each app exposes
 * this through a POST /api/portable-window route; the tray launchers implement the
 * same resolve-and-fallback chain in PowerShell for cold starts (before the daemon,
 * and therefore this lib, is running).
 *
 * The window is a real, separate OS browser process that must OUTLIVE this daemon: an
 * auto-update relaunch of the daemon (or a tray Quit) must leave the window up, and its
 * SSE reconnects once the successor rebinds the port. The daemon's tray Quits by force
 * tree-killing the daemon (`taskkill /PID <daemon> /T /F`), and an auto-update relaunch
 * kills+respawns it the same way, so the window must NOT be a descendant of the daemon.
 * On Windows neither `.unref()` nor `detached:true` removes a child from the parent's
 * process tree (verified 2026-07-12), so the launch goes through a `cmd /c start ""`
 * hand-off (buildPortableSpawn) that re-parents the browser out of the tree; POSIX uses
 * `detached:true` (a real setsid detach).
 *
 * Runtime-agnostic (Bun + Node). Synced from the shared kit, do not edit in an
 * app; the `.d.mts` sibling types the import for the TypeScript apps.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { buildDetachedSpawn } from "./detached-spawn.mjs";

/**
 * Candidate Chromium executables, most-preferred first. Edge leads on Windows
 * (preinstalled on every supported Windows; Chrome may be absent), Chrome elsewhere
 * by ubiquity. Only Chromium browsers understand `--app=`; Firefox has no equivalent.
 */
function candidates() {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    const list = [
      { name: "msedge", path: join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "msedge", path: join(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "chrome", path: join(pf, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "chrome", path: join(pf86, "Google", "Chrome", "Application", "chrome.exe") },
    ];
    if (local) list.push({ name: "chrome", path: join(local, "Google", "Chrome", "Application", "chrome.exe") });
    return list;
  }
  if (process.platform === "darwin") {
    return [
      { name: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "msedge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
  }
  // Linux: resolve the usual binary names against PATH ourselves, so the caller
  // still gets a definite "found it" / "no browser" answer instead of an async
  // ENOENT out of spawn().
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const names = ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"];
  const list = [];
  for (const name of names) {
    for (const dir of dirs) list.push({ name, path: join(dir, name) });
  }
  return list;
}

/**
 * Locate a Chromium-family browser that can host an `--app=` window.
 * Returns `{ name, path }` or null when none is installed.
 */
export function resolveChromiumBrowser() {
  for (const c of candidates()) {
    try {
      if (existsSync(c.path)) return c;
    } catch {
      /* unreadable candidate path; keep scanning */
    }
  }
  return null;
}

/**
 * Build the `(command, args, detached)` to spawn `browserPath` with `browserArgs` so the window
 * process ESCAPES the daemon's process tree (see the file header: it must survive an auto-update
 * relaunch or tray Quit, both of which tree-kill the daemon). The per-OS detach is the shared
 * kit primitive (buildDetachedSpawn: win32 → WMI `Win32_Process.Create` as the primary hand-off,
 * with `cmd /c start ""` only as a fallback if WMI is unavailable (`cmd start` leaked the daemon's
 * listening socket, see the shared kit's own header for the story), POSIX → `detached:true`
 * setsid); this only adapts its flat `argv` into the `{ command, args }` split that node's
 * `spawn(command, args)` takes below. Pure + exported so the split adapter is unit-tested.
 */
export function buildPortableSpawn(platform, browserPath, browserArgs) {
  const { argv, detached } = buildDetachedSpawn(platform, [browserPath, ...browserArgs]);
  return { command: argv[0], args: argv.slice(1), detached };
}

/**
 * The key Chromium files a saved app-window placement under, mirroring its own
 * `GenerateApplicationNameFromURL` (`host + "_" + path`).
 *
 * Two omissions matter and are NOT oversights on our part — they are Chromium's:
 * the PORT and the QUERY STRING are both absent from the key. So every window this
 * daemon opens on the same path shares one saved geometry, and two windows that
 * differ only by `?foo=` are the same window as far as placement is concerned. A
 * caller that wants per-window geometry must vary the PATH, not the query.
 * (Verified against Edge 150 on 2026-07-15: `--app=http://localhost:4000/` stores
 * `browser.app_window_placement["localhost_/"]`.)
 *
 * Returns null for a URL that won't parse.
 */
export function appWindowPlacementKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}_${u.pathname}`; // hostname, not host: Chromium's key has no port
  } catch {
    return null;
  }
}

/**
 * Has Chromium already stored bounds for this window in `profileDir`? True only for a
 * real saved placement, so callers can tell "the user has sized this window" apart from
 * "this window has never been opened".
 *
 * Chromium writes the placement when the user MOVES or RESIZES the window — never for a
 * size we imposed with `--window-size` (verified 2026-07-15). That asymmetry is exactly
 * what makes {@link openPortableWindow}'s `initialSize` stable rather than sticky: we
 * keep supplying it until the user overrides it by hand, and from then on it's theirs.
 *
 * The lookup tries the placement key flat AND as a dotted pref path: Chromium writes
 * preferences by path, so a key containing dots — any URL path with a dot in it, e.g.
 * DevWebUI's `/focus/<projectId>.<localId>` windows — lands as nested dicts
 * ("localhost_/focus/p1" → {"main": {...}}), not under the flat key its own
 * `GenerateApplicationNameFromURL` produces (observed against Edge 150, 2026-07-16).
 * A flat-only probe reports false for every such window, so `--window-size` keeps
 * being passed and silently undoes the user's resize on each launch.
 *
 * Only a node shaped like a placement (a numeric window rect) counts: a nested
 * CONTAINER dict — another window's dotted key sharing this key as its prefix —
 * must not read as "this window was saved".
 *
 * Any failure (no profile, no Preferences yet, unreadable/!JSON) reports false — i.e.
 * "nothing remembered", which makes a fresh profile take the caller's initial size.
 */
export function hasRememberedBounds(profileDir, url) {
  const key = appWindowPlacementKey(url);
  if (!profileDir || !key) return false;
  try {
    const prefs = JSON.parse(readFileSync(join(profileDir, "Default", "Preferences"), "utf8"));
    const placements = prefs?.browser?.app_window_placement;
    if (!placements || typeof placements !== "object") return false;
    let node = placements[key];
    if (node === undefined) {
      node = key.split(".").reduce((n, seg) => (n && typeof n === "object" ? n[seg] : undefined), placements);
    }
    return (
      typeof node?.left === "number" &&
      typeof node.top === "number" &&
      typeof node.right === "number" &&
      typeof node.bottom === "number" &&
      // A rect with no area (left===right from e.g. a monitor-disconnect reconciliation)
      // is junk, not a remembered size: treating it as "remembered" would skip
      // --window-size and let Chromium restore an invisible window.
      node.right > node.left &&
      node.bottom > node.top
    );
  } catch {
    return false;
  }
}

/** `--window-size=W,H` for a `{ width, height }`, or null when it isn't a usable size. */
function windowSizeArg(size) {
  if (!size) return null;
  const w = Math.round(Number(size.width));
  const h = Math.round(Number(size.height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `--window-size=${w},${h}`;
}

/**
 * Open `url` in a chromeless app window. Resolves to `{ ok: true, browser }` once the
 * window process has spawned, or `{ ok: false, reason: "no-browser" | "spawn-failed" }`.
 * Best-effort by design: callers surface the failure to the user (toast / fallback to
 * a normal tab) rather than treating it as fatal.
 *
 * `opts.profileDir` gives the window a dedicated Chromium profile (`--user-data-dir`).
 * Chromium remembers app-window size/position PER PROFILE, so a dedicated profile means
 * the portable window keeps its own geometry across launches instead of inheriting (and
 * fighting over) the user's main browser profile; it also runs as its own browser
 * process rather than handing off to an already-running instance. The family convention
 * is `<configDir>/portable-profile` (a sibling of runtime.json), and the PS tray
 * launchers derive the exact same path so both open paths share one profile. A dir that
 * cannot be created falls back to the default profile rather than failing the open.
 *
 * `opts.initialSize` ({ width, height }) is the size to open a window Chromium has NEVER
 * seen — the first-run geometry. It is deliberately not applied once the user has sized
 * the window themselves ({@link hasRememberedBounds}), because `--window-size` overrides
 * a restored placement and would silently undo their resize on every launch. Omit it to
 * accept Chromium's own default, which is roughly the whole work area — far too big for
 * a small single-purpose window, which is the reason this option exists.
 */
export function openPortableWindow(url, opts = {}) {
  const browser = resolveChromiumBrowser();
  if (!browser) return Promise.resolve({ ok: false, reason: "no-browser" });
  const args = [];
  if (opts.profileDir) {
    try {
      mkdirSync(opts.profileDir, { recursive: true });
      // no-first-run / no-default-browser-check: a fresh dedicated profile must open
      // straight into the app window, not Edge/Chrome onboarding.
      args.push(`--user-data-dir=${opts.profileDir}`, "--no-first-run", "--no-default-browser-check");
    } catch {
      /* unusable profile dir; open with the default profile instead */
    }
  }
  const sizeArg = windowSizeArg(opts.initialSize);
  if (sizeArg && !hasRememberedBounds(opts.profileDir, url)) args.push(sizeArg);
  args.push(`--app=${url}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const { command, args: spawnArgs, detached } = buildPortableSpawn(process.platform, browser.path, args);
      const child = spawn(command, spawnArgs, {
        detached,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => finish({ ok: false, reason: "spawn-failed" }));
      child.once("spawn", () => {
        child.unref();
        finish({ ok: true, browser: browser.name });
      });
      // Belt-and-suspenders for runtimes that never emit "spawn": if no error arrived
      // shortly after launch, the process started.
      setTimeout(() => {
        try {
          child.unref();
        } catch {
          /* already gone */
        }
        finish({ ok: true, browser: browser.name });
      }, 750);
    } catch {
      finish({ ok: false, reason: "spawn-failed" });
    }
  });
}
