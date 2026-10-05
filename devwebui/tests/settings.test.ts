// ───────────────────────────────────────────────────────────────────────────────
// Settings persistence round-trip. Isolated via DEVWEBUI_HOME (tests/setup.ts), so
// this never touches the real ~/.devwebui/settings.json. Covers the newest boolean
// setting (hideTrayIcon) alongside its sibling portableMode, both of which follow the
// same read/write/default shape in server/src/runtime.ts.
// ───────────────────────────────────────────────────────────────────────────────
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import { readSettings, writeSettings } from "../server/src/runtime.ts";

test("hideTrayIcon defaults to false when no settings file exists yet", () => {
  const s = readSettings();
  expect(s.hideTrayIcon).toBe(false);
});

test("writeSettings persists hideTrayIcon, and readSettings round-trips it back", () => {
  writeSettings({ hideTrayIcon: true });
  expect(readSettings().hideTrayIcon).toBe(true);

  writeSettings({ hideTrayIcon: false });
  expect(readSettings().hideTrayIcon).toBe(false);
});

test("writeSettings leaves hideTrayIcon untouched when the patch omits it", () => {
  writeSettings({ hideTrayIcon: true });
  writeSettings({ portableMode: true }); // unrelated patch, no hideTrayIcon key at all
  expect(readSettings().hideTrayIcon).toBe(true);
});

test("writeSettings ignores a non-boolean hideTrayIcon and keeps the current value", () => {
  writeSettings({ hideTrayIcon: true });
  // @ts-expect-error — deliberately malformed input, mirroring how a bad PUT body is handled
  writeSettings({ hideTrayIcon: "yes" });
  expect(readSettings().hideTrayIcon).toBe(true);
});

// updateNotify (server/src/auto-update.ts): the opposite default from hideTrayIcon/autoUpdate —
// absent/missing = ON, since telling the owner about an update costs nothing.
test("updateNotify defaults to true when no settings file exists yet", () => {
  const s = readSettings();
  expect(s.updateNotify).toBe(true);
});

test("writeSettings persists updateNotify, and readSettings round-trips it back", () => {
  writeSettings({ updateNotify: false });
  expect(readSettings().updateNotify).toBe(false);

  writeSettings({ updateNotify: true });
  expect(readSettings().updateNotify).toBe(true);
});

test("writeSettings leaves updateNotify untouched when the patch omits it", () => {
  writeSettings({ updateNotify: false });
  writeSettings({ portableMode: true }); // unrelated patch, no updateNotify key at all
  expect(readSettings().updateNotify).toBe(false);
});

test("writeSettings ignores a non-boolean updateNotify and keeps the current value", () => {
  writeSettings({ updateNotify: false });
  // @ts-expect-error — deliberately malformed input, mirroring how a bad PUT body is handled
  writeSettings({ updateNotify: "yes" });
  expect(readSettings().updateNotify).toBe(false);
});
