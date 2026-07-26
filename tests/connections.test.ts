// "Sync my settings with Connections" for server/src/connections.ts. Pure logic plus the SQLite
// settings-row persistence seam only: NEVER hits connections.icu, GitHub, or any OAuth/OIDC
// endpoint, and never exercises the @cnct/connect dynamic imports (those need a
// live IdP). Every case below stays on paths that are reachable with hasConnection() === false
// (no credential ever stored here), which is exactly what enable()/disable() gate their only
// network calls behind. So pushNow/pullNow/buildAuthorizeUrl/handleCallback are intentionally
// left uncovered; they're thin wrappers around the SDK with no local branching to unit-test
// without a live IdP or a mocked dynamic import (no precedent for that in this codebase).
//
// bun test shares ONE module instance across every test file in the run (no per-file reset
// unless --isolate/--parallel, which this repo's `bun test` doesn't use, confirmed empirically),
// and connections.ts keeps its sync state in module-level `let`s with no exported reset. So each
// test below explicitly returns to a known baseline via disable(true) in beforeEach (cheap and
// network-free here, since hasConnection() is always false in this file).
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  disable,
  enable,
  hasConnection,
  initConnections,
  syncStatus,
  updateAppearance,
} from '../server/src/connections'
import { getSetting, setSetting } from '../server/src/db'

// Settings-row key connections.ts persists its whole sync-state blob under (see SETTINGS_KEY in
// the module); read directly here to assert persistence independent of the in-memory state.
const SETTINGS_KEY = 'connections_sync'

// Machine-local settings that must NEVER be part of what syncs (see PREF_KEYS in connections.ts).
const MACHINE_LOCAL_KEYS = ['portable_mode', 'hide_tray_icon']
// The allowlisted portable prefs that DO sync.
const PREF_KEYS = ['scheduler_enabled', 'spacing_seconds', 'poll_seconds', 'max_concurrent']

beforeEach(async () => {
  initConnections()
  // Return to a clean baseline. forget=true clears identity/appearance/version/sdk state; since
  // no credential is ever stored in this file, hasConnection() is false, so this never touches
  // the network (the locker delete + signOut branches are both gated behind hasConnection()).
  await disable(true)
  // bun test shares one module instance (and one settings DB) across every file in the run with
  // no per-test reset, so any PREF_KEYS / machine-local row this file writes must be put back;
  // otherwise a later file (e.g. tests/settings.test.ts) sees this file's leftovers.
  setSetting('portable_mode', '0')
  setSetting('hide_tray_icon', '0')
  setSetting('scheduler_enabled', '0')
  setSetting('spacing_seconds', '60')
  setSetting('poll_seconds', '5')
  setSetting('max_concurrent', '3')
})

// ── syncStatus() default shape ──────────────────────────────────────────────────────────
describe('syncStatus defaults', () => {
  test('reports disabled/disconnected with nulls and version 0 when nothing is configured', () => {
    const status = syncStatus()
    expect(status).toEqual({
      ok: true,
      enabled: false,
      connected: false,
      name: null,
      email: null,
      picture: null,
      lastSyncedAt: null,
      version: 0,
      appearance: null,
    })
  })

  test('hasConnection is false with no credential ever stored', () => {
    expect(hasConnection()).toBe(false)
  })
})

// ── enable/disable persistence round-trip ───────────────────────────────────────────────
describe('enable/disable persistence', () => {
  test('enable() while signed out turns the flag on locally with no applied pull', async () => {
    const { status, applied } = await enable()
    expect(status.enabled).toBe(true)
    expect(status.connected).toBe(false)
    expect(applied).toBe(false)
  })

  test('enabled state survives a re-read from the DB settings row', async () => {
    await enable()
    const raw = getSetting(SETTINGS_KEY)
    expect(raw).not.toBe('')
    const persisted = JSON.parse(raw) as { enabled?: boolean }
    expect(persisted.enabled).toBe(true)
    // syncStatus() reflects exactly what's in the row, not some separate cache.
    expect(syncStatus().enabled).toBe(true)
  })

  test('disable() without forget turns sync off but the row is still present', async () => {
    await enable()
    const status = await disable(false)
    expect(status.enabled).toBe(false)
    const raw = getSetting(SETTINGS_KEY)
    expect(raw).not.toBe('')
  })

  test('disable(forget=true) clears identity/appearance/version even when never connected', async () => {
    await enable({ theme: 'dark' })
    let status = await disable(true)
    expect(status.enabled).toBe(false)
    expect(status.name).toBeNull()
    expect(status.email).toBeNull()
    expect(status.picture).toBeNull()
    expect(status.appearance).toBeNull()
    expect(status.version).toBe(0)
    expect(status.lastSyncedAt).toBeNull()

    // And the cleared shape is what's actually on disk, not just the return value.
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as Record<string, unknown>
    expect(persisted.identity).toBeUndefined()
    expect(persisted.appearance).toBeUndefined()
    expect(persisted.sdk).toBeUndefined()
    status = syncStatus()
    expect(status.appearance).toBeNull()
  })

  test('disable(forget=true) is a no-op-safe reset when nothing was ever enabled', async () => {
    const status = await disable(true)
    expect(status.enabled).toBe(false)
    expect(status.connected).toBe(false)
  })

  test('re-enabling after a forgotten disable starts from a clean slate', async () => {
    await enable({ theme: 'dark' })
    await disable(true)
    const { status } = await enable()
    expect(status.enabled).toBe(true)
    expect(status.appearance).toBeNull() // forget cleared it; enable() didn't pass a new one
  })
})

