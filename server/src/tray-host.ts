// server/src/tray-host.ts - start the tray host when this build has one and nothing else did.
//
// THE FIELD FAILURE (owner's PC, 2026-09-03): a v0.37.0 release ZIP, extracted, misc\ intact,
// lunarwerx-tray.exe sitting right beside the daemon - and no tray icon, ever. The daemon had been
// started by double-clicking AgentHydra.exe, which is what the release notes say to do and what
// install.ps1's Start Menu shortcut did too. The exe runs the daemon and opens the UI; the tray
// icon, the auto-restart supervisor and Quit all live in the tray HOST, and nothing in that launch
// path starts it. The docs asked for misc\Create-Shortcut.ps1 as a separate manual step, which is
// a step nobody takes, and the daemon's own no-tray notice (index.ts) is correctly silent here
// because misc\ EXISTS. So the app was fully functional and quietly missing its most visible
// feature on a machine that had done nothing wrong.
//
// The fix is for the daemon to start the host itself. The host was designed for this direction:
// with `onStrayDaemon: "attach"` (misc/AgentHydra-Tray.json, the shipped default) a tray host that
// finds a daemon already serving simply attaches to it instead of spawning a second one
// (tray-host-native/src/main.rs, `existing` / `started_by_us`). It claims a named mutex first, so
// even a race with a person double-clicking the shortcut at the same instant cannot produce two
// icons: the loser opens the UI and exits.
//
// The decision is a pure function, tested; the process probe and the spawn are injected.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const TRAY_HOST_EXE = 'lunarwerx-tray.exe'
export const TRAY_HOST_CONFIG = 'AgentHydra-Tray.json'

export type TrayHostSkipReason =
  | 'not-windows'
  | 'not-compiled'
  | 'no-tray-toolkit'
  | 'hidden-by-setting'
  | 'already-running'

export type TrayHostDecision = { start: true } | { start: false; reason: TrayHostSkipReason }

/** Should THIS daemon start the tray host? Order matters only for which reason is reported:
 *  the cheapest, most structural facts first, the probe that costs a process spawn last. */
export function trayHostDecision(input: {
  platform: string
  compiled: boolean
  toolkitPresent: boolean
  hideTray: boolean
  alreadyRunning: boolean
}): TrayHostDecision {
  // The host is a Win32 program (Shell_NotifyIconW); there is nothing to start elsewhere.
  if (input.platform !== 'win32') return { start: false, reason: 'not-windows' }
  // A source checkout is launched from its own AgentHydra.lnk, which IS the tray host. Starting
  // it from `bun run dev` would give every developer a tray icon they did not ask for.
  if (!input.compiled) return { start: false, reason: 'not-compiled' }
  // No runnable host anywhere: neither a misc\ sidecar nor a copy written out of the binary
  // (tray-toolkit.ts). That is now a FAULT to report, not the normal single-file case it used to be.
  if (!input.toolkitPresent) return { start: false, reason: 'no-tray-toolkit' }
  // "Hide tray icon" is the person saying no. Starting a host that immediately hides its icon
  // would still add a process they turned off on purpose.
  if (input.hideTray) return { start: false, reason: 'hidden-by-setting' }
  // The normal case after an auto-update relaunch: the host outlives the daemon it supervises
  // and is already there. Also the case after the person used the shortcut.
  if (input.alreadyRunning) return { start: false, reason: 'already-running' }
  return { start: true }
}

