// server/src/core/paths.ts — per-OS Claude dir, instances root, app-data dir, launch binary.
// Adapted from an internal LunarWerx tool's server/src/core/paths.ts (PLAN.md §2), ADAPTED:
// appDataDir() (and therefore accountsCacheFile()/settingsFile()/logFile()) now resolve under
// THIS app's CONFIG_DIR (~/.agenthydra) instead of that tool's own per-OS %APPDATA% config
// dir — so the instance-identity cache lives at ~/.agenthydra/instances-cache.json, separate
// from this app's sqlite `accounts` table (see server/src/core/shared.ts header comment).
//
// Pure path/dir resolution — no throwing. Callers that need to distinguish "doesn't exist"
// from "exists" call existsSync themselves; these helpers just compute paths deterministically.

import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_DIR } from '../config'
import { DEFAULT_CLAUDE_DIR_NAME, INSTANCES_DIR_NAME } from './shared'

export type SupportedPlatform = 'win32' | 'darwin' | 'linux'

export function currentPlatform(): SupportedPlatform {
  const p = process.platform
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p
  // Best-effort: treat anything else BSD-like as linux rather than throwing.
  return 'linux'
}

/** `~/.claude-instances` — root of all isolated instance dirs. */
export function instancesRoot(): string {
  return path.join(os.homedir(), INSTANCES_DIR_NAME)
}

/** Our own app-data dir: instances-cache.json / agenthydra settings / logs (never an
 *  instance dir). Adapted to live under this app's CONFIG_DIR (~/.agenthydra) rather than
 *  the internal tool's own standalone per-OS %APPDATA% dir — one config dir per app. */
export function appDataDir(): string {
  return CONFIG_DIR
}

/** The DEFAULT (non-isolated) Claude Desktop user-data dir — holds `Local State` +
 *  `config.json` at its root:
 *    win:   %APPDATA%\Claude
 *    mac:   ~/Library/Application Support/Claude
 *    linux: ~/.config/Claude (or $XDG_CONFIG_HOME/Claude)
 *  Used both as the identity-resolution target for the un-isolated instance AND to guard
 *  against ever deleting/treating it as an isolated instance. */
export function claudeUserDataDir(): string {
  const plat = currentPlatform()
  if (plat === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, DEFAULT_CLAUDE_DIR_NAME)
  }
  if (plat === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DEFAULT_CLAUDE_DIR_NAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(xdg, DEFAULT_CLAUDE_DIR_NAME)
}

/** @deprecated Alias for {@link claudeUserDataDir} kept for any call-sites written against
 *  the earlier draft's longer name. Prefer `claudeUserDataDir` or `defaultClaudeDir`. */
export function defaultClaudeUserDataDir(): string {
  return claudeUserDataDir()
}

export function settingsFile(): string {
  return path.join(appDataDir(), 'settings.json')
}

/** Instance-identity cache — identity ONLY, never a token (see server/src/core/accounts.ts). */
export function accountsCacheFile(): string {
  return path.join(appDataDir(), 'instances-cache.json')
}

/** Per-instance UI metadata (display label + icon + color), keyed by normalized dir. Pure
 *  presentation, never a secret; see server/src/core/instance-meta.ts. */
export function instanceMetaFile(): string {
  return path.join(appDataDir(), 'instance-meta.json')
}

/** Permanent instance NUMBERS (`#1`, `#2`, …), keyed by instance ref. The short handle a human
 *  says out loud and an MCP client passes around; see server/src/core/instance-numbers.ts. */
export function instanceNumbersFile(): string {
  return path.join(appDataDir(), 'instance-numbers.json')
}

export function logFile(): string {
  return path.join(appDataDir(), 'agenthydra.log')
}

/** Resolve the Claude launch binary path on this OS. Never throws — returns null when no
 *  candidate exists. Async so callers can uniformly `await` it (mac/linux resolution may
 *  shell out in the future; kept sync-fast internally on Windows today). */
