import { describe, expect, test } from 'bun:test'
import { win32 } from 'node:path'
import {
  type ClaudeNativeSettings,
  getClaudeNativeSettings,
  setClaudeNativeProfileConfig,
} from '../src/lib/api'
import {
  automaticClaudeNativeConfig,
  normalizeClaudeNativeProfileKey,
} from '../src/lib/claude-native-settings'

const PROFILE = 'C:\\Users\\Owner\\.claude-instances\\Ashley'
const KEY = 'c:\\users\\owner\\.claude-instances\\ashley'

describe('Claude native profile settings', () => {
  test('lookup keys match server Windows path normalization', () => {
    for (const profile of [
      PROFILE,
      'C:/Users/Owner/.claude-instances/Ashley/',
      'C:\\Users\\Owner\\.claude-instances\\.\\temporary\\..\\Ashley\\',
      '\\\\Server\\Share\\Profiles\\Ashley\\',
      '\\\\Server\\Share\\..\\Ashley',
      'C:\\..\\Ashley',
      'C:\\',
      '\\\\Server\\Share',
    ]) {
      expect(normalizeClaudeNativeProfileKey(profile)).toBe(
        win32
          .normalize(profile)
          .replace(/[\\/]+$/, '')
          .toLowerCase(),
      )
    }
    expect(normalizeClaudeNativeProfileKey(PROFILE)).toBe(KEY)
  })

  test('rejects relative and non-Windows profile paths', () => {
    for (const profile of ['Ashley', 'C:Ashley', '/home/owner/ashley', '\\Ashley', '']) {
      expect(() => normalizeClaudeNativeProfileKey(profile)).toThrow(/absolute Windows/)
    }
  })

  test('preserves saved policy and port when enabling or disabling automatic startup', () => {
    const saved = { port: 9229, mode: 'prefer-native' as const }
    const settings = { [KEY]: saved }
    expect(automaticClaudeNativeConfig(settings, PROFILE, true, 19315)).toEqual({
      ...saved,
      launchDebugger: true,
    })
    expect(automaticClaudeNativeConfig(settings, PROFILE, false)).toEqual({
      ...saved,
      launchDebugger: false,
    })
    expect(settings).toEqual({ [KEY]: saved })
    expect('launchDebugger' in saved).toBe(false)
  })

  test('disabling an unconfigured profile does not register a manual connection', () => {
    expect(automaticClaudeNativeConfig({}, PROFILE, false)).toBeNull()
  })

  test('allocates successive ports without changing another profile', () => {
    const settings: ClaudeNativeSettings = {
      'c:\\other': { port: 19300, mode: 'prefer-native' },
      'c:\\another': { port: 19301, mode: 'native-only', launchDebugger: false },
    }
    expect(automaticClaudeNativeConfig(settings, PROFILE, true)).toEqual({
      port: 19302,
      mode: 'native-only',
      launchDebugger: true,
    })
    expect(Object.keys(settings)).toHaveLength(2)
  })

  test('honors an unused preferred port and skips it if another profile owns it', () => {
    expect(automaticClaudeNativeConfig({}, PROFILE, true, 19315)?.port).toBe(19315)
    expect(
      automaticClaudeNativeConfig(
        { 'c:\\other': { port: 19315, mode: 'native-only' } },
        PROFILE,
        true,
        19315,
      )?.port,
    ).toBe(19316)
  })

  test('keeps allocation inside the valid unprivileged range', () => {
    const settings: ClaudeNativeSettings = {
      'c:\\last': { port: 65535, mode: 'native-only' },
      'c:\\first': { port: 1024, mode: 'native-only' },
    }
    expect(automaticClaudeNativeConfig(settings, PROFILE, true, 65535)?.port).toBe(1025)
    for (const invalid of [0, 80, 65536, 19300.5, Number.NaN]) {
      expect(automaticClaudeNativeConfig({}, PROFILE, true, invalid)?.port).toBe(19300)
    }
  })
})

describe('Claude native settings API', () => {
  test('reads settings and writes one exact profile without starting an instance', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const settings: ClaudeNativeSettings = {
      [KEY]: { port: 19315, mode: 'native-only', launchDebugger: true },
    }
    try {
      globalThis.fetch = (async (input, init) => {
        calls.push({
          path: new URL(String(input)).pathname,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        return Response.json(init?.method === 'PUT' ? { ok: true, settings } : settings)
      }) as typeof fetch
      expect(await getClaudeNativeSettings()).toEqual(settings)
      expect(await setClaudeNativeProfileConfig(PROFILE, settings[KEY])).toEqual({
        ok: true,
        settings,
      })
      await setClaudeNativeProfileConfig(PROFILE, null)
      expect(calls).toEqual([
        { path: '/api/claude-native/settings', method: 'GET', body: undefined },
        {
          path: '/api/claude-native/settings',
          method: 'PUT',
          body: { profile: PROFILE, config: settings[KEY] },
        },
        {
          path: '/api/claude-native/settings',
          method: 'PUT',
          body: { profile: PROFILE, config: null },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('surfaces a rejected port conflict rather than reporting a saved setting', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        Response.json(
          { error: 'Native Claude port is already registered' },
          { status: 400 },
        )) as unknown as typeof fetch
      await expect(
        setClaudeNativeProfileConfig(PROFILE, {
          port: 19315,
          mode: 'native-only',
          launchDebugger: true,
        }),
      ).rejects.toThrow('Native Claude port is already registered')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
