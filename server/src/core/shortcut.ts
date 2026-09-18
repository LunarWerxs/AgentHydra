// server/src/core/shortcut.ts — create a desktop launcher that opens ONE isolated Claude
// instance directly (Claude --user-data-dir=<dir>), so the user gets a double-clickable icon
// per instance without going through this manager. Never throws; every failure path returns a
// status-carrying CMActionResult (same convention as core/instances.ts).
//
// Windows (.lnk):
//   Target the STABLE Squirrel stub `%LOCALAPPDATA%\AnthropicClaude\claude.exe` — NOT the
//   versioned `app-<ver>\Claude.exe`. The versioned dir changes on every Claude Desktop update,
//   which would leave a static shortcut pointing at a deleted binary; the root stub always
//   forwards to the newest installed version (it is exactly what Anthropic's own installer
//   points its Start-Menu shortcut at — see the Squirrel-Shortcut.log). Icon comes from the
//   stable `app.ico` at that root when present. The .lnk is written with WScript.Shell via a
//   short PowerShell snippet; every dynamic value is passed through the child ENVIRONMENT
//   (CM_* vars) rather than interpolated into the script text, so an odd instance/dir name can
//   never break out into PowerShell.
//
// macOS (.command): a chmod +x shell script that runs `open -na "Claude" --args --user-data-dir`,
//   mirroring core/instances.ts's darwin launch.
// Linux (.desktop): a chmod +x desktop entry with `Exec=claude --user-data-dir=<dir>`.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectDesktopInstall } from './desktop-install'
import { currentPlatform, normalizePath, resolveLaunchBinary } from './paths'
import { capturePipedProc } from './process.ts'
import type { CMActionResult } from './shared'

/** Writing a .lnk is a COM call against WScript.Shell - instant, or stalled on something that
 *  will not resolve itself. Twenty seconds is far past any healthy run. */
const SHORTCUT_TIMEOUT_MS = 20_000

export interface CreateShortcutOptions {
  /** Override the destination directory (tests). Defaults to the user's Desktop. */
  desktopDir?: string
}

/** Characters that are invalid in a Windows filename (also awkward on POSIX). Kept as a plain
 *  string so no control-char bytes or \x escapes live in this source file. */
const INVALID_FILENAME_CHARS = '<>:"/\\|?*'

/** Sanitizes an instance name into a safe shortcut-file leaf: drops the invalid filename chars
 *  above plus any control char (codepoint <= 0x1F), keeping spaces and dashes so "work client-a"
 *  stays readable. Falls back to 'instance' if nothing printable survives. Exported for tests. */
export function safeShortcutBase(name: string): string {
  const cleaned = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) > 31 && !INVALID_FILENAME_CHARS.includes(ch))
    .join('')
    .trim()
  return cleaned.length > 0 ? cleaned : 'instance'
}

/** Windows: the STABLE root Squirrel stub, when present. Prefer this over the versioned exe so
 *  the shortcut survives Claude Desktop updates (the versioned dir is replaced on each update). */
function stableWinLaunchTarget(): string | null {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const stub = path.join(localAppData, 'AnthropicClaude', 'claude.exe')
  return existsSync(stub) ? stub : null
}

/** The MSIX-aware "no launchable binary" explanation, matching openInstance's wording so the
 *  failure toast is identical whether the user hit Open or Create-shortcut. Best-effort. */
async function noBinaryMessage(): Promise<string> {
  try {
    const install = await detectDesktopInstall()
    if (install.platform === 'win32') {
      return install.msixDetected
        ? 'Only the MSIX (Windows Apps) build of Claude Desktop is installed; it cannot be launched with an isolated profile. Install the classic Windows installer.'
        : 'No Claude Desktop installation was found. Install the classic Windows installer.'
    }
  } catch {
    // Detection is best-effort; fall through to the generic message.
  }
  return 'No Claude launch binary could be resolved.'
}

// PowerShell that writes the .lnk. Reads every value from the environment (CM_*) so nothing
// user-controlled is interpolated into the script body. CM_DEST_DIR empty => resolve the real
// Desktop (OneDrive-redirect aware via GetFolderPath). Emits the final path on stdout.
const PS_CREATE_LNK = [
  "$ErrorActionPreference = 'Stop'",
  '$desktop = $env:CM_DEST_DIR',
  "if (-not $desktop) { $desktop = [Environment]::GetFolderPath('Desktop') }",
  "if (-not $desktop) { throw 'Could not resolve the Desktop folder.' }",
  'if (-not (Test-Path -LiteralPath $desktop)) { New-Item -ItemType Directory -Path $desktop -Force | Out-Null }',
  "$lnk = Join-Path $desktop ($env:CM_LNK_NAME + '.lnk')",
  '$ws = New-Object -ComObject WScript.Shell',
  '$sc = $ws.CreateShortcut($lnk)',
  '$sc.TargetPath = $env:CM_TARGET',
  '$sc.Arguments = $env:CM_ARGS',
  '$sc.WorkingDirectory = $env:CM_WORKDIR',
  '$sc.IconLocation = $env:CM_ICON',
  '$sc.Description = $env:CM_DESC',
  '$sc.Save()',
  'Write-Output $lnk',
].join('\n')

