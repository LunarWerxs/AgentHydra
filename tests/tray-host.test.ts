// tests/tray-host.test.ts - the daemon starts the tray host exactly when it should, and never twice.
//
// The field bug this guards (2026-09-03): a release ZIP with the whole tray toolkit beside the
// daemon, launched by double-clicking the exe, and no tray icon on the machine ever. Every
// condition below is a way that fix could regress into either the old silence or a worse thing,
// a second tray host - so each one is a test, not a comment.

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  startTrayHostIfMissing,
  TRAY_HOST_CONFIG,
  TRAY_HOST_EXE,
  trayHostDecision,
} from '../server/src/tray-host'

const ready = {
  platform: 'win32',
  compiled: true,
  toolkitPresent: true,
  hideTray: false,
  alreadyRunning: false,
}

test('the release ZIP launched from the bare exe starts the host', () => {
  expect(trayHostDecision(ready)).toEqual({ start: true })
})

test('each blocker is named, in the order it is cheapest to know', () => {
  expect(trayHostDecision({ ...ready, platform: 'darwin' })).toEqual({
    start: false,
    reason: 'not-windows',
  })
  expect(trayHostDecision({ ...ready, compiled: false })).toEqual({
    start: false,
    reason: 'not-compiled',
  })
  expect(trayHostDecision({ ...ready, toolkitPresent: false })).toEqual({
    start: false,
    reason: 'no-tray-toolkit',
  })
  expect(trayHostDecision({ ...ready, hideTray: true })).toEqual({
    start: false,
    reason: 'hidden-by-setting',
  })
  expect(trayHostDecision({ ...ready, alreadyRunning: true })).toEqual({
    start: false,
    reason: 'already-running',
  })
})

test('a source checkout never gets a tray icon it did not ask for, even with the toolkit present', () => {
  // The toolkit IS present in every source checkout (misc/ is committed), so this is the case
  // that would give every `bun run dev` a tray host.
  expect(trayHostDecision({ ...ready, compiled: false }).start).toBe(false)
})

test('startTrayHostIfMissing spawns the host from misc/ with the config by bare filename', async () => {
  const spawned: Array<{ exe: string; cwd: string }> = []
  const appRoot = join('C:', 'apps', 'AgentHydra')
  const result = await startTrayHostIfMissing({
    appRoot,
    compiled: true,
    hideTray: () => false,
    platform: 'win32',
    exists: () => true,
    isRunning: async () => false,
    spawnHost: (exe, cwd) => spawned.push({ exe, cwd }),
  })
  expect(result.start).toBe(true)
  expect(spawned).toEqual([
    { exe: join(appRoot, 'misc', TRAY_HOST_EXE), cwd: join(appRoot, 'misc') },
  ])
  // The config file name is what the shortcut passes too; the host resolves it against its own
  // exe directory, so both launch paths read the same JSON.
  expect(TRAY_HOST_CONFIG).toBe('AgentHydra-Tray.json')
})

test('a host that is already running is left alone - the probe runs, the spawn does not', async () => {
  let probes = 0
  let spawns = 0
  const result = await startTrayHostIfMissing({
    appRoot: 'C:/x',
    compiled: true,
    hideTray: () => false,
    platform: 'win32',
    exists: () => true,
    isRunning: async () => {
      probes++
      return true
    },
    spawnHost: () => {
      spawns++
    },
  })
  expect(result).toMatchObject({ start: false, reason: 'already-running' })
  expect(probes).toBe(1)
  expect(spawns).toBe(0)
})

test('structural blockers short-circuit BEFORE the process probe is paid for', async () => {
  let probes = 0
  const missingToolkit = await startTrayHostIfMissing({
    appRoot: 'C:/x',
    compiled: true,
    hideTray: () => false,
    platform: 'win32',
    exists: () => false,
    isRunning: async () => {
      probes++
      return false
    },
    spawnHost: () => {},
  })
  expect(missingToolkit).toMatchObject({ start: false, reason: 'no-tray-toolkit' })
  const hidden = await startTrayHostIfMissing({
    appRoot: 'C:/x',
    compiled: true,
    hideTray: () => true,
    platform: 'win32',
    exists: () => true,
    isRunning: async () => {
      probes++
      return false
    },
    spawnHost: () => {},
  })
  expect(hidden).toMatchObject({ start: false, reason: 'hidden-by-setting' })
  expect(probes).toBe(0)
})

test('the toolkit means BOTH files: an exe without its config is not a toolkit', async () => {
  const result = await startTrayHostIfMissing({
    appRoot: 'C:/x',
    compiled: true,
    hideTray: () => false,
    platform: 'win32',
    exists: (p) => p.endsWith(TRAY_HOST_EXE),
    isRunning: async () => false,
    spawnHost: () => {
      throw new Error('must not spawn')
    },
  })
  expect(result).toMatchObject({ start: false, reason: 'no-tray-toolkit' })
})
