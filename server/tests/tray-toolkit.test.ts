// server/tests/tray-toolkit.test.ts — a compiled build MUST carry its tray (2026-09-11).
//
// ⛔ THE DEFECT. The single-file exe embedded every web asset and nothing from misc\, so
// `startTrayHostIfMissing` skipped with 'no-tray-toolkit' on every run, the tray INVARIANT exempted
// the build entirely (`hasTrayToolkit: existsSync(APP_ROOT/misc)` was false), and index.ts fired a
// toast telling the person to download a different artifact. The owner's verdict on finding that in
// a fresh build: it "needs to be fixed". So the host is embedded now, written out on first run, and
// these tests pin the parts that can rot silently: where it lands, what the config says when it
// gets there, and that the build is still wired to embed it at all.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRAY_HOST_CONFIG, TRAY_HOST_EXE } from '../src/tray-host'
import {
  materializeTrayToolkit,
  patchTrayConfig,
  TRAY_ICON_FILE,
  TRAY_TOOLKIT_FILES,
  type TrayToolkitDeps,
} from '../src/tray-toolkit'

const APP_ROOT = join('D:', 'Downloads')
const EXE = join('D:', 'Downloads', 'AgentHydra.exe')
const STATE = join('C:', 'Users', 'me', '.agenthydra', 'data')
const EMBEDDED = {
  [TRAY_HOST_EXE]: '/$bunfs/tray.exe',
  [TRAY_HOST_CONFIG]: '/$bunfs/tray.json',
  [TRAY_ICON_FILE]: '/$bunfs/tray.ico',
}
const SHIPPED_CONFIG = JSON.stringify(
  { displayName: 'AgentHydra', appRoot: '..', compiledExe: 'AgentHydra.exe', iconFile: 'x.ico' },
  null,
  2,
)

/** A fake disk: what exists, what was written, and how big each file is. */
function fakeDisk(seed: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    deps: {
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
    } satisfies Partial<TrayToolkitDeps>,
  }
}

function run(overrides: Partial<TrayToolkitDeps>, disk = fakeDisk()) {
  return materializeTrayToolkit({
    appRoot: APP_ROOT,
    compiled: true,
    stateDir: STATE,
    version: '0.41.0',
    exePath: EXE,
    platform: 'win32',
    embedded: EMBEDDED,
    ...disk.deps,
    ...overrides,
  })
}

describe('patchTrayConfig', () => {
  test('stamps the RUNNING exe in, because the shipped appRoot is only right for the zip', () => {
    const out = JSON.parse(
      patchTrayConfig(SHIPPED_CONFIG, { appRoot: 'D:\\Downloads', compiledExe: 'Hydra-0.41.exe' }),
    )
    expect(out.appRoot).toBe('D:\\Downloads')
    // A renamed download still gets a working watchdog - the host restarts the exe it is told about.
    expect(out.compiledExe).toBe('Hydra-0.41.exe')
    expect(out.displayName).toBe('AgentHydra') // everything else is left alone
    expect(out.iconFile).toBe('x.ico')
  })

  test('unparseable JSON comes back untouched rather than throwing', () => {
    // A tray with a stale appRoot still shows its icon; a daemon that refuses to boot over a
    // malformed sidecar shows nothing at all.
    expect(patchTrayConfig('{not json', { appRoot: 'x', compiledExe: 'y' })).toBe('{not json')
  })
})