async function createWindowsShortcut(
  normDir: string,
  name: string,
  options: CreateShortcutOptions,
): Promise<CMActionResult> {
  const target = stableWinLaunchTarget() ?? (await resolveLaunchBinary())
  if (!target) {
    return {
      ok: false,
      action: 'shortcut',
      dir: normDir,
      message: await noBinaryMessage(),
      data: {},
    }
  }

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const appIco = path.join(localAppData, 'AnthropicClaude', 'app.ico')
  const icon = existsSync(appIco) ? `${appIco},0` : `${target},0`
  const base = safeShortcutBase(`Claude - ${name}`)

  type CaptureProc = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let proc: CaptureProc
  try {
    proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        PS_CREATE_LNK,
      ],
      {
        env: {
          ...process.env,
          CM_DEST_DIR: options.desktopDir ?? '',
          CM_LNK_NAME: base,
          CM_TARGET: target,
          // Quote the dir so a path with spaces survives the shortcut command line.
          CM_ARGS: `--user-data-dir="${normDir}"`,
          CM_WORKDIR: path.dirname(target),
          CM_ICON: icon,
          CM_DESC: `Launch the ${name} Claude Desktop instance`,
        },
        windowsHide: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ) as CaptureProc
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'shortcut',
      dir: normDir,
      message: `Failed to create shortcut: ${message}`,
      data: {},
    }
  }

  try {
    // Bounded (swept 2026-09-18): this awaited both drains and proc.exited, which settles on the
    // SLOWEST of the three - and a powershell that inherits its pipes to a grandchild, or simply
    // never returns, pinned the caller with no deadline anywhere.
    const {
      stdout,
      stderr,
      code: exitCode,
    } = await capturePipedProc(proc, {
      timeoutMs: SHORTCUT_TIMEOUT_MS,
    })
    const lnkPath = stdout.trim()
    if (exitCode === 0 && lnkPath) {
      return {
        ok: true,
        action: 'shortcut',
        dir: normDir,
        message: 'created',
        data: { path: lnkPath, target },
      }
    }
    return {
      ok: false,
      action: 'shortcut',
      dir: normDir,
      message: stderr.trim() || `powershell exited with code ${exitCode}`,
      data: {},
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'shortcut',
      dir: normDir,
      message: `Failed to create shortcut: ${message}`,
      data: {},
    }
  }
}

/** Writes a chmod +x launcher file (mac .command / linux .desktop) to the desktop. Shared tail
 *  for the two POSIX platforms; both mirror core/instances.ts's per-OS launch command. */
function writePosixLauncher(normDir: string, filePath: string, contents: string): CMActionResult {
  try {
    const destDir = path.dirname(filePath)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    writeFileSync(filePath, contents, 'utf8')
    chmodSync(filePath, 0o755)
    return {
      ok: true,
      action: 'shortcut',
      dir: normDir,
      message: 'created',
      data: { path: filePath },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'shortcut',
      dir: normDir,
      message: `Failed to create shortcut: ${message}`,
      data: {},
    }
  }
}

/**
 * Creates a desktop launcher for the given instance dir. On Windows this is a `.lnk`; on macOS a
 * `.command` script; on Linux a `.desktop` entry. Each launches Claude Desktop with
 * `--user-data-dir=<dir>` (the same isolation the manager's Open button uses). Never throws.
 */
export async function createInstanceShortcut(
  dir: string,
  options: CreateShortcutOptions = {},
): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  if (!normDir || normDir.trim().length === 0) {
    return {
      ok: false,
      action: 'shortcut',
      dir: dir || null,
      message: 'Instance directory cannot be empty.',
      data: {},
    }
  }

  const name = path.basename(normDir)
  const plat = currentPlatform()

  if (plat === 'win32') return createWindowsShortcut(normDir, name, options)

  const desktopDir = options.desktopDir ?? path.join(os.homedir(), 'Desktop')
  const base = safeShortcutBase(`Claude - ${name}`)

  if (plat === 'darwin') {
    const filePath = path.join(desktopDir, `${base}.command`)
    const contents = `#!/bin/bash\nopen -na "Claude" --args --user-data-dir "${normDir}"\n`
    return writePosixLauncher(normDir, filePath, contents)
  }

  // linux
  const filePath = path.join(desktopDir, `${base}.desktop`)
  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${base}`,
    `Comment=Launch the ${name} Claude Desktop instance`,
    `Exec=claude --user-data-dir="${normDir}"`,
    'Terminal=false',
    '',
  ].join('\n')
  return writePosixLauncher(normDir, filePath, contents)
}