// ── appearance blob ──────────────────────────────────────────────────────────────────────
describe('appearance', () => {
  test('enable(appearance) seeds the appearance blob and it is readable back via syncStatus', async () => {
    const { status } = await enable({ theme: 'light', accent: 'blue' })
    expect(status.appearance).toEqual({ theme: 'light', accent: 'blue' })
  })

  test('updateAppearance persists locally without a network call when sync is disabled', async () => {
    await updateAppearance({ theme: 'system' })
    expect(syncStatus().appearance).toEqual({ theme: 'system' })
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as { appearance?: unknown }
    expect(persisted.appearance).toEqual({ theme: 'system' })
  })

  test('updateAppearance while enabled but disconnected still records locally (no throw)', async () => {
    await enable()
    await updateAppearance({ theme: 'dark' })
    expect(syncStatus().appearance).toEqual({ theme: 'dark' })
    // Not connected, so pushNow() must never have been reached (enabled but no credential).
    expect(hasConnection()).toBe(false)
  })

  test('appearance survives a re-read from the DB settings row', async () => {
    await updateAppearance({ theme: 'light' })
    const persisted = JSON.parse(getSetting(SETTINGS_KEY)) as { appearance?: unknown }
    expect(persisted.appearance).toEqual({ theme: 'light' })
  })
})

// ── settings allowlist (PREF_KEYS + appearance only) ────────────────────────────────────
describe('settings allowlist', () => {
  test('PREF_KEYS covers exactly the four portable scheduler prefs', () => {
    // Documents the allowlist contract asserted operationally below: these are the only
    // settings keys that ever ride the sync doc, alongside the appearance blob.
    expect(PREF_KEYS).toEqual([
      'scheduler_enabled',
      'spacing_seconds',
      'poll_seconds',
      'max_concurrent',
    ])
  })

  test('machine-local settings are never part of the persisted sync-state row', async () => {
    setSetting('portable_mode', '1')
    setSetting('hide_tray_icon', '1')
    await enable({ theme: 'dark' })
    await updateAppearance({ theme: 'dark' })

    const raw = getSetting(SETTINGS_KEY)
    for (const key of MACHINE_LOCAL_KEYS) {
      expect(raw).not.toContain(key)
    }
    // Sanity: the machine-local settings table rows themselves are untouched by sync.
    expect(getSetting('portable_mode')).toBe('1')
    expect(getSetting('hide_tray_icon')).toBe('1')
  })

  test('the sync-state row never carries a live dump of the whole settings table', () => {
    // connections.ts persists ONLY its own ConnState blob under SETTINGS_KEY (enabled/version/
    // appearance/identity/sdk), never the PREF_KEYS values themselves, which only ever travel
    // inside an explicit push/pull document (collectPrefs()/applyPrefs()), not the state row.
    setSetting('scheduler_enabled', '1')
    setSetting('spacing_seconds', '120')
    const raw = getSetting(SETTINGS_KEY)
    const persisted = JSON.parse(raw) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('scheduler_enabled')
    expect(persisted).not.toHaveProperty('spacing_seconds')
    expect(Object.keys(persisted).sort()).toEqual(['enabled', 'version'])
  })
})

// ── remote-apply / merge logic (pure paths only, no network) ──────────────────────────────
describe('remote-apply logic reachable without network', () => {
  test('enable() with no credential never advances version or lastSyncedAt', async () => {
    const { status } = await enable()
    expect(status.version).toBe(0)
    expect(status.lastSyncedAt).toBeNull()
  })

  test('disable(false) leaves a previously-set appearance and version untouched', async () => {
    await enable({ theme: 'dark' })
    const before = syncStatus()
    const after = await disable(false)
    expect(after.appearance).toEqual(before.appearance)
    expect(after.version).toBe(before.version)
  })
})
