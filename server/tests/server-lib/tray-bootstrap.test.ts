// Tests for the shared tray-bootstrap primitive (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/tray-bootstrap.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/tray-bootstrap.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// ⛔ TWO REGRESSIONS THIS GUARDS, both found live on 2026-09-11 in a freshly compiled AgentHydra
// that showed no tray icon at all:
//   1. THE COMPILED EXE CARRIED NO TRAY. It embedded the web assets and nothing from misc\, so no
//      host could exist beside it and every app's README had written that down as a limitation.
//   2. THE PROBE ANSWERED "RUNNING" WHEN NO TRAY EXISTED. `Get-Process -Name x -ErrorAction
//      SilentlyContinue | Select -ExpandProperty Id` exits 1 when the process is ABSENT
//      (SilentlyContinue hides the error text, not the error record), and the old code read a
//      non-zero exit as "running" - so "start the tray if nothing else did" could never fire.

import { describe, expect, test } from 'bun:test'
import { join as nodeJoin } from 'node:path'
import {
  isCompleteTrayToolkit,
  materializeTrayToolkit,
  parseTrayHostCount,
  patchTrayConfig,
  startTrayHostIfMissing,
  TRAY_HOST_EXE,
  trayHostDecision,
  trayToolkitFiles,
} from '../../src/tray-bootstrap.mjs'

const CONFIG = 'DemoApp-Tray.json'
const ICON = 'DemoApp.ico'
const FILES = [TRAY_HOST_EXE, CONFIG, ICON]
const EMBEDDED = {
  [TRAY_HOST_EXE]: '/$bunfs/tray.exe',
  [CONFIG]: '/$bunfs/tray.json',
  [ICON]: '/$bunfs/tray.ico',
}
const SHIPPED = JSON.stringify({ appRoot: '..', compiledExe: 'demoapp.exe', displayName: 'Demo' })
const j = (...parts: string[]) => parts.join('\\')

function fakeDisk(seed: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files,
    deps: {
      joinPath: j,
      dirOf: (p: string) => p.split('\\').slice(0, -1).join('\\'),
      baseOf: (p: string) => p.split('\\').pop() ?? p,
      exists: (p: string) => files.has(p) || dirs.has(p),
      sizeOf: (p: string) => {
        const v = files.get(p)
        return v === undefined ? null : typeof v === 'string' ? v.length : v.byteLength
      },
      readBytes: async (p: string) => {
        const v = files.get(p)
        if (v === undefined) throw new Error(`no such embedded file ${p}`)
        return typeof v === 'string' ? new TextEncoder().encode(v) : v
      },
      readText: async (p: string) => {
        const v = files.get(p)
        if (v === undefined) throw new Error(`no such file ${p}`)
        return typeof v === 'string' ? v : new TextDecoder().decode(v)
      },
      writeBytes: async (p: string, b: Uint8Array) => void files.set(p, b),
      writeText: async (p: string, t: string) => void files.set(p, t),
      mkdir: (p: string) => void dirs.add(p),
    },
  }
}

const seeded = () =>
  fakeDisk({
    [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_480),
    [EMBEDDED[CONFIG]!]: SHIPPED,
    [EMBEDDED[ICON]!]: new Uint8Array(35_943),
  })

function place(disk: ReturnType<typeof fakeDisk>, over: Record<string, unknown> = {}) {
  return materializeTrayToolkit({
    appRoot: j('D:', 'Downloads'),
    compiled: true,
    stateDir: j('C:', 'state'),
    version: '1.2.3',
    exePath: j('D:', 'Downloads', 'DemoApp.exe'),
    configFile: CONFIG,
    iconFile: ICON,
    platform: 'win32',
    embedded: EMBEDDED,
    ...disk.deps,
    ...over,
  })
}

