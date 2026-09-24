import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  ensureClaudeNativeProfileConfig,
  getClaudeNativeProfileConfig,
  getClaudeNativeSettings,
  setClaudeNativeProfileConfig,
} from '../src/claude-native-settings'
import { getSetting, setSetting } from '../src/db'

const key = 'claude_native_profiles'
const optedOutKey = 'claude_native_opted_out'
const original = getSetting(key)
const originalOptedOut = getSetting(optedOutKey)
beforeEach(() => {
  setSetting(key, '')
  setSetting(optedOutKey, '')
})
afterAll(() => {
  setSetting(key, original)
  setSetting(optedOutKey, originalOptedOut)
})

test('a new profile is put on native control automatically, on the first free port', () => {
  setClaudeNativeProfileConfig('C:\\Profiles\\Taken', {
    port: 19300,
    mode: 'native-only',
    launchDebugger: true,
  })
  expect(ensureClaudeNativeProfileConfig('C:\\Profiles\\New')).toEqual({
    port: 19301,
    mode: 'native-only',
    launchDebugger: true,
  })
  // Idempotent: an existing config is returned untouched.
  expect(ensureClaudeNativeProfileConfig('c:/profiles/new')?.port).toBe(19301)
  expect(ensureClaudeNativeProfileConfig('not-a-profile')).toBeNull()
})

test('a profile a person switched to standard controls is never re-enabled', () => {
  ensureClaudeNativeProfileConfig('C:\\Profiles\\Mine')
  setClaudeNativeProfileConfig('C:\\Profiles\\Mine', null)
  expect(ensureClaudeNativeProfileConfig('C:\\Profiles\\Mine')).toBeNull()
  expect(getClaudeNativeProfileConfig('C:\\Profiles\\Mine')).toBeNull()
  // Turning it back on by hand clears the opt-out.
  setClaudeNativeProfileConfig('C:\\Profiles\\Mine', { port: 19350, mode: 'native-only' })
  setClaudeNativeProfileConfig('C:\\Profiles\\Other', null)
  expect(getClaudeNativeProfileConfig('C:\\Profiles\\Mine')?.port).toBe(19350)
})

test('native profiles are opt-in and normalization persists no PID', () => {
  expect(getClaudeNativeSettings()).toEqual({})
  expect(getClaudeNativeProfileConfig('C:\\Profiles\\Native')).toBeNull()
  expect(getClaudeNativeProfileConfig('/home/user/.config/Claude')).toBeNull()
  expect(getClaudeNativeProfileConfig('existing-label')).toBeNull()
  setClaudeNativeProfileConfig('C:/Profiles/Native/', { port: 9229, mode: 'native-only' })
  expect(getClaudeNativeProfileConfig('c:\\profiles\\native')).toEqual({
    port: 9229,
    mode: 'native-only',
  })
  expect(JSON.parse(getSetting(key))).toEqual({
    'c:\\profiles\\native': { port: 9229, mode: 'native-only' },
  })
  setClaudeNativeProfileConfig('c:\\profiles\\native', null)
  expect(getClaudeNativeSettings()).toEqual({})
})

test('rejects invalid paths, ports, modes and persisted process IDs', () => {
  expect(() => setClaudeNativeProfileConfig('Native', { port: 9229, mode: 'native-only' })).toThrow(
    'absolute',
  )
  for (const config of [
    { port: 0, mode: 'native-only' },
    { port: 65536, mode: 'native-only' },
    { port: 9229, mode: 'ui' },
    { port: 9229, mode: 'native-only', pid: 123 },
    { port: 9229, mode: 'native-only', launchDebugger: 'true' },
    { port: 9229, mode: 'native-only', launchDebugger: null },
  ]) {
    expect(() => setClaudeNativeProfileConfig('C:\\Profiles\\Native', config as any)).toThrow()
  }
  expect(getSetting(key)).toBe('')
})

test('automatic debugger launch is an explicit persistent opt-in and ports belong to one profile', () => {
  setClaudeNativeProfileConfig('C:\\Profiles\\Native', {
    port: 19315,
    mode: 'native-only',
    launchDebugger: true,
  })
  expect(getClaudeNativeProfileConfig('c:/profiles/native')).toEqual({
    port: 19315,
    mode: 'native-only',
    launchDebugger: true,
  })
  expect(() =>
    setClaudeNativeProfileConfig('C:\\Profiles\\Other', { port: 19315, mode: 'native-only' }),
  ).toThrow('already registered')
  expect(Object.keys(getClaudeNativeSettings())).toEqual(['c:\\profiles\\native'])
  setClaudeNativeProfileConfig('C:\\Profiles\\Native', {
    port: 19315,
    mode: 'native-only',
    launchDebugger: false,
  })
  expect(getClaudeNativeProfileConfig('C:\\Profiles\\Native')?.launchDebugger).toBe(false)
})

test('corrupt or ambiguous stored config fails closed instead of disabling native policy', () => {
  setSetting(key, '{')
  expect(() => getClaudeNativeSettings()).toThrow()
  setSetting(
    key,
    JSON.stringify({
      'C:/Profiles/Native': { port: 9229, mode: 'native-only' },
      'c:\\profiles\\native': { port: 9230, mode: 'prefer-native' },
    }),
  )
  expect(() => getClaudeNativeSettings()).toThrow('Duplicate')
})
