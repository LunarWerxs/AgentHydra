import { expect, test } from 'bun:test'
import {
  INSTANCE_MODE_PATH,
  INSTANCE_MODE_PROFILE_DIR,
  instanceModeUrl,
} from '../src/instance-mode-window'

test('instance mode has its own path and Chromium profile', () => {
  const full = 'http://127.0.0.1:7787/'
  const quick = instanceModeUrl(full)
  expect(INSTANCE_MODE_PATH).toBe('/instances')
  expect(quick).toBe('http://127.0.0.1:7787/instances')
  expect(INSTANCE_MODE_PROFILE_DIR).toContain('instance-portable-profile')
})

test('instanceModeUrl discards an existing path, query, and hash', () => {
  expect(instanceModeUrl('http://localhost:9000/old?x=1#y')).toBe('http://localhost:9000/instances')
})
