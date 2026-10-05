// The desktop shortcut's focus window: its URL and its first-run size.
//
// Why this file exists: a shortcut promises "a small focused window showing just that
// server" (README/CHANGELOG). Two Chromium facts, both verified against Edge 150 on
// 2026-07-15, decide whether that promise can be kept:
//
//   1. A window Chromium has never seen opens at roughly the whole work area (~1905x2092
//      on a 4K display) unless --window-size says otherwise. So a size must be passed.
//   2. Chromium keys a saved app-window placement by host + PATH only — the query string
//      is not part of it. Under the old `/?process=<id>` URL every focus window and the
//      dashboard shared one `localhost_/` slot, so no focus window could hold its own
//      size and resizing one silently resized the others.
//
// Hence: the focus view lives at a PATH (one slot per process), and the size is first-run
// only (the kit's openPortableWindow yields to a placement the user's own resize saved).
// These tests pin the contract; the Chromium-side behavior is pinned in the kit's
// server-lib/portable-window.test.ts.
import { expect, test } from "bun:test";
import {
  DASHBOARD_WINDOW_SIZE,
  FOCUS_PATH_PREFIX,
  FOCUS_WINDOW_SIZE,
  focusPath,
  processIdFromFocusPath,
} from "../shared/constants";
import { appWindowPlacementKey } from "../server/src/portable-window.mjs";

test("focusPath builds the single-process view URL", () => {
  expect(focusPath("p07fc3bd8.main")).toBe("/focus/p07fc3bd8.main");
  expect(focusPath("p07fc3bd8.main").startsWith(FOCUS_PATH_PREFIX)).toBe(true);
});

test("focusPath round-trips through processIdFromFocusPath", () => {
  for (const id of ["p07fc3bd8.main", "abc123.accounts", "x.y-z_1", "p1.market_explore"]) {
    expect(processIdFromFocusPath(focusPath(id))).toBe(id);
  }
});

test("processIdFromFocusPath ignores anything that isn't a focus URL", () => {
  expect(processIdFromFocusPath("/")).toBeNull();
  expect(processIdFromFocusPath("/focus/")).toBeNull();
  expect(processIdFromFocusPath("/settings")).toBeNull();
  // The legacy query form is NOT a focus path — App.vue falls back to ?process= separately.
  expect(processIdFromFocusPath("/?process=p1.main")).toBeNull();
});

test("processIdFromFocusPath survives a malformed %-escape instead of throwing", () => {
  // decodeURIComponent("%E0%A4%A") throws; the view must still render something rather
  // than the whole app dying on a hand-mangled URL.
  expect(() => processIdFromFocusPath("/focus/%E0%A4%A")).not.toThrow();
  expect(processIdFromFocusPath("/focus/%E0%A4%A")).toBe("%E0%A4%A");
});

// THE load-bearing invariant. If someone "simplifies" the focus URL back to a query param,
// every focus window silently collapses onto the dashboard's one geometry slot again and
// the small-window promise quietly breaks with no other test noticing.
test("each process's focus URL gets its OWN Chromium placement slot", () => {
  const base = "http://localhost:4000";
  const a = appWindowPlacementKey(`${base}${focusPath("p1.main")}`);
  const b = appWindowPlacementKey(`${base}${focusPath("p1.accounts")}`);
  const dashboard = appWindowPlacementKey(`${base}/`);

  expect(a).not.toBe(b); // two processes: two remembered geometries
  expect(a).not.toBe(dashboard); // and neither of them fights the dashboard's
  expect(b).not.toBe(dashboard);

  // Contrast: the OLD query-param URLs all collapsed to one slot. This is the regression.
  const oldA = appWindowPlacementKey(`${base}/?process=p1.main`);
  const oldB = appWindowPlacementKey(`${base}/?process=p1.accounts`);
  expect(oldA).toBe(oldB);
  expect(oldA).toBe(dashboard);
});

test("the focus window's first-run size is small enough to be a launcher", () => {
  // Sized against the real view in its compact density: 178px of content (header 33 +
  // 20 pad + card 92 + footer 33) fits the 424x178 viewport a 440x220 outer window leaves.
  expect(FOCUS_WINDOW_SIZE.width).toBe(440);
  expect(FOCUS_WINDOW_SIZE.height).toBe(220);
  // Guard the intent, not just the digits: whatever someone retunes these to, a window
  // that big is no longer a launcher and is probably Chromium's default leaking back.
  expect(FOCUS_WINDOW_SIZE.width).toBeLessThan(900);
  expect(FOCUS_WINDOW_SIZE.height).toBeLessThan(700);
  expect(FOCUS_WINDOW_SIZE.height).toBeGreaterThanOrEqual(178); // must fit the card at all
});

test("the dashboard window's first-run size fits the measured layout", () => {
  // Measured against the real dashboard (see shared/constants.ts): the layout caps
  // content at --container-max = 800px, so 800 + 15 scrollbar + ~16 frame = 831 outer
  // is the floor below which the design width gets cropped.
  expect(DASHBOARD_WINDOW_SIZE.width).toBe(840);
  expect(DASHBOARD_WINDOW_SIZE.height).toBe(760);
  // Guard the intent, not just the digits: it must render the full 800px container…
  expect(DASHBOARD_WINDOW_SIZE.width).toBeGreaterThanOrEqual(831);
  // …without drifting back toward Chromium's whole-work-area default…
  expect(DASHBOARD_WINDOW_SIZE.width).toBeLessThan(1200);
  expect(DASHBOARD_WINDOW_SIZE.height).toBeLessThan(1100);
  // …and it must dwarf the launcher: same slot-per-path system, opposite size need.
  expect(DASHBOARD_WINDOW_SIZE.width).toBeGreaterThan(FOCUS_WINDOW_SIZE.width);
  expect(DASHBOARD_WINDOW_SIZE.height).toBeGreaterThan(FOCUS_WINDOW_SIZE.height);
});
