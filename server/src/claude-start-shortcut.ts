// server/src/claude-start-shortcut.ts - keep Claude's own Start-menu shortcut on the real install.
//
// Claude started from anywhere but its Squirrel install (so from every AgentHydra managed copy,
// claude-native-launch.ts) writes %APPDATA%\Microsoft\Windows\Start Menu\Programs\Claude.lnk at its
// OWN exe, to carry the `electron.app.Claude` notification id. Measured 2026-09-28: written 5 s
// after a managed launch on 2026-09-26, it pointed at <data>\claude-native\2.9939.2-...\claude.exe,
// a copy with no updater, so Claude opened from the Start menu (or a taskbar pin made from it) stayed
// on 2.9939.2 for good and said it could not update (owner: "wtf is claude pinned and can't update").
// This points it back at the install's stable stub, which always opens the newest build, and keeps
// the shortcut's notification id. It touches the shortcut only while it names a managed copy.

import { join } from 'node:path'
import { DATA_DIR } from './config'
import { spawnCaptured } from './core/process'

export type ShortcutRepair = 'repointed' | 'unchanged' | 'failed'

export interface ShortcutPaths {
  lnk: string
  /** Every managed copy lives under this folder; a shortcut aimed anywhere else is left alone. */
  managedRoot: string
  stub: string
  icon: string
}

function defaultPaths(): ShortcutPaths {
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return {
    lnk: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude.lnk'),
    managedRoot: join(DATA_DIR, 'claude-native'),
    stub: join(localAppData, 'AnthropicClaude', 'claude.exe'),
    icon: join(localAppData, 'AnthropicClaude', 'app.ico'),
  }
}

// Every path travels in the child's environment, never in the script text, so no path can break
// out into PowerShell (the same convention as core/shortcut.ts). Re-saving through WScript.Shell
// keeps the shortcut's property store, notification id included (checked 2026-09-28).
// The shell reads a target back in long form (C:\Users\runneradmin\...) whatever spelling it was
// given, so every path is compared through GetFullPath, which on Windows PowerShell also expands an
// 8.3 short name (C:\Users\RUNNER~1\...) of a path that exists; a raw -ieq against a short-named
// stub reported a repair that had worked as 'failed' (CI, 2026-09-30).
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $env:CM_LNK)) { 'unchanged'; exit 0 }
if (-not (Test-Path -LiteralPath $env:CM_STUB)) { 'unchanged'; exit 0 }
$stub = [IO.Path]::GetFullPath($env:CM_STUB)
$ws = New-Object -ComObject WScript.Shell
$l = $ws.CreateShortcut($env:CM_LNK)
if (-not $l.TargetPath) { 'unchanged'; exit 0 }
$target = [IO.Path]::GetFullPath($l.TargetPath)
$root = [IO.Path]::GetFullPath($env:CM_ROOT).TrimEnd('\') + '\'
if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { 'unchanged'; exit 0 }
$l.TargetPath = $stub
$l.WorkingDirectory = [IO.Path]::GetDirectoryName($stub)
if (Test-Path -LiteralPath $env:CM_ICON) { $l.IconLocation = $env:CM_ICON + ',0' }
$l.Save()
$saved = $ws.CreateShortcut($env:CM_LNK).TargetPath
if ($saved -and [IO.Path]::GetFullPath($saved) -ieq $stub) { 'repointed' } else { 'failed' }
`

/** Point Claude's Start-menu shortcut at the install's stub when it names a managed copy. Never
 *  throws; off Windows there is nothing to do. */
export async function repointClaudeStartShortcut(
  paths: ShortcutPaths = defaultPaths(),
): Promise<ShortcutRepair> {
  if (process.platform !== 'win32') return 'unchanged'
  try {
    const run = await spawnCaptured(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      {
        timeoutMs: 20_000,
        env: {
          ...process.env,
          CM_LNK: paths.lnk,
          CM_ROOT: paths.managedRoot,
          CM_STUB: paths.stub,
          CM_ICON: paths.icon,
        },
      },
    )
    const out = run.stdout.trim()
    if (run.code !== 0 || run.timedOut) return 'failed'
    return out === 'repointed' || out === 'unchanged' ? out : 'failed'
  } catch {
    return 'failed'
  }
}