/**
 * Is a tray host process alive right now? `true` / `false` / `null` = could not tell.
 *
 * ⛔ THE PROBE USED TO ANSWER "RUNNING" PRECISELY WHEN THE TRAY WAS ABSENT (found 2026-09-11,
 * live, while fixing the compiled build's missing toolkit). It ran
 * `Get-Process -Name lunarwerx-tray -ErrorAction SilentlyContinue | Select -ExpandProperty Id`
 * and treated a non-zero exit as "running". But -ErrorAction SilentlyContinue suppresses the
 * error TEXT, not the error RECORD: with no such process, powershell.exe exits 1. Measured:
 * absent -> exit 1, present -> exit 0. So the one case this function exists to detect was the one
 * case it got backwards, `startTrayHostIfMissing` skipped with 'already-running' on every single
 * run since it shipped, and the tray invariant believed an icon was there when none was. The
 * count below cannot raise an error record at all, so "absent" is a number and not an exit code.
 *
 * The unknown is returned rather than resolved here because the two callers need OPPOSITE
 * defaults, and that is exactly what hid this bug: starting a host when unsure is harmless (the
 * host claims a named mutex, so the loser just exits), while SHUTTING THE DAEMON DOWN when unsure
 * would be a disaster. PowerShell is a console program, hence windowsHide
 * (scripts/checks/spawn-console-window.mjs).
 */
/** The probe's stdout -> true / false / null. Separate and exported because it is the part that
 *  rots: a count is a number, an empty string or a PowerShell banner is NOT a zero. */
export function parseTrayHostCount(stdout: string): boolean | null {
  const count = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(count) ? count > 0 : null
}

export async function trayHostProcessState(): Promise<boolean | null> {
  try {
    const name = TRAY_HOST_EXE.replace(/\.exe$/i, '')
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-Process | Where-Object { $_.ProcessName -eq '${name}' }).Count`,
      ],
      { windowsHide: true, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return parseTrayHostCount(out)
  } catch {
    return null
  }
}

/** The tray-invariant's view: an unknown reads as RUNNING, because that invariant can shut the
 *  daemon down and every ambiguity there must resolve towards staying alive (tray-invariant.ts). */
export async function trayHostRunning(): Promise<boolean> {
  return (await trayHostProcessState()) ?? true
}

/** Launch the host detached. It is a GUI program, so NO windowsHide here: libuv's hide flag sets
 *  SW_HIDE, which a GUI app obeys, and the host's own windows (its balloon, its menu) would never
 *  show while the spawn still reported success. Same rule that once broke reveal-folder. The config
 *  argument is resolved by the host against ITS OWN exe directory (main.rs config_path), so passing
 *  the bare filename is exactly what the shortcut passes. */
function defaultSpawnHost(exe: string, cwd: string): void {
  const child = spawn(exe, [TRAY_HOST_CONFIG], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
}

export async function startTrayHostIfMissing(deps: {
  appRoot: string
  compiled: boolean
  hideTray: () => boolean
  /** Where the toolkit actually is, when it is not `<appRoot>/misc` - a single-file build writes
   *  it out of its own binary at boot (tray-toolkit.ts), and that copy is just as runnable. */
  toolkitDir?: string | null
  platform?: string
  exists?: (path: string) => boolean
  /** Tri-state (see trayHostProcessState). An UNKNOWN means start: a second host cannot appear,
   *  because the host claims a named mutex and the loser exits - whereas not starting leaves the
   *  app with no icon, which is the failure this whole module exists to prevent. */
  isRunning?: () => Promise<boolean | null>
  spawnHost?: (exe: string, cwd: string) => void
}): Promise<TrayHostDecision & { exe: string }> {
  const miscDir = deps.toolkitDir || join(deps.appRoot, 'misc')
  const exe = join(miscDir, TRAY_HOST_EXE)
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  // Cheap facts first so the process probe only ever runs when it could change the answer.
  const structural = trayHostDecision({
    platform,
    compiled: deps.compiled,
    toolkitPresent: exists(exe) && exists(join(miscDir, TRAY_HOST_CONFIG)),
    hideTray: deps.hideTray(),
    alreadyRunning: false,
  })
  if (!structural.start) return { ...structural, exe }
  const decision = trayHostDecision({
    platform,
    compiled: deps.compiled,
    toolkitPresent: true,
    hideTray: false,
    alreadyRunning: (await (deps.isRunning ?? trayHostProcessState)()) ?? false,
  })
  if (decision.start) (deps.spawnHost ?? defaultSpawnHost)(exe, miscDir)
  return { ...decision, exe }
}
