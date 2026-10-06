// server/tests/github-updater-components.test.ts — audit AH-08: a compiled update brings the
// release-owned sidecars (orchestrator/, misc/) to the release's exact content, carries user state
// across, removes retired files, and rolls back as a unit.
//
// Reproduced 2026-09-05 with a synthetic release against a disposable install: the updater swapped
// the executable and overlaid misc/, but orchestrator/old-payload.txt stayed, new-payload.txt never
// arrived, and misc/obsolete-component.txt survived. Everything here runs on scratch directories;
// no real install, release or process is touched.
import { afterAll, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { VERSION } from '../src/config'
import {
  type ApplyUpdateDeps,
  applyUpdate,
  CHECKSUM_MANIFEST,
  cleanupStaleUpdateArtifacts,
  componentVersions,
  currentTarget,
  type DeskSeam,
  installedComponentVersion,
  missingComponents,
  RELEASE_COMPONENTS,
  RELEASE_VERSION_FILE,
  reconcileComponent,
  rollbackComponents,
  swapComponent,
} from '../src/github-updater'

const APP = RELEASE_COMPONENTS.find((c) => c.name === 'app')!
const ORCH = RELEASE_COMPONENTS.find((c) => c.name === 'orchestrator')!
const MISC = RELEASE_COMPONENTS.find((c) => c.name === 'misc')!
const DESK2 = RELEASE_COMPONENTS.find((c) => c.name === 'desk2')!

const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'ah-components-'))
afterAll(() => rmSync(SHARED_ROOT, { recursive: true, force: true }))
let scratchSeq = 0
function scratchRoot(): string {
  const dir = join(SHARED_ROOT, `s${scratchSeq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function fixture(): { root: string; bundle: string; install: string } {
  const root = scratchRoot()
  const bundle = join(root, 'bundle', 'AgentHydra-9.9.9-windows-x64')
  const install = join(root, 'install')
  // The release ships the daemon, toolbox, tray toolkit and window.
  put(bundle, 'app/server.js', 'new daemon')
  put(bundle, 'app/release.json', '{"version":"9.9.9"}')
  put(bundle, 'app/bun-version', '1.0.0')
  put(bundle, 'app/web/index.html', 'new ui')
  put(bundle, 'orchestrator/orch.py', 'new driver')
  put(bundle, 'orchestrator/scripts/lib/hydralib.py', 'new lib')
  put(bundle, 'orchestrator/new-payload.txt', 'new')
  put(bundle, 'misc/lunarwerx-tray.exe', 'new tray')
  put(bundle, 'misc/new-component.txt', 'new')
  put(bundle, 'desk2/server/src/index.ts', 'new desk')
  put(bundle, 'desk2/runtime/bun.exe', 'new bun')
  // The install has old versions with live state and retired sidecars.
  put(install, 'AgentHydra.exe', 'old exe')
  put(install, 'app/server.js', 'old daemon')
  put(install, 'app/obsolete.js', 'old file')
  put(install, 'app/web/old.html', 'old ui')
  put(install, 'orchestrator/orch.py', 'old driver')
  put(install, 'orchestrator/old-payload.txt', 'old')
  put(install, 'orchestrator/state/holds.json', '{"held":["abc"]}')
  put(install, 'orchestrator/state/trash/abc/manifest.json', '{}')
  put(install, 'misc/lunarwerx-tray.exe', 'old tray')
  put(install, 'misc/obsolete-component.txt', 'retired')
  return { root, bundle, install }
}

test('a swap brings orchestrator/ to the release content, keeps state, removes retired files, stamps the version', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp1', '9.9.9', output)
    expect(aside).not.toBeNull()
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('new driver')
    expect(existsSync(join(o, 'new-payload.txt'))).toBe(true)
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(false) // retired, gone by construction
    expect(readFileSync(join(o, 'state/holds.json'), 'utf8')).toBe('{"held":["abc"]}') // carried
    expect(existsSync(join(o, 'state/trash/abc/manifest.json'))).toBe(true)
    expect(installedComponentVersion(install, 'orchestrator')).toBe('9.9.9')
    // The previous copy sits aside for rollback until the caller discards it.
    expect(existsSync(aside!.aside)).toBe(true)
    expect(readFileSync(join(aside!.aside, 'old-payload.txt'), 'utf8')).toBe('old')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a swap brings app/ to the release content and removes obsolete assets', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const aside = swapComponent(bundle, install, APP, 'stamp1', '9.9.9', output)
    expect(aside).not.toBeNull()
    const a = join(install, 'app')
    expect(readFileSync(join(a, 'server.js'), 'utf8')).toBe('new daemon')
    expect(readFileSync(join(a, 'release.json'), 'utf8')).toBe('{"version":"9.9.9"}')
    expect(readFileSync(join(a, 'bun-version'), 'utf8')).toBe('1.0.0')
    expect(readFileSync(join(a, 'web/index.html'), 'utf8')).toBe('new ui')
    expect(existsSync(join(a, 'obsolete.js'))).toBe(false) // retired, gone by construction
    expect(existsSync(join(a, 'web/old.html'))).toBe(false)
    expect(installedComponentVersion(install, 'app')).toBe('9.9.9')
    // The previous copy sits aside for rollback until the caller discards it.
    expect(existsSync(aside!.aside)).toBe(true)
    expect(readFileSync(join(aside!.aside, 'obsolete.js'), 'utf8')).toBe('old file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed swap leaves the previous copy exactly where it was, state included', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    // The aside rename succeeds; putting the NEW copy in place fails (a lock, a full disk), and
    // the copy fallback fails with it, which is what a real EBUSY on the destination does.
    const failing = () => {
      throw new Error('EBUSY: injected')
    }
    expect(() =>
      swapComponent(bundle, install, ORCH, 'stamp2', '9.9.9', output, { move: failing }),
    ).toThrow('EBUSY')
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('old driver')
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(true)
    expect(readFileSync(join(o, 'state/holds.json'), 'utf8')).toBe('{"held":["abc"]}')
    expect(existsSync(join(o, 'new-payload.txt'))).toBe(false)
    expect(readdirSync(install).filter((n) => n.includes('.old-'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rollbackComponents restores the aside copy after a later step failed', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp3', '9.9.9', output)!
    // ...the exe swap then fails; the caller rolls the components back.
    rollbackComponents(install, [aside])
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('old driver')
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(true)
    expect(existsSync(join(o, 'state/holds.json'))).toBe(true)
    expect(existsSync(aside.aside)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bare-executable install acquires the toolbox through an update', () => {
  const { root, bundle, install } = fixture()
  try {
    rmSync(join(install, 'orchestrator'), { recursive: true, force: true })
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp4', '9.9.9', output)
    expect(aside).toBeNull() // nothing to roll back to
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('new driver')
    expect(installedComponentVersion(install, 'orchestrator')).toBe('9.9.9')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bundle that ships no orchestrator/ keeps the installed one untouched', () => {
  const { root, bundle, install } = fixture()
  try {
    rmSync(join(bundle, 'orchestrator'), { recursive: true, force: true })
    const output: string[] = []
    expect(swapComponent(bundle, install, ORCH, 'stamp5', '9.9.9', output)).toBeNull()
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    expect(output.join('\n')).toContain('ships no orchestrator/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcile brings misc/ to the release content and removes the retired sidecar', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const r = reconcileComponent(bundle, install, MISC, '9.9.9', output)
    expect(r.installed).toBe(true)
    const m = join(install, 'misc')
    expect(readFileSync(join(m, 'lunarwerx-tray.exe'), 'utf8')).toBe('new tray')
    expect(existsSync(join(m, 'new-component.txt'))).toBe(true)
    expect(existsSync(join(m, 'obsolete-component.txt'))).toBe(false)
    expect(r.removed).toEqual(['obsolete-component.txt'])
    expect(r.locked).toEqual([])
    expect(installedComponentVersion(install, 'misc')).toBe('9.9.9')
    // Idempotent: a second pass changes nothing and removes nothing.
    const again = reconcileComponent(bundle, install, MISC, '9.9.9', [])
    expect(again.removed).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the version stamp reads null on an install that predates stamping', () => {
  const { root, install } = fixture()
  try {
    expect(installedComponentVersion(install, 'orchestrator')).toBeNull()
    expect(RELEASE_VERSION_FILE).toBe('.release-version')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('componentVersions reports null before stamping and the stamped version after a swap/reconcile', () => {
  const { root, bundle, install } = fixture()
  try {
    expect(componentVersions(install)).toEqual(
      RELEASE_COMPONENTS.map((c) => ({ name: c.name, version: null })),
    )
    for (const comp of RELEASE_COMPONENTS) {
      if (comp.strategy === 'swap') swapComponent(bundle, install, comp, 'stampV', '9.9.9', [])
      else reconcileComponent(bundle, install, comp, '9.9.9', [])
    }
    expect(componentVersions(install)).toEqual(
      RELEASE_COMPONENTS.map((c) => ({ name: c.name, version: '9.9.9' })),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// applyUpdate is the real production orchestration function: the tests above only exercise its
// extracted pure helpers (swapComponent/reconcileComponent/rollbackComponents), so the WIRING —
// the orchestratorBusy() refusal gate, the swap-then-exe-rename ordering, and the rollback the
// catch block performs — was unguarded. Driven here with injected deps (ApplyUpdateDeps) against
// scratch directories only: no real install, process, or network is touched.
function applyFixture(): { root: string; bundle: string; install: string } {
  const root = scratchRoot()
  // bundleDirPath, as returned by the (mocked) downloadAndVerifyUpdate: the exe sits beside the
  // release-owned component folders, matching a real extracted archive's top level.
  const bundle = join(root, 'bundle')
  const install = join(root, 'install')
  put(bundle, 'AgentHydra.exe', 'new exe')
  put(bundle, 'app/server.js', 'new daemon')
  put(bundle, 'app/release.json', '{"version":"9.9.9"}')
  put(bundle, 'orchestrator/orch.py', 'new driver')
  put(bundle, 'misc/lunarwerx-tray.exe', 'new tray')
  put(bundle, 'desk2/server/src/index.ts', 'new desk')
  put(bundle, 'desk2/runtime/bun.exe', 'new bun')
  put(install, 'AgentHydra.exe', 'old exe')
  put(install, 'app/server.js', 'old daemon')
  put(install, 'app/release.json', '{"version":"9.9.8"}')
  put(install, 'orchestrator/orch.py', 'old driver')
  put(install, 'misc/lunarwerx-tray.exe', 'old tray')
  put(install, 'desk2/server/src/index.ts', 'old desk')
  put(install, 'desk2/runtime/bun.exe', 'old bun')
  return { root, bundle, install }
}

const FAKE_ASSET_NAME = `AgentHydra-9.9.9-${currentTarget()}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`

/** `remoteCommit` matters for the repair path: it only engages when the latest release IS this
 *  build's version, so a "no update available" fake must say so with the REAL version. */
function fakeCheckForUpdate(over: { updateAvailable?: boolean; remoteCommit?: string } = {}) {
  const available = over.updateAvailable ?? true
  return async () => ({
    ok: true,
    service: 'agenthydra',
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: over.remoteCommit ?? (available ? 'v9.9.9' : `v${VERSION}`),
    branch: null,
    upstream: null,
    remote: 'https://github.com/LunarWerxs/agenthydra/releases',
    dirty: false,
    updateAvailable: available,
    canApply: available,
    checkedAt: 1735689600000,
    reason: null,
  })
}

function fakeFetchLatestRelease() {
  return async () => ({
    res: {
      ok: true,
      json: async () => ({
        assets: [
          { name: FAKE_ASSET_NAME, browser_download_url: 'https://example.invalid/a', size: 1 },
          { name: CHECKSUM_MANIFEST, browser_download_url: 'https://example.invalid/s', size: 1 },
        ],
      }),
    },
  })
}

test('applyUpdate refuses while a toolbox script is running and changes nothing on disk', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const result = await applyUpdate({
      installDir: install,
      exePath: join(install, 'AgentHydra.exe'),
      checkForUpdate: fakeCheckForUpdate(),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('orchestrator script is running')
    // Nothing moved: refused before any component swap or the exe rename.
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    expect(readFileSync(join(install, 'misc/lunarwerx-tray.exe'), 'utf8')).toBe('old tray')
    expect(readdirSync(install).some((n) => n.includes('.old-'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyUpdate rolls back the executable AND every already-swapped component when the exe swap fails', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const result = await applyUpdate({
      installDir: install,
      exePath: join(install, 'AgentHydra.exe'),
      checkForUpdate: fakeCheckForUpdate(),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => false,
      // The rename-aside succeeds; putting the new exe in place fails, the same EBUSY/full-disk
      // shape swapComponent's own failure test injects.
      move: () => {
        throw new Error('EBUSY: injected')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('update failed')
    // The exe is restored...
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
    // ...and so is orchestrator/, which had already been swapped to the new release before the
    // exe step ran and failed.
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    // No .old- artifacts left behind anywhere in the install.
    expect(readdirSync(install).some((n) => n.includes('.old-'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── the repair path (2026-09-07) ────────────────────────────────────────────────────────────────
//
// The component-aware updater landed IN v0.39.0, so the update that INSTALLED 0.39.0 was performed
// by the old one and brought the executable alone. The result is an install running the latest
// version with no orchestrator/ - every chat-moving tool answers `no orch.py under <dir>` - which
// no update can ever repair, because there is no newer version to update TO. Measured on a real
// install that day. These pin the fall-through that lets the current version be reinstalled.

test('missingComponents names a component that is absent from a bundle install', () => {
  const root = scratchRoot()
  try {
    put(root, 'AgentHydra.exe', 'exe')
    put(root, 'misc/lunarwerx-tray.exe', 'tray')
    put(root, 'desk2/server/src/index.ts', 'desk')
    expect(missingComponents(root)).toEqual(['app', 'orchestrator'])
    put(root, 'orchestrator/orch.py', 'driver')
    expect(missingComponents(root)).toEqual(['app'])
    put(root, 'app/server.js', 'daemon')
    expect(missingComponents(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A bare single-file .exe legitimately ships none of the folders (release.yml puts them in the
// .zip only), so on Windows the tray and toolbox folders are not "missing" from it. The required
// parts are app/ (daemon and assets) and desk2/ (window); a bare binary is missing those.
test('a bare .exe is not damaged, except that it needs the daemon and window', () => {
  const root = scratchRoot()
  try {
    put(root, 'AgentHydra.exe', 'exe')
    expect(missingComponents(root, 'win32')).toEqual(['app', 'desk2'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ⛔ misc/ IS WINDOWS-ONLY (release.yml stages it inside the windows-x64 branch), so a perfectly
// healthy linux/macOS install has no misc/ and never will. Reporting it missing there made
// "already up to date" unreachable and turned every apply into a reinstall + restart that could
// never converge, because reconcile has no misc/ in the bundle to install.
test('a healthy POSIX install is complete without misc/', () => {
  const root = scratchRoot()
  try {
    put(root, 'agenthydra', 'exe')
    put(root, 'app/server.js', 'daemon')
    put(root, 'orchestrator/orch.py', 'driver')
    put(root, 'desk2/server/src/index.ts', 'desk')
    expect(missingComponents(root, 'linux')).toEqual([])
    expect(missingComponents(root, 'darwin')).toEqual([])
    // The same tree on Windows IS missing something, and says so.
    expect(missingComponents(root, 'win32')).toEqual(['misc'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ...and the bail-out must not swallow the real case there. Unix publishes ONLY tarballs, and
// every tarball stages orchestrator/ and app/, so there is no download that yields a componentless POSIX
// install - "all missing" on Unix is damage, not a deliberate single-file install.
test('a POSIX install missing orchestrator/ is damage, not a bare binary', () => {
  const root = scratchRoot()
  try {
    put(root, 'agenthydra', 'exe')
    put(root, 'app/server.js', 'daemon')
    put(root, 'desk2/server/src/index.ts', 'desk')
    expect(missingComponents(root, 'linux')).toEqual(['orchestrator'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyUpdate reinstalls the CURRENT version when a component is missing', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    // The install this repairs: latest version, misc/ present, orchestrator/ gone.
    rmSync(join(install, 'orchestrator'), { recursive: true, force: true })
    const result = await applyUpdate({
      installDir: install,
      exePath: join(install, 'AgentHydra.exe'),
      // No update available - the ONLY thing that used to matter, and the whole refusal.
      checkForUpdate: fakeCheckForUpdate({ updateAvailable: false }),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => false,
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('new driver')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ⛔ A REPAIR MAY RESTORE WHAT IS MISSING; IT MAY NEVER TAKE THE APP BACKWARDS. `updateAvailable`
// is also false when the newest RELEASE is older than this build (a yanked release, a rolled-back
// tag), and there "reinstall the latest" is a silent downgrade of the exe and both folders.
test('a missing component does NOT license a downgrade when the latest release is older', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    rmSync(join(install, 'orchestrator'), { recursive: true, force: true })
    const result = await applyUpdate({
      installDir: install,
      exePath: join(install, 'AgentHydra.exe'),
      checkForUpdate: fakeCheckForUpdate({ updateAvailable: false, remoteCommit: 'v0.0.1' }),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('already up to date')
    // Says WHICH versions, so "up to date" on an install newer than the latest release is not a
    // mystery, and nothing was touched.
    expect(result.message).toContain('v0.0.1')
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
    expect(existsSync(join(install, 'orchestrator'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a complete install on the current version is still refused as up to date', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const result = await applyUpdate({
      installDir: install,
      exePath: join(install, 'AgentHydra.exe'),
      checkForUpdate: fakeCheckForUpdate({ updateAvailable: false }),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('already up to date')
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// install.ps1 (the manual install, audit AH-40) carries its own component list in PowerShell. It
// must name exactly what the self-updater swaps, or a manual install and an in-app update would
// disagree about what a release IS. Parsed from the script rather than declared twice by hand.
test('install.ps1 and the self-updater agree on the release components', () => {
  const script = readFileSync(resolve(import.meta.dir, '../../install.ps1'), 'utf8')
  const block = script.slice(script.indexOf('$ReleaseComponents = @('))
  const names = [...block.slice(0, block.indexOf(')')).matchAll(/Name = '([A-Za-z0-9]+)'/g)].map(
    (m) => m[1],
  )
  // app/ (the daemon bundle) is install.ps1's alone for now: the updater treats it as part of the exe.
  expect(new Set(names)).toEqual(new Set(['exe', 'app', ...RELEASE_COMPONENTS.map((c) => c.name)]))
})

// ── desk2/ as a release component (2.0.0) ────────────────────────────────────────────────────────
//
// AgentHydra 2.0's window is desk2/ (its own bun, its own server) and it ships in the archive. The
// updater has to replace it while its chat hosts - detached processes running desk2/runtime/bun.exe -
// are still alive, so it is reconciled file by file, a busy executable is moved aside, and Desk 2's
// server is stopped before and started after. Every Desk 2 effect below is the injected DeskSeam:
// nothing here starts a real Desk 2, opens a window or touches the network.

const DESK_INDEX = 'desk2/server/src/index.ts'

/** A Desk 2 that logs what it was asked, with what desk2/ held at that moment. */
function fakeDesk(install: string, over: Partial<DeskSeam> = {}) {
  const events: string[] = []
  const seen = () => {
    try {
      return readFileSync(join(install, DESK_INDEX), 'utf8')
    } catch {
      return 'absent'
    }
  }
  const desk: DeskSeam = {
    present: () => existsSync(join(install, DESK_INDEX)),
    stop: async () => {
      events.push(`stop:${seen()}`)
      return { ok: true }
    },
    start: async (o) => {
      events.push(`start:${seen()}:window=${Boolean(o?.window)}`)
      return { ok: true }
    },
    windowOpen: async () => false,
    ...over,
  }
  return { desk, events }
}

function applyDeps(
  install: string,
  bundle: string,
  over: Partial<ApplyUpdateDeps> = {},
): ApplyUpdateDeps {
  return {
    installDir: install,
    exePath: join(install, 'AgentHydra.exe'),
    checkForUpdate: fakeCheckForUpdate(),
    fetchLatestRelease: fakeFetchLatestRelease(),
    downloadAndVerifyUpdate: async () => ({
      newExe: join(bundle, 'AgentHydra.exe'),
      bundleDirPath: bundle,
    }),
    orchestratorBusy: () => false,
    ...over,
  }
}

test('a bundle with desk2/ is installed with Desk 2 stopped before and started after', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    put(install, 'desk2/retired.txt', 'a file the release no longer ships')
    const { desk, events } = fakeDesk(install)
    const result = await applyUpdate(applyDeps(install, bundle, { desk }))
    expect(result.ok).toBe(true)
    // Stopped while the OLD files were still there, started once the NEW ones were in place.
    expect(events).toEqual(['stop:old desk', 'start:new desk:window=false'])
    expect(readFileSync(join(install, 'desk2/runtime/bun.exe'), 'utf8')).toBe('new bun')
    expect(existsSync(join(install, 'desk2/retired.txt'))).toBe(false)
    expect(installedComponentVersion(install, 'desk2')).toBe('9.9.9')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Desk 2 comes back with its window only when one was open', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const { desk, events } = fakeDesk(install, { windowOpen: async () => true })
    const result = await applyUpdate(applyDeps(install, bundle, { desk }))
    expect(result.ok).toBe(true)
    expect(events).toEqual(['stop:old desk', 'start:new desk:window=true'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a busy bun.exe is moved aside, the new one lands, and the boot sweep removes the aside once it is free', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const bun = join(install, 'desk2/runtime/bun.exe')
    // A running executable cannot be overwritten (EBUSY) but can be renamed: the copy refuses while
    // a file sits at the destination, which is the state a running bun.exe leaves it in.
    const busy = (from: string, to: string) => {
      if (to === bun && existsSync(to)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      cpSync(from, to, { force: true })
    }
    const { desk } = fakeDesk(install)
    const result = await applyUpdate(applyDeps(install, bundle, { desk, copy: busy }))
    expect(result.ok).toBe(true)
    expect(readFileSync(bun, 'utf8')).toBe('new bun')
    const stamp = '1735689600000' // the fake check's checkedAt, which names the asides
    const aside = `${bun}.old-${stamp}`
    expect(readFileSync(aside, 'utf8')).toBe('old bun')
    expect(result.output.join('\n')).toContain('in use moved aside')

    // A later update must not mistake the aside for a retired release file...
    reconcileComponent(bundle, install, DESK2, '9.9.9', [], { copy: busy, stamp: '1' })
    expect(existsSync(aside)).toBe(true)
    // ...and the next boot, with the process gone, sweeps it (and the second one) and nothing else.
    cleanupStaleUpdateArtifacts(install)
    expect(existsSync(aside)).toBe(false)
    expect(existsSync(`${bun}.old-1`)).toBe(false)
    expect(readFileSync(bun, 'utf8')).toBe('new bun')
    expect(readFileSync(join(install, 'desk2/server/src/index.ts'), 'utf8')).toBe('new desk')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file in use that cannot be replaced is put back, not left as a hole', () => {
  const { root, bundle, install } = applyFixture()
  try {
    const bun = join(install, 'desk2/runtime/bun.exe')
    const alwaysBusy = (from: string, to: string) => {
      if (to === bun) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      cpSync(from, to, { force: true })
    }
    const out: string[] = []
    const r = reconcileComponent(bundle, install, DESK2, '9.9.9', out, {
      copy: alwaysBusy,
      stamp: '7',
    })
    expect(r.locked).toEqual(['runtime/bun.exe'])
    expect(readFileSync(bun, 'utf8')).toBe('old bun')
    expect(existsSync(`${bun}.old-7`)).toBe(false)
    // Everything else still landed.
    expect(readFileSync(join(install, DESK_INDEX), 'utf8')).toBe('new desk')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed swap rolls back as before and still starts Desk 2 again', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const { desk, events } = fakeDesk(install)
    const result = await applyUpdate(
      applyDeps(install, bundle, {
        desk,
        move: () => {
          throw new Error('EBUSY: injected')
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    // desk2/ was never touched (it is reconciled after the exe lands) and Desk 2 is back up on it.
    expect(readFileSync(join(install, DESK_INDEX), 'utf8')).toBe('old desk')
    expect(events).toEqual(['stop:old desk', 'start:old desk:window=false'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a Desk 2 that will not stop is not replaced under, and is started again', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    const { desk, events } = fakeDesk(install, {
      stop: async () => ({ ok: false, reason: 'Desk 2 still answers on port 7798' }),
    })
    const result = await applyUpdate(applyDeps(install, bundle, { desk }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Desk 2 would not stop')
    expect(readFileSync(join(install, 'AgentHydra.exe'), 'utf8')).toBe('old exe')
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    expect(readFileSync(join(install, DESK_INDEX), 'utf8')).toBe('old desk')
    expect(events).toEqual(['start:old desk:window=false'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bundle that ships no desk2/ leaves Desk 2 running and its files alone', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    rmSync(join(bundle, 'desk2'), { recursive: true, force: true })
    const { desk, events } = fakeDesk(install)
    const result = await applyUpdate(applyDeps(install, bundle, { desk }))
    expect(result.ok).toBe(true)
    expect(events).toEqual([])
    expect(readFileSync(join(install, DESK_INDEX), 'utf8')).toBe('old desk')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the boot sweep removes moved-aside files inside component folders and the exe aside beside the exe', () => {
  const root = scratchRoot()
  try {
    put(root, 'AgentHydra.exe', 'exe')
    put(root, 'AgentHydra.exe.old-111', 'old exe')
    put(root, 'desk2/runtime/bun.exe', 'bun')
    put(root, 'desk2/runtime/bun.exe.old-222', 'old bun')
    put(root, 'desk2/launcher/HydraDesk2.exe.old-333', 'old window host')
    put(root, 'desk2/node_modules/pkg/index.js', 'code')
    cleanupStaleUpdateArtifacts(root)
    expect(existsSync(join(root, 'AgentHydra.exe.old-111'))).toBe(false)
    expect(existsSync(join(root, 'desk2/runtime/bun.exe.old-222'))).toBe(false)
    expect(existsSync(join(root, 'desk2/launcher/HydraDesk2.exe.old-333'))).toBe(false)
    expect(existsSync(join(root, 'AgentHydra.exe'))).toBe(true)
    expect(existsSync(join(root, 'desk2/runtime/bun.exe'))).toBe(true)
    expect(existsSync(join(root, 'desk2/node_modules/pkg/index.js'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── release-layout update (2.0.0) ─────────────────────────────────────────────────────────────────
//
// In a release install, the launcher and runtime/bun are separate: the launcher starts the daemon
// through bun, so process.execPath is runtime/bun(.exe), not the launcher. An update must swap the
// launcher (LAUNCHER_PATH), not the running bun, and must never touch runtime/ — the launcher
// itself owns it. The sweep must clean runtime/*.old-* files that the launcher created.

test('a release-install update swaps the launcher, not the daemon runtime, and runtime asides are swept', async () => {
  const { root, bundle, install } = applyFixture()
  try {
    // Release layout: the launcher starts the daemon through bun, so the daemon's process.execPath
    // is runtime/bun(.exe), not the launcher. The update must swap the launcher, not the bun.
    mkdirSync(join(install, 'runtime'), { recursive: true })
    put(install, 'runtime/bun.exe', 'current bun')
    put(install, 'runtime/bun.version', '1.0.0')
    // The launcher is what gets replaced, not the bun the daemon runs on.
    const launcherPath = join(install, 'AgentHydra.exe')
    const bun = join(install, 'runtime/bun.exe')

    // The update process: the launcher's path is passed explicitly (in production it comes from
    // config.LAUNCHER_PATH; in tests IS_RELEASE is false so it would default to process.execPath).
    const result = await applyUpdate({
      installDir: install,
      exePath: launcherPath,
      checkForUpdate: fakeCheckForUpdate(),
      fetchLatestRelease: fakeFetchLatestRelease(),
      downloadAndVerifyUpdate: async () => ({
        newExe: join(bundle, 'AgentHydra.exe'),
        bundleDirPath: bundle,
      }),
      orchestratorBusy: () => false,
    })

    expect(result.ok).toBe(true)
    // The launcher was swapped.
    expect(readFileSync(launcherPath, 'utf8')).toBe('new exe')
    // The daemon's bun was left BYTE FOR BYTE AS IT WAS — never moved, never replaced.
    expect(readFileSync(bun, 'utf8')).toBe('current bun')
    expect(readFileSync(join(install, 'runtime/bun.version'), 'utf8')).toBe('1.0.0')
    // The old launcher sits aside for potential rollback until the next boot.
    const stamp = '1735689600000' // the fake check's checkedAt
    const launcherAside = `${launcherPath}.old-${stamp}`
    expect(readFileSync(launcherAside, 'utf8')).toBe('old exe')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the boot sweep removes old bun files from runtime/ but leaves the current one', () => {
  const root = scratchRoot()
  try {
    put(root, 'runtime/bun.exe', 'current bun')
    put(root, 'runtime/bun.exe.old-111', 'old bun 1')
    put(root, 'runtime/bun.exe.old-222', 'old bun 2')
    put(root, 'runtime/bun.version', '1.0.0')
    put(root, 'app/server.js', 'daemon')

    cleanupStaleUpdateArtifacts(root)

    // The current bun stays.
    expect(readFileSync(join(root, 'runtime/bun.exe'), 'utf8')).toBe('current bun')
    expect(readFileSync(join(root, 'runtime/bun.version'), 'utf8')).toBe('1.0.0')
    // The old ones are swept.
    expect(existsSync(join(root, 'runtime/bun.exe.old-111'))).toBe(false)
    expect(existsSync(join(root, 'runtime/bun.exe.old-222'))).toBe(false)
    // Other asides (like launcher) still work.
    put(root, 'AgentHydra.exe.old-333', 'old launcher')
    cleanupStaleUpdateArtifacts(root)
    expect(existsSync(join(root, 'AgentHydra.exe.old-333'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
