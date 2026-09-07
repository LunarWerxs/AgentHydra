// server/tests/github-updater-components.test.ts — audit AH-08: a compiled update brings the
// release-owned sidecars (orchestrator/, misc/) to the release's exact content, carries user state
// across, removes retired files, and rolls back as a unit.
//
// Reproduced 2026-09-05 with a synthetic release against a disposable install: the updater swapped
// the executable and overlaid misc/, but orchestrator/old-payload.txt stayed, new-payload.txt never
// arrived, and misc/obsolete-component.txt survived. Everything here runs on scratch directories;
// no real install, release or process is touched.
import { expect, test } from 'bun:test'
import {
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
  applyUpdate,
  CHECKSUM_MANIFEST,
  componentVersions,
  currentTarget,
  installedComponentVersion,
  missingComponents,
  RELEASE_COMPONENTS,
  RELEASE_VERSION_FILE,
  reconcileComponent,
  rollbackComponents,
  swapComponent,
} from '../src/github-updater'

const ORCH = RELEASE_COMPONENTS.find((c) => c.name === 'orchestrator')!
const MISC = RELEASE_COMPONENTS.find((c) => c.name === 'misc')!

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function fixture(): { root: string; bundle: string; install: string } {
  const root = mkdtempSync(join(tmpdir(), 'ah-components-'))
  const bundle = join(root, 'bundle', 'AgentHydra-9.9.9-windows-x64')
  const install = join(root, 'install')
  // The release ships the toolbox and the tray toolkit.
  put(bundle, 'orchestrator/orch.py', 'new driver')
  put(bundle, 'orchestrator/scripts/lib/hydralib.py', 'new lib')
  put(bundle, 'orchestrator/new-payload.txt', 'new')
  put(bundle, 'misc/lunarwerx-tray.exe', 'new tray')
  put(bundle, 'misc/new-component.txt', 'new')
  // The install has an OLD toolbox with live state, and a retired sidecar in misc/.
  put(install, 'AgentHydra.exe', 'old exe')
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
    swapComponent(bundle, install, ORCH, 'stampV', '9.9.9', [])
    reconcileComponent(bundle, install, MISC, '9.9.9', [])
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
  const root = mkdtempSync(join(tmpdir(), 'ah-apply-'))
  // bundleDirPath, as returned by the (mocked) downloadAndVerifyUpdate: the exe sits beside the
  // release-owned component folders, matching a real extracted archive's top level.
  const bundle = join(root, 'bundle')
  const install = join(root, 'install')
  put(bundle, 'AgentHydra.exe', 'new exe')
  put(bundle, 'orchestrator/orch.py', 'new driver')
  put(bundle, 'misc/lunarwerx-tray.exe', 'new tray')
  put(install, 'AgentHydra.exe', 'old exe')
  put(install, 'orchestrator/orch.py', 'old driver')
  put(install, 'misc/lunarwerx-tray.exe', 'old tray')
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
  const root = mkdtempSync(join(tmpdir(), 'ah-missing-'))
  try {
    put(root, 'AgentHydra.exe', 'exe')
    put(root, 'misc/lunarwerx-tray.exe', 'tray')
    expect(missingComponents(root)).toEqual(['orchestrator'])
    put(root, 'orchestrator/orch.py', 'driver')
    expect(missingComponents(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A bare single-file .exe legitimately ships none of the folders (release.yml puts them in the
// .zip only). Reading that as damage would offer every such user a "repair" that silently
// converts their install into a bundle.
test('an install with NO components at all is a bare .exe, not a damaged bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-bare-'))
  try {
    put(root, 'AgentHydra.exe', 'exe')
    expect(missingComponents(root, 'win32')).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ⛔ misc/ IS WINDOWS-ONLY (release.yml stages it inside the windows-x64 branch), so a perfectly
// healthy linux/macOS install has no misc/ and never will. Reporting it missing there made
// "already up to date" unreachable and turned every apply into a reinstall + restart that could
// never converge, because reconcile has no misc/ in the bundle to install.
test('a healthy POSIX install is complete without misc/', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-posix-'))
  try {
    put(root, 'agenthydra', 'exe')
    put(root, 'orchestrator/orch.py', 'driver')
    expect(missingComponents(root, 'linux')).toEqual([])
    expect(missingComponents(root, 'darwin')).toEqual([])
    // The same tree on Windows IS missing something, and says so.
    expect(missingComponents(root, 'win32')).toEqual(['misc'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ...and the bail-out must not swallow the real case there. Unix publishes ONLY tarballs, and
// every tarball stages orchestrator/, so there is no download that yields a componentless POSIX
// install - "all missing" on Unix is damage, not a deliberate single-file install.
test('a POSIX install missing orchestrator/ is damage, not a bare binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-posix-broken-'))
  try {
    put(root, 'agenthydra', 'exe')
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
  const names = [...block.slice(0, block.indexOf(')')).matchAll(/Name = '([A-Za-z]+)'/g)].map(
    (m) => m[1],
  )
  expect(new Set(names)).toEqual(new Set(['exe', ...RELEASE_COMPONENTS.map((c) => c.name)]))
})
