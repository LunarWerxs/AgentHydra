// server/src/core/desktop-install.ts — which Claude Desktop build is installed (win32).
//
// Anthropic ships two official Windows installers (verified 2026-07 via winget manifests
// `Anthropic.Claude` + support.claude.com "Deploy Claude Desktop for Windows"):
//   classic exe (Squirrel): %LOCALAPPDATA%\AnthropicClaude\app-<ver>\Claude.exe — a normal
//     Win32 process that accepts `--user-data-dir`, so instance launch/isolation works.
//   MSIX package: PFN `Claude_pzs8sxrjxfjjc`, binary under the ACL-locked
//     C:\Program Files\WindowsApps, AppContainer file-system virtualization redirects its
//     profile under %LOCALAPPDATA%\Packages\<PFN>\ — core/paths.ts cannot resolve a
//     launchable binary for it, so the Instances (Manager) tab cannot drive it.
// The claude.ai download page serves a ~7 MB ClaudeSetup.exe bootstrapper that installs the
// MSIX; the classic ~217 MB exe stays available at
// https://claude.ai/api/desktop/win32/<arch>/exe/latest/redirect (probed live 2026-07-10).
//
// `manageable` is never derived from the static filesystem guess alone: a running classic
// process (core/process.ts's listClaudeProcesses(), which only ever returns processes whose
// command line carried `--user-data-dir`) is direct proof a launchable classic binary exists,
// even when resolveLaunchBinary()'s static scan misses it (e.g. a portable/relocated install).
// So `manageable = directPath !== null || hasRunningClassic`.
//
// Detection is best-effort and never throws. MSIX signals, cheapest first:
//   'packages-dir' — %LOCALAPPDATA%\Packages\Claude_<13-char-hash> exists (created at package
//                    registration; the WindowsApps dir itself is ACL-locked, Packages is not)
//   'exec-alias'   — %LOCALAPPDATA%\Microsoft\WindowsApps\claude.exe app-execution alias
//   'appx'         — `Get-AppxPackage -Name Claude` (Anthropic's own documented detection), the
//                    only AUTHORITATIVE signal. Spawned whenever classic evidence (directPath or
//                    a running process) is still negative — REGARDLESS of whether a filesystem
//                    signal already fired: skipping it "whenever any fs signal fired" (the old
//                    rule) let a leftover packages-dir/exec-alias from an uninstalled MSIX pin
//                    msixDetected true forever, since the probe never got a chance to correct it.
//                    When the probe runs, its answer overrides the fs-signal verdict; when it
//                    can't run (disabled via `appxProbe: null`, or the spawn fails), the fs
//                    signals are the fallback verdict — a missing probe is never proof of
//                    absence.

import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { currentPlatform, resolveLaunchBinary } from './paths'
import { listClaudeProcesses } from './process'
import type { CMDesktopInstall } from './shared'

/** MSIX package-family dirs look like `Claude_pzs8sxrjxfjjc` (name + 13-char publisher hash). */
const MSIX_PFN_RE = /^claude_[a-z0-9]{13}$/i

export interface DetectDesktopInstallOptions {
  /** Override %LOCALAPPDATA% (tests). */
  localAppData?: string
  /** Override the classic-binary resolver (tests). */
  resolveDirect?: () => Promise<string | null>
  /** Override the Get-AppxPackage probe; pass null to disable it (tests). */
  appxProbe?: (() => Promise<boolean>) | null
  /** Override live Claude-process enumeration (tests); pass null to disable it entirely
   *  (treated as "no running instance found" rather than skipped-but-unknown). Defaults to
   *  core/process.ts's listClaudeProcesses, narrowed to the one field this module needs. */
  listRunningProcesses?: (() => Promise<{ dir?: string | null }[]>) | null
  /** Bypass the module cache. */
  fresh?: boolean
}

function localAppDataDir(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
}

/** Scans %LOCALAPPDATA%\Packages for a Claude MSIX package-family data dir. Never throws. */
function msixPackagesDirSignal(localAppData: string): boolean {
  try {
    const packagesDir = path.join(localAppData, 'Packages')
    if (!existsSync(packagesDir)) return false
    return readdirSync(packagesDir).some((name) => MSIX_PFN_RE.test(name))
  } catch {
    return false
  }
}

/** The MSIX manifest declares a `claude.exe` app-execution alias (it famously shadows the
 *  Claude Code CLI on PATH — anthropics/claude-code#24903). Never throws. */
function msixExecAliasSignal(localAppData: string): boolean {
  try {
    return existsSync(path.join(localAppData, 'Microsoft', 'WindowsApps', 'claude.exe'))
  } catch {
    return false
  }
}

/** Authoritative fallback: asks the Windows package deployment store directly. Slow (~1-2s
 *  PowerShell spawn), so callers only run it when the filesystem signals are all negative. */
async function msixAppxProbe(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '(Get-AppxPackage -Name Claude).PackageFamilyName',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true },
    )
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 8000)
    })
    const output = await Promise.race([new Response(proc.stdout).text(), timeout])
    if (output === null) {
      proc.kill()
      return false
    }
    return appxOutputHasPfn(output)
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Multiple installed versions/architectures newline-join their PFNs — hold every line to the
 *  same anchored full-match the Packages-dir scan uses, never a substring search. Exported for
 *  tests only (msixAppxProbe spawns a real PowerShell). */
