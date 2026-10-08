// App settings persistence — the sqlite settings table (server/src/db.ts) backing
// GET/POST /api/settings. Happy-path only; mirrors tests/auto-update.test.ts's direct-import,
// no-HTTP-server style (the preload in tests/setup.ts already points AGENTHYDRA_DB at a
// throwaway file, so this never touches the developer's real db).

import { expect, test } from 'bun:test'
import { getSetting, setSetting } from '../server/src/db'

test('hide_tray_icon defaults to off ("0") when never set', () => {
  // db.ts seeds DEFAULT_SETTINGS at import time, so this is already '0' by the time any test
  // runs; assert the value rather than the absence of a row.
  expect(getSetting('hide_tray_icon')).toBe('0')
})

test('setSetting/getSetting round-trips hide_tray_icon on', () => {
  setSetting('hide_tray_icon', '1')
  expect(getSetting('hide_tray_icon')).toBe('1')
  setSetting('hide_tray_icon', '0')
  expect(getSetting('hide_tray_icon')).toBe('0')
})
