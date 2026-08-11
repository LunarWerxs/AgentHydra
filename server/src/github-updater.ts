// GitHub-Releases self-updater for the COMPILED distribution.
//
// The git-based engine (updater-engine.mjs) can't work in a packaged build (no .git, no server/src).
// This is its compiled-mode counterpart: it asks the GitHub Releases API for the latest tag, and —
// when newer — downloads that release's bundle for THIS platform, extracts it beside the running
// binary, and swaps the self-contained executable in place. It exposes the SAME UpdateStatus / UpdateApplyResult
// shape the engine does, so updater.ts, the /api/update routes, the auto-update loop, and the web UI
// all drive it unchanged.
//
// The binary swap is the delicate part, done defensively:
//   1. Stage the download+extract INSIDE the install dir (so every rename is same-volume — a temp
//      dir on another drive would make renameSync throw EXDEV mid-swap).
//   2. PROVE the new exe runs (`<new> --version` prints the expected version) BEFORE touching the
//      live install — never swap in a binary that doesn't launch.
//   3. Rename the running exe aside (allowed on Windows even while running; fine on POSIX) so it can
//      be rolled back, then move the new exe into its place.
//   4. On any failure mid-swap, restore from the renamed-aside originals.
// Leftover `*.old-*` artifacts are swept on the next boot (cleanupStaleUpdateArtifacts).

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { APP_ROOT, SERVICE_NAME, VERSION } from './config'
import {
  beginUpdateProgress,
  finishUpdateProgress,
  setUpdateBytes,
  setUpdatePhase,
} from './update-progress'
import type { UpdateApplyResult, UpdateStatus } from './updater-engine.mjs'

const REPO = 'LunarWerxs/agenthydra'
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`

/** This binary's release target string (matches the release-asset naming: windows-x64, linux-arm64…). */
export function currentTarget(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform // darwin | linux | windows
  return `${os}-${process.arch}` // arch is already x64 | arm64
}

/** `1.2.3` → [1,2,3]; strips a leading `v`. Non-numeric parts become 0. */
function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0)
}
/** True when `remote` is a strictly newer semver than `local`. */
export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}
interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GhAsset[]
}

/** The compressed updater asset for THIS platform. A release may also expose a direct Windows
 *  `.exe` for humans; extension matching makes updater selection independent of upload order. */
export function assetForThisPlatform(assets: GhAsset[]): GhAsset | null {
  const target = currentTarget()
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
  return assets.find((a) => a.name.endsWith(`-${target}${extension}`)) ?? null
}

let cached: { value: UpdateStatus; at: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

function baseStatus(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: SERVICE_NAME,
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: null,
    branch: null,
    upstream: null,
    // A non-null `remote` keeps the web UI from graying the controls out as "no update source".
    remote: RELEASES_PAGE,
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: Date.now(),
    reason: null,
    ...overrides,
  }
}

export async function checkForUpdate(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  let release: GhRelease
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${SERVICE_NAME}/${VERSION}`,
      },
    })
    if (!res.ok) {
      return baseStatus({
        ok: false,
        reason:
          res.status === 403
            ? 'GitHub API rate limit reached — try the check again later.'
            : `couldn't reach the GitHub Releases API (HTTP ${res.status}).`,
      })
    }
    release = (await res.json()) as GhRelease
  } catch (e) {
    return baseStatus({
      ok: false,
      reason: `couldn't reach the GitHub Releases API (${e instanceof Error ? e.message : String(e)}).`,
    })
  }

  const remoteVersion = release.tag_name?.replace(/^v/, '') ?? ''
  const available = !!remoteVersion && isNewer(remoteVersion, VERSION)
  const asset = available ? assetForThisPlatform(release.assets ?? []) : null

  const value = baseStatus({
    remoteCommit: release.tag_name ?? null,
    updateAvailable: available,
    canApply: available && !!asset,
    reason: !available
      ? null
      : asset
        ? `v${remoteVersion} is available.`
        : `v${remoteVersion} is available, but no ${currentTarget()} build is attached to it — download it from ${RELEASES_PAGE}.`,
  })
  cached = { value, at: Date.now() }
  return value
}

/** Await a child process; reject on non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code ?? 'null'}`)),
    )
  })
}

/** `<exe> --version` prints exactly `expected` — the gate that a downloaded binary actually runs
 *  before it's allowed to replace the live one. */
