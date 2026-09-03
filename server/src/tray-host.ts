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
  // The single-file .exe: misc\ does not exist, and index.ts says so once with a toast instead.
  if (!input.toolkitPresent) return { start: false, reason: 'no-tray-toolkit' }
  // "Hide tray icon" is the person saying no. Starting a host that immediately hides its icon
  // would still add a process they turned off on purpose.
  if (input.hideTray) return { start: false, reason: 'hidden-by-setting' }
  // The normal case after an auto-update relaunch: the host outlives the daemon it supervises
  // and is already there. Also the case after the person used the shortcut.
  if (input.alreadyRunning) return { start: false, reason: 'already-running' }
  return { start: true }
}

/** Is a tray host process alive right now? PowerShell is a console program, hence windowsHide
 *  (scripts/checks/spawn-console-window.mjs). Never throws: an unavailable probe reads as
 *  "running", which skips the start - the failure mode that can only ever leave things as they
 *  were, never one that adds a second host. */
export async function trayHostRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name '${TRAY_HOST_EXE.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
      ],
      { windowsHide: true, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    )
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return true
    return /\d/.test(out)
  } catch {
    return true
  }
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
  platform?: string
  exists?: (path: string) => boolean
  isRunning?: () => Promise<boolean>
  spawnHost?: (exe: string, cwd: string) => void
}): Promise<TrayHostDecision & { exe: string }> {
  const miscDir = join(deps.appRoot, 'misc')
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
    alreadyRunning: await (deps.isRunning ?? trayHostRunning)(),
  })
  if (decision.start) (deps.spawnHost ?? defaultSpawnHost)(exe, miscDir)
  return { ...decision, exe }
}
