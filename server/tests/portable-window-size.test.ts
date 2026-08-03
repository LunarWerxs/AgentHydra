// Pins the daemon's first-run portable-window size (PORTABLE_WINDOW_SIZE in
// server/src/config.ts) the way devwebui pins its DASHBOARD_WINDOW_SIZE: exact digits plus
// the measured intent behind them, so a future tweak has to re-measure rather than drift.
// The tray adapter (misc/AgentHydra-Tray.ps1 PortableWindowSize) carries a copy of the
// same numbers — keep them in step.
import { expect, test } from 'bun:test'
import { PORTABLE_WINDOW_SIZE } from '../src/config'

test("the portable window's first-run size fits the measured sessions layout", () => {
  // Measured against the real UI (see the constant's comment): the sessions sidebar
  // rail-collapses below a (min-width: 1024px) viewport, so 1024 + ~16 frame = 1040 outer
  // is the floor below which a first-run window opens onto the collapsed rail.
  expect(PORTABLE_WINDOW_SIZE.width).toBe(1060)
  expect(PORTABLE_WINDOW_SIZE.height).toBe(800)
  // Guard the intent, not just the digits: it must clear the sidebar's collapse breakpoint…
  expect(PORTABLE_WINDOW_SIZE.width).toBeGreaterThanOrEqual(1040)
  // …without drifting back toward Chromium's whole-work-area default.
  expect(PORTABLE_WINDOW_SIZE.width).toBeLessThan(1400)
  expect(PORTABLE_WINDOW_SIZE.height).toBeLessThan(1100)
})
