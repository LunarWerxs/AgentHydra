// The window-size hint: how a portable window learns its intended size when Chromium won't
// apply one from outside. --window-size and even the saved placement are IGNORED when a
// Chromium instance on the profile is already running — the forwarded --app launch inherits
// the existing window's geometry (verified Edge 150, 2026-07-16). So the daemon appends
// WINDOW_SIZE_HINT_PARAM to the URL (server/src/index.ts) and the page resizes itself
// (web/src/lib/window-size-hint.ts). These tests pin the daemon's halves: the hint format,
// the profile reader, and windowSizeHintFor's remembered/first-run/maximized decision.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatWindowSizeHint,
  rememberedPlacement,
  WINDOW_SIZE_HINT_PARAM,
  windowSizeHintFor,
} from '../src/window-size'

const DASH = 'http://localhost:7787/'
const INITIAL = { width: 1060, height: 800 }

// One root under the OS temp dir for the whole file; every scratch dir below nests inside it,
// and this is the outcome-independent backstop even where a test's own try/finally is not.
const ROOT = mkdtempSync(join(tmpdir(), 'cc-winsize-root-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** A scratch profile whose Preferences hold the given app_window_placement dict. */
function profileWith(placements: unknown): string {
  const dir = mkdtempSync(join(ROOT, 'cc-winsize-'))
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(
    join(dir, 'Default', 'Preferences'),
    JSON.stringify({ browser: { app_window_placement: placements } }),
  )
  return dir
}

test('hint format is the shape the page parser accepts', () => {
  expect(formatWindowSizeHint({ width: 1060, height: 800 })).toBe('1060x800')
  // The web applier parses /^(\d{2,5})x(\d{2,5})$/ — pin the contract both sides share.
  expect(formatWindowSizeHint(INITIAL)).toMatch(/^\d{2,5}x\d{2,5}$/)
  expect(WINDOW_SIZE_HINT_PARAM).toBe('window-size')
})

test('rememberedPlacement reads a flat placement (the sessions key has no dots)', () => {
  // Chromium's key for "http://localhost:7787/" is "localhost_/".
  const dir = profileWith({ 'localhost_/': { left: 100, top: 50, right: 1160, bottom: 850 } })
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 1060, height: 800, maximized: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rememberedPlacement rejects junk: degenerate rects, sub-minimum sizes, corrupt prefs', () => {
  const dir = profileWith({ 'localhost_/': { left: 100, top: 100, right: 100, bottom: 100 } })
  try {
    expect(rememberedPlacement(dir, DASH)).toBeNull()

    writeFileSync(
      join(dir, 'Default', 'Preferences'),
      JSON.stringify({
        browser: {
          app_window_placement: { 'localhost_/': { left: 0, top: 0, right: 9, bottom: 900 } },
        },
      }),
    )
    expect(rememberedPlacement(dir, DASH)).toBeNull()

    writeFileSync(join(dir, 'Default', 'Preferences'), '{ not json')
    expect(rememberedPlacement(dir, DASH)).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rememberedPlacement carries Chromium's maximized flag (restore bounds)", () => {
  const dir = profileWith({
    'localhost_/': { left: 10, top: 10, right: 1070, bottom: 810, maximized: true },
  })
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 1060, height: 800, maximized: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('windowSizeHintFor: remembered beats first-run, junk falls back, maximized sends NO hint', () => {
  const fresh = mkdtempSync(join(ROOT, 'cc-winsize-'))
  try {
    expect(windowSizeHintFor(fresh, DASH, INITIAL)).toBe('1060x800')
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }

  const saved = profileWith({ 'localhost_/': { left: 0, top: 0, right: 1200, bottom: 900 } })
  try {
    expect(windowSizeHintFor(saved, DASH, INITIAL)).toBe('1200x900')
  } finally {
    rmSync(saved, { recursive: true, force: true })
  }

  const junk = profileWith({ 'localhost_/': { left: 5, top: 5, right: 5, bottom: 5 } })
  try {
    expect(windowSizeHintFor(junk, DASH, INITIAL)).toBe('1060x800')
  } finally {
    rmSync(junk, { recursive: true, force: true })
  }

  const max = profileWith({
    'localhost_/': { left: 10, top: 10, right: 1070, bottom: 810, maximized: true },
  })
  try {
    expect(windowSizeHintFor(max, DASH, INITIAL)).toBeNull()
  } finally {
    rmSync(max, { recursive: true, force: true })
  }
})