function verifyExeVersion(exePath: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const child = spawn(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, 15_000)
      child.stdout?.on('data', (d) => {
        out += String(d)
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0 && out.trim().replace(/^v/, '') === expected.replace(/^v/, ''))
      })
    } catch {
      finish(false)
    }
  })
}

/**
 * Stream a download to disk, publishing bytes-received as it goes (see update-progress.ts).
 *
 * `Bun.write(path, response)` is the shorter way to do this and was what ran here before, but it is
 * opaque: the whole transfer is one await with nothing observable in between, which is precisely
 * what made a healthy multi-MB download look like a hang.
 *
 * `expected` comes from the release asset's own `size`. The response's content-length is preferred
 * when present (a redirect to a CDN can serve a different encoding), and a missing one is reported
 * as null rather than guessed — the UI then shows bytes without a percentage.
 */
async function writeWithProgress(
  response: Response,
  destPath: string,
  expected: number,
): Promise<void> {
  const header = Number(response.headers.get('content-length'))
  const total = Number.isFinite(header) && header > 0 ? header : (expected ?? null)
  const body = response.body
  if (!body) {
    // No readable stream (shouldn't happen for a release asset) — fall back to the simple path
    // rather than failing an update over a missing progress nicety.
    await Bun.write(destPath, response)
    return
  }

  const file = Bun.file(destPath).writer()
  let received = 0
  // Throttled: a 100 MB download delivers thousands of chunks and the UI polls once a second, so
  // publishing every chunk would be pure churn for identical readings.
  let lastPublishedAt = 0
  try {
    for await (const chunk of body) {
      file.write(chunk)
      received += (chunk as Uint8Array).byteLength
      const now = Date.now()
      if (now - lastPublishedAt >= 250) {
        lastPublishedAt = now
        setUpdateBytes(received, total)
      }
    }
    setUpdateBytes(received, total)
  } finally {
    await file.end()
  }
}

async function extract(archivePath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ])
  } else {
    await run('tar', ['-xzf', archivePath, '-C', destDir])
  }
}