describe('a compiled build places its own tray', () => {
  test('writes host, config and icon into a version-scoped folder', async () => {
    const disk = seeded()
    const got = await place(disk)
    expect(got.reason).toBe('materialized')
    expect(got.dir).toBe(j('C:', 'state', 'tray', '1.2.3'))
    expect(got.wrote.sort()).toEqual([...FILES].sort())
    const landed = JSON.parse(String(disk.files.get(j(got.dir!, CONFIG))))
    // The shipped ".." is only right for the extracted zip; a single-file exe lives anywhere.
    expect(landed.appRoot).toBe(j('D:', 'Downloads'))
    expect(landed.compiledExe).toBe('DemoApp.exe')
    expect(landed.displayName).toBe('Demo')
  })

  test('a second boot of the same version writes nothing', async () => {
    const disk = seeded()
    await place(disk)
    const again = await place(disk)
    expect(again.reason).toBe('already-materialized')
    expect(again.wrote).toEqual([])
  })

  test('an exe that MOVED gets its config rewritten, so the watchdog follows it', async () => {
    const disk = seeded()
    await place(disk)
    const moved = await place(disk, { exePath: j('E:', 'Apps', 'DemoApp.exe') })
    expect(moved.wrote).toEqual([CONFIG])
    expect(JSON.parse(String(disk.files.get(j(moved.dir!, CONFIG)))).appRoot).toBe(j('E:', 'Apps'))
  })

  test('a misc\\ sidecar wins and is never rewritten', async () => {
    const disk = fakeDisk({
      [j('D:', 'Downloads', 'misc', TRAY_HOST_EXE)]: new Uint8Array(1),
      [j('D:', 'Downloads', 'misc', CONFIG)]: SHIPPED,
    })
    const got = await place(disk)
    expect(got).toEqual({ dir: j('D:', 'Downloads', 'misc'), reason: 'sidecar', wrote: [] })
    expect(disk.files.size).toBe(2)
  })

  test('every refusal says which one it is', async () => {
    expect((await place(seeded(), { platform: 'linux' })).reason).toBe('not-windows')
    expect((await place(seeded(), { compiled: false })).reason).toBe('not-compiled')
    expect((await place(seeded(), { embedded: null })).reason).toBe('nothing-embedded')
    // Half a toolkit is not a toolkit.
    expect(
      (await place(seeded(), { embedded: { [TRAY_HOST_EXE]: '/$bunfs/tray.exe' } })).reason,
    ).toBe('nothing-embedded')
    expect(isCompleteTrayToolkit({ [TRAY_HOST_EXE]: 'x' }, FILES)).toBe(false)
    expect(isCompleteTrayToolkit(EMBEDDED, FILES)).toBe(true)
    expect(trayToolkitFiles({ configFile: CONFIG, iconFile: ICON })).toEqual(FILES)
  })

  test('a write that fails with nothing on disk is reported, never silently skipped', async () => {
    const got = await place(seeded(), {
      writeBytes: async () => {
        throw new Error('EPERM: read-only volume')
      },
    })
    expect(got.dir).toBeNull()
    expect(got.reason).toBe('write-failed')
    expect(got.error).toContain('EPERM')
  })

  test('unparseable config JSON is left alone rather than thrown', () => {
    expect(patchTrayConfig('{not json', { appRoot: 'a', compiledExe: 'b' })).toBe('{not json')
  })
})

describe('the probe answers a tri-state', () => {
  test('a count is a number, and only a number', () => {
    expect(parseTrayHostCount('0\r\n')).toBe(false)
    expect(parseTrayHostCount('2')).toBe(true)
  })

  test('no answer is UNKNOWN, never a zero', () => {
    // The old bug in miniature: "no output" is not "no process", it is "no answer".
    expect(parseTrayHostCount('')).toBeNull()
    expect(parseTrayHostCount('Get-Process : not recognized')).toBeNull()
  })
})

describe('starting the host', () => {
  const start = (isRunning: () => Promise<boolean | null>, over: Record<string, unknown> = {}) => {
    const spawned: Array<{ exe: string; cwd: string; config: string }> = []
    return {
      spawned,
      run: () =>
        startTrayHostIfMissing({
          appRoot: j('C:', 'app'),
          compiled: true,
          configFile: CONFIG,
          hideTray: () => false,
          platform: 'win32',
          exists: () => true,
          isRunning,
          spawnHost: (exe: string, cwd: string, config: string) =>
            void spawned.push({ exe, cwd, config }),
          ...over,
        }),
    }
  }

  test('an absent host is started, a present one is left alone', async () => {
    const absent = start(async () => false)
    expect((await absent.run()).start).toBe(true)
    expect(absent.spawned).toHaveLength(1)
    const present = start(async () => true)
    expect(await present.run()).toMatchObject({ start: false, reason: 'already-running' })
    expect(present.spawned).toEqual([])
  })

  test('an UNKNOWN starts it - the regression that kept the tray off', async () => {
    const unsure = start(async () => null)
    expect((await unsure.run()).start).toBe(true)
    expect(unsure.spawned).toHaveLength(1)
  })

  test('a materialized directory is used instead of <appRoot>/misc, and is the cwd', async () => {
    // nodeJoin, not the backslash `j` the fake disk uses: startTrayHostIfMissing joins with
    // node:path, so on the Linux CI leg a hand-written 'C:\...\tray.exe' can only ever fail.
    // It did, on this test's first run - the lib was right and the expectation was Windows-shaped.
    const dir = nodeJoin('C:', 'state', 'tray', '1.2.3')
    const s = start(async () => false, { toolkitDir: dir })
    await s.run()
    expect(s.spawned[0]).toEqual({
      exe: nodeJoin(dir, TRAY_HOST_EXE),
      cwd: dir,
      config: CONFIG,
    })
  })

  test('no toolkit anywhere is a named fault, not a silent skip', async () => {
    const s = start(async () => false, { exists: () => false })
    expect(await s.run()).toMatchObject({ start: false, reason: 'no-tray-toolkit' })
    expect(s.spawned).toEqual([])
  })

  test('the pure decision keeps every skip distinguishable', () => {
    const base = {
      platform: 'win32',
      compiled: true,
      toolkitPresent: true,
      hideTray: false,
      alreadyRunning: false,
    }
    expect(trayHostDecision(base)).toEqual({ start: true })
    expect(trayHostDecision({ ...base, platform: 'darwin' })).toMatchObject({
      reason: 'not-windows',
    })
    expect(trayHostDecision({ ...base, compiled: false })).toMatchObject({ reason: 'not-compiled' })
    expect(trayHostDecision({ ...base, hideTray: true })).toMatchObject({
      reason: 'hidden-by-setting',
    })
  })
})