export function appxOutputHasPfn(output: string): boolean {
  return output.split(/\r?\n/).some((line) => MSIX_PFN_RE.test(line.trim()))
}

/** Dev/test override: AGENTHYDRA_FAKE_DESKTOP_INSTALL = msix-only | none | ok. Always reports
 *  platform 'win32' — the whole point is exercising the win32-only Instances-tab warning, and
 *  the banner is gated on platform === 'win32', so passing through a mac/linux dev machine's
 *  real platform would silently make every fake mode a no-op there. */
function fakeResult(mode: string): CMDesktopInstall | null {
  if (mode === 'msix-only') {
    return {
      platform: 'win32',
      directPath: null,
      msixDetected: true,
      msixSignals: ['fake'],
      manageable: false,
    }
  }
  if (mode === 'none') {
    return {
      platform: 'win32',
      directPath: null,
      msixDetected: false,
      msixSignals: [],
      manageable: false,
    }
  }
  if (mode === 'ok') {
    return {
      platform: 'win32',
      directPath: 'C:\\fake\\AnthropicClaude\\app-0.0.0\\Claude.exe',
      msixDetected: false,
      msixSignals: [],
      manageable: true,
    }
  }
  return null
}

let cached: { value: CMDesktopInstall; at: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Detects how Claude Desktop is installed. win32-only problem: `manageable` is false there
 * when no classic (Squirrel) binary resolves; mac/linux always report manageable (their
 * launch paths don't depend on install format). Cached for 5 minutes. Never throws.
 */
export async function detectDesktopInstall(
  options: DetectDesktopInstallOptions = {},
): Promise<CMDesktopInstall> {
  const platform = currentPlatform()

  const fakeMode = process.env.AGENTHYDRA_FAKE_DESKTOP_INSTALL
  if (fakeMode) {
    const fake = fakeResult(fakeMode.trim().toLowerCase())
    if (fake) return fake
  }

  const injected =
    options.localAppData !== undefined ||
    options.resolveDirect !== undefined ||
    options.appxProbe !== undefined ||
    options.listRunningProcesses !== undefined
  if (!injected && !options.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value
  }

  let directPath: string | null = null
  try {
    directPath = await (options.resolveDirect ?? resolveLaunchBinary)()
  } catch {
    directPath = null
  }

  if (platform !== 'win32') {
    // resolveLaunchBinary returns launch markers ("Claude"/"claude") on mac/linux — the
    // MSIX split doesn't exist there, so the manager is always considered usable.
    const value: CMDesktopInstall = {
      platform,
      directPath,
      msixDetected: false,
      msixSignals: [],
      manageable: true,
    }
    if (!injected) cached = { value, at: Date.now() }
    return value
  }

  const localAppData = options.localAppData ?? localAppDataDir()
  const msixSignals: string[] = []
  if (msixPackagesDirSignal(localAppData)) msixSignals.push('packages-dir')
  if (msixExecAliasSignal(localAppData)) msixSignals.push('exec-alias')

  // Live-process evidence: process.ts's parseProcessRecord() only ever constructs a
  // CMProcessInfo when the command line carried `--user-data-dir` (process.ts:88-89), and
  // listClaudeProcesses()'s default (includeChildren unset/false) further filters to `isMain`
  // records — so every entry this returns has a non-null `dir` by construction; any entry at
  // all is proof a classic launchable binary exists and is currently running. Short-circuited
  // when directPath already resolved: manageable is already true, so there's no need to pay for
  // the process-enumeration spawn.
  let hasRunningClassic = false
  if (directPath === null && options.listRunningProcesses !== null) {
    try {
      const running = await (options.listRunningProcesses ?? listClaudeProcesses)()
      hasRunningClassic = running.some((p) => p.dir != null)
    } catch {
      hasRunningClassic = false
    }
  }

  const hasClassicEvidence = directPath !== null || hasRunningClassic

  // Authoritative fallback — see the header comment for why this is gated on classic evidence
  // rather than "no fs signal fired": a stale fs signal must not skip the one check that can
  // correct it.
  let probeRan = false
  let probeResult = false
  if (!hasClassicEvidence && options.appxProbe !== null) {
    try {
      probeResult = await (options.appxProbe ?? msixAppxProbe)()
      probeRan = true
    } catch {
      // Probe is best-effort only; probeRan stays false so the fs-signal verdict below applies.
    }
  }
  if (probeRan && probeResult) msixSignals.push('appx')

  // When the probe ran, it's authoritative (overrides the fs-signal verdict either way). When
  // it didn't run (skipped because classic evidence already answered the question, disabled via
  // `appxProbe: null`, or the spawn failed), fall back to the fs signals alone.
  const msixDetected = probeRan ? probeResult : msixSignals.length > 0

  const value: CMDesktopInstall = {
    platform,
    directPath,
    msixDetected,
    msixSignals,
    manageable: hasClassicEvidence,
  }
  if (!injected) cached = { value, at: Date.now() }
  return value
}