describe('materializeTrayToolkit', () => {
  test('writes the host, its config and its icon into a version-scoped folder', async () => {
    const disk = fakeDisk({
      [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_000),
      [EMBEDDED[TRAY_HOST_CONFIG]!]: SHIPPED_CONFIG,
      [EMBEDDED[TRAY_ICON_FILE]!]: new Uint8Array(36_000),
    })
    const got = await run({}, disk)
    expect(got.reason).toBe('materialized')
    expect(got.dir).toBe(join(STATE, 'tray', '0.41.0'))
    expect(got.wrote.sort()).toEqual([...TRAY_TOOLKIT_FILES].sort())
    const landed = JSON.parse(String(disk.files.get(join(got.dir!, TRAY_HOST_CONFIG))))
    expect(landed.appRoot).toBe(join('D:', 'Downloads'))
    expect(landed.compiledExe).toBe('AgentHydra.exe')
  })

  test('a second boot of the same version writes nothing', async () => {
    const dir = join(STATE, 'tray', '0.41.0')
    const disk = fakeDisk({
      [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_000),
      [EMBEDDED[TRAY_HOST_CONFIG]!]: SHIPPED_CONFIG,
      [EMBEDDED[TRAY_ICON_FILE]!]: new Uint8Array(36_000),
      [join(dir, TRAY_HOST_EXE)]: new Uint8Array(340_000),
      [join(dir, TRAY_ICON_FILE)]: new Uint8Array(36_000),
      [join(dir, TRAY_HOST_CONFIG)]: patchTrayConfig(SHIPPED_CONFIG, {
        appRoot: join('D:', 'Downloads'),
        compiledExe: 'AgentHydra.exe',
      }),
    })
    const got = await run({}, disk)
    expect(got.reason).toBe('already-materialized')
    expect(got.wrote).toEqual([])
  })

  test('an exe that MOVED gets its config rewritten, so the watchdog follows it', async () => {
    const dir = join(STATE, 'tray', '0.41.0')
    const disk = fakeDisk({
      [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_000),
      [EMBEDDED[TRAY_HOST_CONFIG]!]: SHIPPED_CONFIG,
      [EMBEDDED[TRAY_ICON_FILE]!]: new Uint8Array(36_000),
      [join(dir, TRAY_HOST_EXE)]: new Uint8Array(340_000),
      [join(dir, TRAY_ICON_FILE)]: new Uint8Array(36_000),
      [join(dir, TRAY_HOST_CONFIG)]: patchTrayConfig(SHIPPED_CONFIG, {
        appRoot: join('C:', 'Old', 'Place'),
        compiledExe: 'AgentHydra.exe',
      }),
    })
    const got = await run({}, disk)
    expect(got.wrote).toEqual([TRAY_HOST_CONFIG])
    expect(JSON.parse(String(disk.files.get(join(dir, TRAY_HOST_CONFIG)))).appRoot).toBe(
      join('D:', 'Downloads'),
    )
  })

  test('a real misc\\ sidecar wins and is never rewritten', async () => {
    const misc = join(APP_ROOT, 'misc')
    const disk = fakeDisk({
      [join(misc, TRAY_HOST_EXE)]: new Uint8Array(1),
      [join(misc, TRAY_HOST_CONFIG)]: SHIPPED_CONFIG,
    })
    const got = await run({}, disk)
    expect(got).toEqual({ dir: misc, reason: 'sidecar', wrote: [] })
    expect(disk.files.size).toBe(2) // nothing touched
  })

  test('each refusal says which one it is', async () => {
    expect((await run({ platform: 'linux' })).reason).toBe('not-windows')
    expect((await run({ compiled: false })).reason).toBe('not-compiled')
    expect((await run({ embedded: null })).reason).toBe('nothing-embedded')
    // A partial toolkit is not a toolkit: half of one cannot run.
    expect((await run({ embedded: { [TRAY_HOST_EXE]: '/$bunfs/tray.exe' } })).reason).toBe(
      'nothing-embedded',
    )
  })

  test('a write that fails with nothing on disk is reported, never silently skipped', async () => {
    const disk = fakeDisk({
      [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_000),
      [EMBEDDED[TRAY_HOST_CONFIG]!]: SHIPPED_CONFIG,
      [EMBEDDED[TRAY_ICON_FILE]!]: new Uint8Array(36_000),
    })
    const got = await run(
      {
        writeBytes: async () => {
          throw new Error('EPERM: read-only volume')
        },
      },
      disk,
    )
    expect(got.dir).toBeNull()
    expect(got.reason).toBe('write-failed')
    expect(got.error).toContain('EPERM')
  })

  test('a locked host that is already there is survivable - use what is on disk', async () => {
    // Windows cannot overwrite a running exe. Same version, so what is there IS this build's host.
    const dir = join(STATE, 'tray', '0.41.0')
    const disk = fakeDisk({
      [EMBEDDED[TRAY_HOST_EXE]!]: new Uint8Array(340_001), // a byte different: triggers a rewrite
      [EMBEDDED[TRAY_HOST_CONFIG]!]: SHIPPED_CONFIG,
      [EMBEDDED[TRAY_ICON_FILE]!]: new Uint8Array(36_000),
      [join(dir, TRAY_HOST_EXE)]: new Uint8Array(340_000),
      [join(dir, TRAY_HOST_CONFIG)]: SHIPPED_CONFIG,
    })
    const got = await run(
      {
        writeBytes: async () => {
          throw new Error('EBUSY: resource busy or locked')
        },
      },
      disk,
    )
    expect(got.dir).toBe(dir)
    expect(got.reason).toBe('already-materialized')
  })
})

describe('the build is still wired to embed it', () => {
  // The runtime half is useless if the build stops embedding, and that is a one-line edit away.
  const build = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'build.ts'), 'utf8')

  test('build.ts embeds the shared file list under the global the runtime reads', () => {
    expect(build).toContain('TRAY_TOOLKIT_FILES')
    expect(build).toContain('__AGENTHYDRA_EMBEDDED_TRAY__')
  })

  test('every file it embeds is actually in misc\\', () => {
    for (const name of TRAY_TOOLKIT_FILES) {
      const path = join(import.meta.dir, '..', '..', 'misc', name)
      expect(readFileSync(path).byteLength).toBeGreaterThan(0)
    }
  })
})
