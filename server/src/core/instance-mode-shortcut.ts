// Creates a one-click desktop shortcut for the lightweight Instances launcher.
//
// Source checkout: wscript.exe -> misc/Instance-Launch.vbs
// Packaged release: compiled agenthydra executable -> --instances
//
// Dynamic values are passed to PowerShell through the environment so paths containing quotes or
// other shell-significant characters never get interpolated into the script.

import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { APP_ROOT, IS_COMPILED } from '../config'
import type { CMActionResult } from './shared'

const SHORTCUT_NAME = 'AgentHydra Instances'

export interface InstanceModeShortcutSpecOptions {
  appRoot?: string
  compiled?: boolean
  execPath?: string
  systemRoot?: string
}

export interface InstanceModeShortcutSpec {
  target: string
  args: string
  workingDir: string
  icon: string
}

export interface CreateInstanceModeShortcutOptions extends InstanceModeShortcutSpecOptions {
  desktopDir?: string
  platform?: NodeJS.Platform
}

export function instanceModeShortcutSpec(
  options: InstanceModeShortcutSpecOptions = {},
): InstanceModeShortcutSpec {
  const appRoot = options.appRoot ?? APP_ROOT
  const compiled = options.compiled ?? IS_COMPILED
  const execPath = options.execPath ?? process.execPath

  if (compiled) {
    return {
      target: execPath,
      args: '--instances',
      workingDir: appRoot,
      icon: `${execPath},0`,
    }
  }

  // `win32.join`, not the ambient `join`: these are Windows paths whatever host is running the
  // function, and the ambient one follows the HOST. On a POSIX box (CI's ubuntu leg) it splices
  // `C:\Windows` and `System32` with a forward slash and hands back a path that is neither valid
  // Windows nor matched by anything. Pinning the separator keeps the unit tests meaningful
  // off-Windows; on Windows `win32.join` IS `join`, so this changes no shipped behavior.
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
  const target = win32.join(systemRoot, 'System32', 'wscript.exe')
  const launcher = win32.join(appRoot, 'misc', 'Instance-Launch.vbs')
  const appIcon = win32.join(appRoot, 'misc', 'AgentHydra.ico')
  return {
    target,
    args: `"${launcher}"`,
    workingDir: appRoot,
    icon: `${existsSync(appIcon) ? appIcon : target},0`,
  }
}

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

/** Create the lightweight Instances launcher on the user's actual Desktop (OneDrive-aware). */
export async function createInstanceModeShortcut(
  options: CreateInstanceModeShortcutOptions = {},
): Promise<CMActionResult> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return {
      ok: false,
      action: 'instance-mode-shortcut',
      dir: null,
      message: 'The quick Instances desktop shortcut is currently available on Windows only.',
      data: {},
    }
  }

  const spec = instanceModeShortcutSpec(options)
  if (!existsSync(spec.target)) {
    return {
      ok: false,
      action: 'instance-mode-shortcut',
      dir: null,
      message: `Shortcut target was not found: ${spec.target}`,
      data: {},
    }
  }
  if (!(options.compiled ?? IS_COMPILED)) {
    const launcher = win32.join(options.appRoot ?? APP_ROOT, 'misc', 'Instance-Launch.vbs')
    if (!existsSync(launcher)) {
      return {
        ok: false,
        action: 'instance-mode-shortcut',
        dir: null,
        message: `Quick Instances launcher was not found: ${launcher}`,
        data: {},
      }
    }
  }

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
          CM_LNK_NAME: SHORTCUT_NAME,
          CM_TARGET: spec.target,
          CM_ARGS: spec.args,
          CM_WORKDIR: spec.workingDir,
          CM_ICON: spec.icon,
          CM_DESC: 'Open the lightweight AgentHydra Instances launcher',
        },
        windowsHide: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ) as CaptureProc
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      action: 'instance-mode-shortcut',
      dir: null,
      message: `Failed to create shortcut: ${message}`,
      data: {},
    }
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const shortcutPath = stdout.trim()
    if (exitCode === 0 && shortcutPath) {
      return {
        ok: true,
        action: 'instance-mode-shortcut',
        dir: null,
        message: 'created',
        data: { path: shortcutPath, target: spec.target, args: spec.args },
      }
    }
    return {
      ok: false,
      action: 'instance-mode-shortcut',
      dir: null,
      message: stderr.trim() || `powershell exited with code ${exitCode}`,
      data: {},
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      action: 'instance-mode-shortcut',
      dir: null,
      message: `Failed to create shortcut: ${message}`,
      data: {},
    }
  }
}