// eslint-disable-next-line @typescript-eslint/require-await -- kept async for a stable call-site contract
export async function resolveLaunchBinary(override?: string | null): Promise<string | null> {
  try {
    if (override && existsSync(override)) return override

    const plat = currentPlatform()

    if (plat === 'win32') {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      const anthropicDir = path.join(localAppData, 'AnthropicClaude')

      // Prefer the STABLE Squirrel root stub over the versioned app-<ver> scan below — same
      // rationale as core/shortcut.ts's stableWinLaunchTarget() (shortcut.ts:6-11, 48-54): the
      // stub always forwards to whichever version is newest, so it survives Claude Desktop
      // updates and needs no version-directory bookkeeping of its own.
      const stableStub = path.join(anthropicDir, 'claude.exe')
      if (existsSync(stableStub)) return stableStub

      let newestAppDir: { dir: string; version: number[] } | null = null
      try {
        const entries = readdirSync(anthropicDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith('app-')) continue
          const exe = path.join(anthropicDir, entry.name, 'Claude.exe')
          if (!existsSync(exe)) continue // skip version dirs lacking the exe
          const versionStr = entry.name.slice('app-'.length)
          const version = versionStr.split('.').map((n) => Number.parseInt(n, 10) || 0)
          if (!newestAppDir || compareVersions(version, newestAppDir.version) > 0) {
            newestAppDir = { dir: entry.name, version }
          }
        }
      } catch {
        // AnthropicClaude dir absent — fall through to other candidates.
      }
      if (newestAppDir) return path.join(anthropicDir, newestAppDir.dir, 'Claude.exe')

      const fallbacks = [
        path.join(localAppData, 'Programs', 'Claude', 'Claude.exe'),
        'C:\\Program Files\\Claude\\Claude.exe',
      ]
      for (const candidate of fallbacks) {
        if (existsSync(candidate)) return candidate
      }
      return null
    }

    if (plat === 'darwin') {
      // Launched via `open -na "Claude"` — no direct binary path needed; return the app name
      // as a marker so instances.ts knows to use `open`, not spawn a path directly.
      return 'Claude'
    }

    // linux: resolve `claude` on PATH is instances.ts's job (spawn + PATH lookup); here we
    // just signal the conventional command name.
    return 'claude'
  } catch {
    return null
  }
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Normalizes a filesystem path for use as an identity/cache key: resolves it, trims trailing
 *  slashes, and folds case only on Windows (POSIX paths are case-sensitive). Never throws. */
export function normalizeInstancePath(p: string): string {
  try {
    const trimmed = p.replace(/[\\/]+$/, '')
    if (trimmed.trim() === '') return trimmed
    let resolved = trimmed
    try {
      resolved = path.resolve(trimmed)
    } catch {
      resolved = trimmed
    }
    const normalized = resolved.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  } catch {
    const normalized = p.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
}

/** Alias for normalizeInstancePath — matches the shorter name used by core/instances.ts and
 *  core/lifecycle.ts. Kept as a thin re-export so both naming conventions resolve to one
 *  implementation. */
export const normalizePath = normalizeInstancePath

/** True only when `candidate` resolves strictly below `root` (never for the root itself or a
 *  sibling whose name merely shares the same prefix). */
export function isPathInside(root: string, candidate: string): boolean {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(candidate))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

/** Alias for claudeUserDataDir — matches the shorter name used by core/lifecycle.ts. */
export const defaultClaudeDir = claudeUserDataDir

/** Builds the launch argv (excluding the binary/command itself) for the resolved binary on
 *  this OS. Callers use `Bun.spawn([binary, ...args])` directly (no shell), so args are
 *  passed as literal argv entries — NOT shell-quoted; a literal `"` in the string would
 *  become part of the argument value, which is wrong here.
 *    win32:  `--user-data-dir=<dir>`   (Claude.exe accepts unquoted argv; no shell involved)
 *    darwin: `-na "Claude" --args --user-data-dir <dir>` — intended for `open`, e.g.
 *            `Bun.spawn(["open", ...launchArgs(dir)])`; `-n` forces a new instance.
 *    linux:  `--user-data-dir=<dir>`
 *  macOS's `resolveLaunchBinary()` returns the app name ("Claude") as a marker meaning
 *  "launch via `open -na`" rather than a direct executable path; instances.ts special-cases
 *  that OS accordingly. */
export function launchArgs(dir: string): string[] {
  const plat = currentPlatform()
  if (plat === 'win32') return [`--user-data-dir=${dir}`]
  if (plat === 'darwin') return ['-na', 'Claude', '--args', '--user-data-dir', dir]
  return [`--user-data-dir=${dir}`]
}
