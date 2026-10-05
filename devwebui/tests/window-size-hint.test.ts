// The window-size hint: how a portable window learns its intended size when Chromium
// won't apply one from outside.
//
// Why this exists: --window-size and even the slot's saved placement are IGNORED when a
// Chromium instance on the profile is already running — the forwarded --app launch just
// inherits the existing window's geometry (verified against Edge 150 on 2026-07-16).
// The launcher's "Open dashboard" button always hits that case, so the daemon appends
// WINDOW_SIZE_HINT_PARAM to the URL (server/src/http/core.ts) and the page resizes
// itself (web/src/lib/window-size-hint.ts). These tests pin the daemon's halves: the
// hint format, the profile reader, and windowSizeHintFor's remembered/first-run/
// maximized decision.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { formatWindowSizeHint, parseWindowSizeHint } from "../shared/constants";
import { rememberedPlacement, windowSizeHintFor } from "../server/src/window-size";

const DASH = "http://localhost:4000/";
const INITIAL = { width: 840, height: 760 };

// Every scratch profile this file creates is registered here and reaped by the file-wide
// afterAll below, so a failing (or crashing) test cannot leave one behind. Cleaning up in
// the CALLER's finally, as this file used to, only tidies up when the test passes; the
// per-test rmSync calls are harmless no-ops on top of this (force: true).
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch profile whose Preferences hold the given app_window_placement dict. */
function profileWith(placements: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "lw-winsize-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(
    join(dir, "Default", "Preferences"),
    JSON.stringify({ browser: { app_window_placement: placements } }),
  );
  return dir;
}

test("hint format round-trips, garbage degrades to null (never a bizarre resizeTo)", () => {
  expect(formatWindowSizeHint({ width: 840, height: 760 })).toBe("840x760");
  expect(parseWindowSizeHint("840x760")).toEqual({ width: 840, height: 760 });
  expect(parseWindowSizeHint(formatWindowSizeHint({ width: 440, height: 220 }))).toEqual({
    width: 440,
    height: 220,
  });
  for (const bad of [null, "", "840", "840x", "x760", "840x760x2", "-840x760", "a840x760", "8x7"])
    expect(parseWindowSizeHint(bad)).toBeNull();
});

test("rememberedPlacement reads a flat placement (the dashboard's key has no dots)", () => {
  const dir = profileWith({ "localhost_/": { left: 100, top: 50, right: 940, bottom: 810 } });
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 840, height: 760, maximized: false });
    // A different window's placement must not answer for this one.
    expect(rememberedPlacement(dir, "http://localhost:4000/focus/p1.main")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedPlacement reads the NESTED form a dotted process id is stored as", () => {
  // Chromium writes preferences by dotted PATH, and every focus URL contains a dot
  // (`<projectId>.<localId>`), so the launcher's placement lands nested:
  // app_window_placement["localhost_/focus/p1"]["main"], NOT under the flat key its
  // own key format names (observed against Edge 150, 2026-07-16).
  const dir = profileWith({
    "localhost_/focus/p1": { main: { left: 600, top: 600, right: 1040, bottom: 820 } },
  });
  try {
    expect(rememberedPlacement(dir, "http://localhost:4000/focus/p1.main")).toEqual({
      width: 440,
      height: 220,
      maximized: false,
    });
    // The sibling local id under the same project is a different window, and the
    // nested CONTAINER dict is not itself a saved placement.
    expect(rememberedPlacement(dir, "http://localhost:4000/focus/p1.other")).toBeNull();
    expect(rememberedPlacement(dir, "http://localhost:4000/focus/p1")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedPlacement rejects junk: degenerate rects, sub-minimum sizes, corrupt prefs", () => {
  // Zero-area and tiny rects are monitor-reconciliation leftovers, not sizes a user
  // chose (Chromium's drag minimum is far larger) — and anything under the parse
  // floor would format to a hint the page then rejects.
  const dir = profileWith({ "localhost_/": { left: 100, top: 100, right: 100, bottom: 100 } });
  try {
    expect(rememberedPlacement(dir, DASH)).toBeNull();

    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({
        browser: {
          app_window_placement: { "localhost_/": { left: 0, top: 0, right: 9, bottom: 900 } },
        },
      }),
    );
    expect(rememberedPlacement(dir, DASH)).toBeNull();

    writeFileSync(join(dir, "Default", "Preferences"), "{ not json");
    expect(rememberedPlacement(dir, DASH)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedPlacement carries Chromium's maximized flag", () => {
  // Verified against Edge 150 (2026-07-16): a maximized app window stores
  // maximized:true and the rect holds the pre-maximize RESTORE bounds.
  const dir = profileWith({
    "localhost_/": { left: 10, top: 10, right: 850, bottom: 770, maximized: true },
  });
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 840, height: 760, maximized: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windowSizeHintFor: remembered size beats first-run, junk falls back, maximized sends NO hint", () => {
  // Nothing saved → the measured first-run size.
  const fresh = mkdtempSync(join(tmpdir(), "lw-winsize-"));
  try {
    expect(windowSizeHintFor(fresh, DASH, INITIAL)).toBe("840x760");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }

  // A real remembered size wins over the first-run constant.
  const saved = profileWith({ "localhost_/": { left: 0, top: 0, right: 1000, bottom: 900 } });
  try {
    expect(windowSizeHintFor(saved, DASH, INITIAL)).toBe("1000x900");
  } finally {
    rmSync(saved, { recursive: true, force: true });
  }

  // Degenerate junk degrades to the first-run size, not to a broken hint.
  const junk = profileWith({ "localhost_/": { left: 5, top: 5, right: 5, bottom: 5 } });
  try {
    expect(windowSizeHintFor(junk, DASH, INITIAL)).toBe("840x760");
  } finally {
    rmSync(junk, { recursive: true, force: true });
  }

  // Maximized: no hint at all. The rect is only the restore bounds — hinting it would
  // make the page resizeTo() a maximized window back down, un-maximizing a state the
  // user chose. Fresh launches restore maximized natively; forwarded ones are left be.
  const max = profileWith({
    "localhost_/": { left: 10, top: 10, right: 850, bottom: 770, maximized: true },
  });
  try {
    expect(windowSizeHintFor(max, DASH, INITIAL)).toBeNull();
  } finally {
    rmSync(max, { recursive: true, force: true });
  }
});

test("every hint windowSizeHintFor can emit parses back (the page must never drop one)", () => {
  // The parse floor is two digits; the reader's MIN floor and the measured constants
  // sit far above it, so emit->parse can't lose a legitimate size.
  const small = profileWith({ "localhost_/": { left: 0, top: 0, right: 50, bottom: 50 } });
  try {
    const hint = windowSizeHintFor(small, DASH, INITIAL);
    expect(hint).toBe("50x50");
    expect(parseWindowSizeHint(hint)).toEqual({ width: 50, height: 50 });
  } finally {
    rmSync(small, { recursive: true, force: true });
  }
});