/** Move `from`→`to`, falling back to copy+remove across volumes (renameSync throws EXDEV there). */
function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function fail(message: string): UpdateApplyResult {
  // Every early return in applyUpdate goes through here, so this is the one place that has to
  // settle the progress record — otherwise a failed apply leaves the UI on "Downloading…" forever,
  // which is the exact symptom this reporting exists to remove.
  finishUpdateProgress(false, message)
  return {
    ok: false,
    message,
    restartRequired: false,
    status: baseStatus({ ok: false, reason: message }),
    output: [],
  }
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
  beginUpdateProgress('Checking for the latest release…')
  const status = await checkForUpdate({ fresh: true })
  if (!status.ok) return fail(status.reason ?? 'update check failed')
  if (!status.updateAvailable) return fail('already up to date')

  const remoteVersion = (status.remoteCommit ?? '').replace(/^v/, '')
  // Re-fetch the release to get the asset URL (checkForUpdate intentionally doesn't carry it).
  let asset: GhAsset | null = null
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${SERVICE_NAME}/${VERSION}`,
      },
    })
    if (res.ok) asset = assetForThisPlatform(((await res.json()) as GhRelease).assets ?? [])
  } catch {
    asset = null
  }
  if (!asset) return fail(`no ${currentTarget()} build attached to v${remoteVersion}`)

  const exePath = process.execPath
  const exeName = basename(exePath)
  const bundledExeName = process.platform === 'win32' ? 'AgentHydra.exe' : 'agenthydra'
  const installDir = APP_ROOT
  const staging = join(installDir, '.update-staging')
  const stamp = String(status.checkedAt) // Date.now() is unavailable here; reuse the check time
  const output: string[] = []

  // Staged renames-aside, tracked so a mid-swap failure can roll them back.
  let exeMovedAside: string | null = null

  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true }) // tar -C needs it to exist; Expand-Archive/Bun.write are fine either way
    const archivePath = join(staging, asset.name)
    const totalMb = Math.round(asset.size / 1048576)
    output.push(`downloading ${asset.name} (${totalMb} MB)`)
    setUpdatePhase('downloading', `Downloading v${remoteVersion} (${totalMb} MB)…`)
    const dl = await fetch(asset.browser_download_url, {
      headers: { accept: 'application/octet-stream', 'user-agent': `${SERVICE_NAME}/${VERSION}` },
      redirect: 'follow',
    })
    if (!dl.ok) return fail(`download failed (HTTP ${dl.status})`)
    // Streamed rather than `Bun.write(path, response)` so the bytes can be COUNTED as they land.
    // This is the step the "it just sat there spinning" report was actually about: a ~100 MB
    // release over a normal connection is tens of seconds during which the old code emitted
    // nothing at all, and a slow download was indistinguishable from a dead one.
    await writeWithProgress(dl, archivePath, asset.size)

    output.push('extracting')
    setUpdatePhase('extracting', 'Extracting the update…')
    await extract(archivePath, staging)

    // Updater bundles retain the versioned wrapper directory expected by older releases, while
    // containing only the executable now. Also accept a flat archive if one is ever published.
    const entries = readdirSync(staging, { withFileTypes: true })
    const bundleDir = entries.find((e) => e.isDirectory() && e.name.startsWith('AgentHydra-'))
    const newExe = bundleDir
      ? join(staging, bundleDir.name, bundledExeName)
      : join(staging, bundledExeName)
    if (!existsSync(newExe)) return fail(`the update bundle has no ${exeName}`)

    output.push('verifying the new binary runs')
    setUpdatePhase('verifying', 'Checking that the downloaded build runs…')
    if (!(await verifyExeVersion(newExe, remoteVersion))) {
      return fail('the downloaded binary failed its version self-check — not swapping it in')
    }
    setUpdatePhase('installing', `Installing v${remoteVersion}…`)

    // --- swap the exe (rename-aside is allowed on a running Windows image) ---
    exeMovedAside = join(installDir, `${exeName}.old-${stamp}`)
    renameSync(exePath, exeMovedAside)
    moveInto(newExe, exePath)
    if (process.platform !== 'win32') {
      try {
        await run('chmod', ['+x', exePath])
      } catch {
        /* best-effort; the bundle already ships it executable */
      }
    }
    output.push(`installed v${remoteVersion}`)

    // --- refresh the tray toolkit, when the bundle carries one ---
    // The swap above moves ONE file, which is right for the daemon but would freeze misc/ at
    // whatever version first installed it. The tray host is a separate executable with its own
    // bugs (an icon that did not survive an Explorer restart, most recently), so without this a
    // fixed launcher would never reach anyone who updates in place. These are app-owned launcher
    // files, not user data: the shortcut lives at the install root and is untouched.
    const bundledMisc = bundleDir ? join(staging, bundleDir.name, 'misc') : join(staging, 'misc')
    if (existsSync(bundledMisc)) {
      try {
        cpSync(bundledMisc, join(installDir, 'misc'), { recursive: true })
        output.push('refreshed the tray toolkit')
      } catch {
        // Best-effort, and deliberately non-fatal: the daemon is already updated and working, and
        // a locked lunarwerx-tray.exe (the running tray host holds its own image) must not roll
        // back an otherwise-good update. The next update retries.
        output.push('could not refresh misc/ (in use?) — the app itself is updated')
      }
    }

    rmSync(staging, { recursive: true, force: true })
    cached = null // force the next check to re-read the (now-current) version
    finishUpdateProgress(true, `Updated to v${remoteVersion}. Restarting…`)

    return {
      ok: true,
      message: `Updated to v${remoteVersion}. Restarting…`,
      restartRequired: true,
      status: baseStatus({ currentVersion: remoteVersion, updateAvailable: false }),
      output,
    }
  } catch (e) {
    // Roll back anything we moved aside so the install is never left half-swapped.
    try {
      if (exeMovedAside && existsSync(exeMovedAside)) {
        rmSync(exePath, { force: true })
        renameSync(exeMovedAside, exePath)
      }
    } catch {
      /* rollback is best-effort */
    }
    return fail(`update failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Delete leftover `*.old-*` swap artifacts + a stale staging dir. Best-effort, run at boot. */
export function cleanupStaleUpdateArtifacts(): void {
  try {
    const installDir = APP_ROOT
    rmSync(join(installDir, '.update-staging'), { recursive: true, force: true })
    for (const name of readdirSync(installDir)) {
      if (/\.old-\d+(\.exe)?$/.test(name)) {
        rmSync(join(installDir, name), { recursive: true, force: true })
      }
    }
    const webDir = join(installDir, 'web')
    if (existsSync(webDir)) {
      for (const name of readdirSync(webDir)) {
        if (/^dist\.old-\d+$/.test(name))
          rmSync(join(webDir, name), { recursive: true, force: true })
      }
    }
  } catch {
    /* best-effort */
  }
}
