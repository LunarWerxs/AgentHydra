import { expect, test } from 'bun:test'
import { INSTANCE_MODE_WINDOW_SIZE, PORTABLE_WINDOW_SIZE } from '../src/config'
import {
  INSTANCE_MODE_PATH,
  INSTANCE_MODE_PROFILE_DIR,
  instanceModeUrl,
} from '../src/instance-mode-window'
import { appWindowPlacementKey } from '../src/portable-window.mjs'

test('instance mode has a distinct path, profile, geometry, and Chromium placement key', () => {
  const full = 'http://127.0.0.1:7787/'
  const quick = instanceModeUrl(full)
  expect(INSTANCE_MODE_PATH).toBe('/instances')
  expect(quick).toBe('http://127.0.0.1:7787/instances')
  expect(appWindowPlacementKey(quick)).not.toBe(appWindowPlacementKey(full))
  expect(INSTANCE_MODE_PROFILE_DIR).toContain('instance-portable-profile')
  expect(INSTANCE_MODE_WINDOW_SIZE.width).toBeLessThan(PORTABLE_WINDOW_SIZE.width)
  expect(INSTANCE_MODE_WINDOW_SIZE.height).toBeLessThanOrEqual(PORTABLE_WINDOW_SIZE.height)
})

test('instanceModeUrl discards an existing path, query, and hash', () => {
  expect(instanceModeUrl('http://localhost:9000/old?x=1#y')).toBe('http://localhost:9000/instances')
})
