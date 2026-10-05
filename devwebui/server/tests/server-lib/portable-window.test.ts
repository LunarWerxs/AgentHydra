// Tests for the shared portable-window opener (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/portable-window.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/portable-window.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// Scope note: openPortableWindow SPAWNS a real, detached browser window — an intolerable side
// effect in an automated run — so it is deliberately NOT exercised here. Only the pure,
// read-only resolver (existsSync probing, no process spawn) is tested. Its contract holds on
// every host: it returns a real, existing Chromium-family executable, or null when none is
// installed (a valid outcome on a headless CI box).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appWindowPlacementKey,
  buildPortableSpawn,
  hasRememberedBounds,
  resolveChromiumBrowser,
} from "../../src/portable-window.mjs";

const KNOWN_NAMES = [
  "msedge",
  "chrome",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
];

test("resolveChromiumBrowser returns null, or a real existing executable with a known name", () => {
  const found = resolveChromiumBrowser();
  if (found === null) return; // no Chromium-family browser on this host — a valid result
  expect(KNOWN_NAMES).toContain(found.name);
  expect(typeof found.path).toBe("string");
  expect(found.path.length).toBeGreaterThan(0);
  expect(existsSync(found.path)).toBe(true);
});

// Regression guard: the portable window MUST outlive the daemon (an auto-update relaunch or tray
// Quit tree-kills the daemon with `taskkill /T`), and it must NOT inherit the daemon's listening
// socket (a `cmd /c start` child did, pinning the daemon's port until the window closed — verified
// 2026-07-15 with a real msedge --app window). Both properties come from handing the launch to WMI;
// buildDetachedSpawn owns that contract and its own test pins the shape. These pin the adapter: the
// browser must never become the spawned command again (that is the tree-kill regression).
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP_ARGS = ["--user-data-dir=C:\\config dir\\portable-profile", "--app=http://127.0.0.1:7787/"];

test("buildPortableSpawn win32: hands the window off so it escapes the daemon tree", () => {
  const s = buildPortableSpawn("win32", EDGE, APP_ARGS);
  expect(s.command).toBe("powershell");
  // The browser must NOT be the spawned command on win32: a direct spawn is the tree-kill regression.
  expect(s.command).not.toBe(EDGE);
  expect(s.detached).toBe(false);
  // The real launch still carries the browser and its args through to the hand-off.
  const script = s.args[s.args.length - 1]!;
  expect(script).toContain(`"${EDGE}"`);
  expect(script).toContain("--app=http://127.0.0.1:7787/");
  expect(script).toContain('"--user-data-dir=C:\\config dir\\portable-profile"');
});

test("buildPortableSpawn posix: spawns the browser directly with detached:true (setsid)", () => {
  const mac = buildPortableSpawn("darwin", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", APP_ARGS);
  expect(mac).toEqual({
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: APP_ARGS,
    detached: true,
  });
  const linux = buildPortableSpawn("linux", "/usr/bin/google-chrome", APP_ARGS);
  expect(linux).toEqual({ command: "/usr/bin/google-chrome", args: APP_ARGS, detached: true });
});

// ── saved-placement probing (what makes `initialSize` first-run-only) ────────────────────
// These pin Chromium's real key format, verified against Edge 150 on 2026-07-15: an --app
// window on http://localhost:4000/ stores browser.app_window_placement["localhost_/"].

test("appWindowPlacementKey mirrors Chromium: host + '_' + path, NO port and NO query", () => {
  expect(appWindowPlacementKey("http://localhost:4000/")).toBe("localhost_/");
  // The port is absent from the key — a different port is the SAME saved window.
  expect(appWindowPlacementKey("http://localhost:9999/")).toBe("localhost_/");
  // The query is absent too. This is the whole reason a per-window geometry has to be
  // expressed as a PATH: these two are one window as far as placement is concerned.
  expect(appWindowPlacementKey("http://localhost:4000/?process=a")).toBe("localhost_/");
  expect(appWindowPlacementKey("http://localhost:4000/?process=b")).toBe("localhost_/");
  // A path DOES separate them.
  expect(appWindowPlacementKey("http://localhost:4000/focus/a")).toBe("localhost_/focus/a");
  expect(appWindowPlacementKey("http://localhost:4000/focus/b")).toBe("localhost_/focus/b");
  // A dot in the path stays in the key — but Chromium STORES such a key nested (see below).
  expect(appWindowPlacementKey("http://localhost:4000/focus/p1.main")).toBe("localhost_/focus/p1.main");
  expect(appWindowPlacementKey("not a url")).toBeNull();
});

test("hasRememberedBounds: true only for a placement actually saved for THIS window", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-portable-"));
  try {
    const url = "http://localhost:4000/focus/main";

    // No profile at all / no Preferences yet ⇒ nothing remembered ⇒ caller's size applies.
    expect(hasRememberedBounds(dir, url)).toBe(false);
    expect(hasRememberedBounds(undefined, url)).toBe(false);

    mkdirSync(join(dir, "Default"), { recursive: true });
    const prefs = join(dir, "Default", "Preferences");

    // A placement for a DIFFERENT window must not count as this one being remembered.
    writeFileSync(prefs, JSON.stringify({ browser: { app_window_placement: { "localhost_/": {} } } }));
    expect(hasRememberedBounds(dir, url)).toBe(false);

    // The real thing.
    writeFileSync(
      prefs,
      JSON.stringify({
        browser: { app_window_placement: { "localhost_/focus/main": { left: 1, top: 2, right: 521, bottom: 302 } } },
      }),
    );
    expect(hasRememberedBounds(dir, url)).toBe(true);

    // A degenerate (zero-area) rect is junk, not a remembered size — reporting it as
    // remembered would skip --window-size and let Chromium restore an invisible window.
    writeFileSync(
      prefs,
      JSON.stringify({
        browser: { app_window_placement: { "localhost_/focus/main": { left: 100, top: 100, right: 100, bottom: 100 } } },
      }),
    );
    expect(hasRememberedBounds(dir, url)).toBe(false);

    // Corrupt/unreadable Preferences must not throw — it degrades to "nothing remembered".
    writeFileSync(prefs, "{ not json");
    expect(hasRememberedBounds(dir, url)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasRememberedBounds reads the NESTED form a dotted placement key is stored as", () => {
  // Chromium writes preferences by dotted PATH, so a placement key containing a dot —
  // e.g. DevWebUI's /focus/<projectId>.<localId> windows — lands as nested dicts:
  // app_window_placement["localhost_/focus/p1"]["main"], NOT under the flat key its own
  // key format names (observed against Edge 150, 2026-07-16). A flat-only probe reported
  // false for every such window, so --window-size kept overriding the user's saved
  // resize on each fresh-process launch.
  const dir = mkdtempSync(join(tmpdir(), "lw-portable-"));
  try {
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({
        browser: {
          app_window_placement: { "localhost_/focus/p1": { main: { left: 1, top: 2, right: 441, bottom: 222 } } },
        },
      }),
    );
    expect(hasRememberedBounds(dir, "http://localhost:4000/focus/p1.main")).toBe(true);
    // The sibling local id under the same project is a different window.
    expect(hasRememberedBounds(dir, "http://localhost:4000/focus/p1.other")).toBe(false);
    // The nested CONTAINER dict is not itself a saved placement: the dotless prefix
    // window was never saved, so it must still receive the caller's initial size.
    expect(hasRememberedBounds(dir, "http://localhost:4000/focus/p1")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
