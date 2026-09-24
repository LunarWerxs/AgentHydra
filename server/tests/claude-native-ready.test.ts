import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import {
  nativeHostStartupState,
  nativeLaunchReadyExpression,
  waitForNativeLaunchReady,
} from '../src/claude-native-ready'
import type { ClaudeInspectorClient } from '../src/core/claude-native/inspector-client'

const profile = 'C:\\profiles\\ashley'
const binary = 'C:\\managed\\claude.exe'

test('readiness sees the trusted embedded main view inside the file-based outer window', () => {
  let loading = false
  let trusted = true
  const contents = {
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    getType: () => 'window',
    getURL: () => (trusted ? 'https://claude.ai/epitaxy' : 'https://unrelated.example/'),
  }
  const electron = {
    app: { isReady: () => true, getPath: () => profile },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { getURL: () => 'file:///main_window/index.html' } }],
      fromWebContents: () => ({ id: 1 }),
    },
    webContents: { getAllWebContents: () => [contents] },
  }
  const snapshot = () =>
    runInNewContext(nativeLaunchReadyExpression, {
      require: () => electron,
      process: { pid: 15, execPath: binary },
      URL,
    })
  expect(snapshot()).toMatchObject({ ready: true, pid: 15, profile, executable: binary })
  loading = true
  expect(snapshot().ready).toBe(false)
  loading = false
  trusted = false
  expect(snapshot().ready).toBe(false)
})

test('registry readiness recognizes only terminal native-host startup results', () => {
  expect(
    nativeHostStartupState('[Chrome Extension MCP] Registering native host for Chrome'),
  ).toBeNull()
  expect(nativeHostStartupState('[Chrome Extension MCP] Native host sync complete')).toBe(
    'complete',
  )
  expect(nativeHostStartupState('[Chrome Extension MCP] Failed to sync native host: fixture')).toBe(
    'failed',
  )
  expect(
    nativeHostStartupState(
      '[Chrome Extension MCP] Skipping native host setup: local MCP is disabled by managed config',
    ),
  ).toBe('skipped')
})

function fixture() {
  let clock = 0
  let calls = 0
  let closes = 0
  const states = [
    { ready: false, pid: 15, executable: binary, profile },
    { ready: true, pid: 15, executable: binary, profile },
  ]
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    scan: async () => ({
      ok: true as const,
      processes: [{ pid: 15, cmdline: 'fixture', dir: profile, isMain: true }],
    }),
    connect: async () =>
      ({
        identity: { pid: 15, profile, argv: [], electron: '44.2.0', version: '2.2553.1' },
        evaluate: async () => states[Math.min(calls++, states.length - 1)],
        close: () => {
          closes++
        },
      }) as ClaudeInspectorClient,
  }
  return { deps, states, getCalls: () => calls, getCloses: () => closes }
}

test('waits for the correct app window to finish loading and closes every inspector connection', async () => {
  const f = fixture()
  expect(
    await waitForNativeLaunchReady({ profileDir: profile, binary, port: 19315 }, f.deps),
  ).toMatchObject({ pid: 15, ready: true })
  expect(f.getCalls()).toBe(2)
  expect(f.getCloses()).toBe(2)
})

test.each(['profile', 'executable'] as const)(
  'refuses a wrong %s before reporting launch success',
  async (field) => {
    const f = fixture()
    f.states[0][field] = 'C:\\wrong'
    await expect(
      waitForNativeLaunchReady({ profileDir: profile, binary, port: 19315 }, f.deps),
    ).rejects.toThrow('identity mismatch')
    expect(f.getCalls()).toBe(1)
    expect(f.getCloses()).toBe(1)
  },
)

test('an app that never finishes loading yields a bounded failure', async () => {
  const f = fixture()
  f.states[1].ready = false
  await expect(
    waitForNativeLaunchReady({ profileDir: profile, binary, port: 19315, timeoutMs: 600 }, f.deps),
  ).rejects.toThrow('deadline')
  expect(f.getCloses()).toBe(2)
})
