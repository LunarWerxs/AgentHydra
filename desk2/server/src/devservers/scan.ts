// Fast, bounded project scan (ported from DevWebUI's scan.ts). It finds .devwebui files and, with `detectPackages`,
// folders whose dev scripts could make one. The walk is breadth-first with many directories read at once, prunes
// node_modules and other heavy or system folders, and is capped in depth, results and wall-clock time, so it returns
// quickly on a dev tree and never runs away on a full drive.

import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DevWebDetectedProject, DevWebFoundFile, DevWebScanPreset, DevWebScanResult, DevWebSettings, DevWebSkipOs } from '@shared/devwebui'
import { detectProject } from './detect'
import { parseJsonText, parseProjectSpec } from './project-file'

// Always skipped: dependency and build folders, and big app or game stores that never hold a .devwebui. Lowercase.
// Dot-directories are pruned separately by their leading dot.
const PRUNE = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj', '__pycache__', 'venv', '.venv', 'go',
  'steamlibrary', 'steamapps', 'epic games', 'gog galaxy', 'riot games', 'battle.net', 'origin games', 'ea games', 'ubisoft', 'xboxgames'
])

/** System folder names each OS skip switch adds to a scan's excludes (matched anywhere). */
export const OS_SKIP: Record<DevWebSkipOs, string[]> = {
  windows: [
    'windows', 'winnt', 'windows.old', 'program files', 'program files (x86)', 'programdata', 'appdata', 'application data', 'windowsapps',
    '$recycle.bin', 'system volume information', '$windows.~ws', '$windows.~bt', '$winreagent', '$sysreset', '$getcurrent', 'recovery',
    'perflogs', 'config.msi', 'msocache', 'packages.microsoft.com', 'boot', 'efi', 'documents and settings', 'all users', 'default user',
    'onedrivetemp', 'windows defender', 'intel', 'amd', 'nvidia', 'drivers', 'msbuild'
  ],
  mac: ['library', 'system', 'applications', 'private', 'cores', 'network', 'volumes', 'system volume information', 'deriveddata'],
  linux: ['proc', 'sys', 'dev', 'run', 'mnt', 'media', 'var', 'usr', 'boot', 'opt', 'srv', 'lost+found', 'snap', 'tmp', 'lib', 'lib64', 'sbin', 'etc']
}

/** The user's home, plus every other fixed drive on Windows. */
export function defaultScanRoots(): string[] {
  const home = os.homedir()
  const roots = [home]
  if (process.platform === 'win32') {
    const homeDrive = home.slice(0, 3).toUpperCase()
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`
      if (root.toUpperCase() !== homeDrive && existsSync(root)) roots.push(root)
    }
  }
  return roots
}

/** What a scan skips by the settings: the person's excludes plus the folder lists of every enabled OS skip. */
export function scanExcludes(s: DevWebSettings): string[] {
  const on: Record<DevWebSkipOs, boolean> = { windows: s.skipWindows, mac: s.skipMac, linux: s.skipLinux }
  return [...s.scanExclude, ...(Object.keys(on) as DevWebSkipOs[]).filter((k) => on[k]).flatMap((k) => s.osSkip[k])]
}

const MAX_FILE_BYTES = 1024 * 1024

async function describeFile(file: string): Promise<DevWebFoundFile> {
  const invalid = { path: file, name: path.basename(file), processes: 0, valid: false }
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return invalid
    const j = parseJsonText(await readFile(file, 'utf8')) as { name?: unknown; processes?: unknown }
    const processes = Array.isArray(j.processes) ? j.processes.length : 0
    const name = typeof j.name === 'string' && j.name ? j.name : path.basename(file)
    // Valid exactly when loading the file would succeed.
    let valid = true
    try {
      parseProjectSpec(j)
    } catch {
      valid = false
    }
    return { path: file, name, processes, valid }
  } catch {
    return invalid
  }
}

function describeDetected(dir: string): DevWebDetectedProject | null {
  try {
    const p = detectProject(dir)
    if (!p) return null
    return { path: dir, name: p.name, ...(p.framework ? { framework: p.framework } : {}), processes: p.processes.length }
  } catch {
    return null
  }
}

export const SCAN_PRESETS: Record<DevWebScanPreset, { maxDepth: number; budgetMs: number; limit: number }> = {
  quick: { maxDepth: 3, budgetMs: 6000, limit: 500 },
  deep: { maxDepth: 16, budgetMs: 30000, limit: 5000 },
  scoped: { maxDepth: 16, budgetMs: 30000, limit: 5000 },
  startup: { maxDepth: 12, budgetMs: 30000, limit: 5000 }
}

export interface ScanOptions {
  roots?: string[]
  /** Folder names (matched anywhere) or absolute paths to skip. */
  exclude?: string[]
  preset: DevWebScanPreset
}

// ponytail: one walk at a time, process-wide (a second scan waits); per-root parallel walks if that ever feels slow.
let scanChain: Promise<unknown> = Promise.resolve()

export function scanProjects(opts: ScanOptions): Promise<DevWebScanResult> {
  const run = scanChain.catch(() => {}).then(() => runScan(opts))
  scanChain = run.catch(() => {})
  return run
}

async function runScan(opts: ScanOptions): Promise<DevWebScanResult> {
  const { maxDepth, budgetMs, limit } = SCAN_PRESETS[opts.preset]
  const concurrency = 64
  const start = Date.now()
  const excludeNames = new Set<string>()
  const excludePaths: string[] = []
  for (const raw of opts.exclude ?? []) {
    const t = String(raw).trim().toLowerCase()
    if (!t) continue
    if (/^([a-z]:[\\/]|[\\/])/.test(t)) excludePaths.push(path.resolve(t).toLowerCase())
    else excludeNames.add(t)
  }
  // A root the excludes cover is dropped here: the walk only applies them to subfolders.
  const roots = (opts.roots?.length ? opts.roots : defaultScanRoots()).map((r) => path.resolve(r)).filter((r) => {
    const k = r.toLowerCase()
    return !excludeNames.has(path.basename(k)) && !excludePaths.some((p) => k === p || k.startsWith(p + path.sep))
  })

  const files: DevWebFoundFile[] = []
  const detected: DevWebDetectedProject[] = []
  const seen = new Set<string>(roots.map((r) => r.toLowerCase()))
  let scannedDirs = 0
  let truncated = false
  let timedOut = false
  let settled = false

  const stopped = (): boolean => settled || timedOut || truncated
  const collected = (): number => files.length + detected.length

  function resolveSubdir(dir: string, e: Dirent, depth: number): string | null {
    if (depth + 1 > maxDepth) return null
    const lower = e.name.toLowerCase()
    if (e.name.startsWith('.') || PRUNE.has(lower) || excludeNames.has(lower)) return null
    const full = path.join(dir, e.name)
    const k = full.toLowerCase()
    if (excludePaths.some((p) => k === p || k.startsWith(p + path.sep))) return null
    if (seen.has(k)) return null
    seen.add(k)
    return full
  }

  async function scanDir(dir: string, depth: number): Promise<{ dir: string; depth: number }[]> {
    if (stopped()) return []
    scannedDirs++
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries || stopped()) return []
    const subdirs: { dir: string; depth: number }[] = []
    const fileJobs: Promise<DevWebFoundFile>[] = []
    let packageJson = false
    for (const e of entries) {
      if (stopped()) break
      if (e.isSymbolicLink()) continue // links are not followed: no cycles, no escapes
      if (e.isDirectory()) {
        const full = resolveSubdir(dir, e, depth)
        if (full) subdirs.push({ dir: full, depth: depth + 1 })
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase()
        if (lower.endsWith('.devwebui')) fileJobs.push(describeFile(path.join(dir, e.name)))
        else if (lower === 'package.json') packageJson = true
      }
    }
    for (const f of await Promise.all(fileJobs)) {
      if (stopped()) break
      if (collected() >= limit) {
        truncated = true
        break
      }
      files.push(f)
    }
    // A package root with no .devwebui of its own: nothing to add, but its scripts could make one.
    if (packageJson && fileJobs.length === 0 && !stopped() && collected() < limit) {
      const found = describeDetected(dir)
      if (found && !settled && !timedOut) {
        if (collected() < limit) detected.push(found)
        else truncated = true
      }
    }
    return subdirs
  }

  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }))
  let head = 0
  let active = 0
  await new Promise<void>((resolve) => {
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve()
    }
    // pump only runs when a read settles: this timer returns within the budget even if every read hangs (a dead drive).
    const watchdog = setTimeout(() => {
      timedOut = true
      settle()
    }, budgetMs + 100)
    const pump = () => {
      if (settled) return
      if (Date.now() - start > budgetMs) timedOut = true
      else if (collected() >= limit) truncated = true
      if (timedOut || truncated) {
        settle()
        return
      }
      while (active < concurrency && head < queue.length) {
        const { dir, depth } = queue[head++]!
        active++
        scanDir(dir, depth)
          .then((subs) => {
            if (!settled) for (const s of subs) queue.push(s)
          })
          .finally(() => {
            active--
            pump()
          })
      }
      if (active === 0 && head >= queue.length) settle()
    }
    pump()
  })

  files.sort((a, b) => b.processes - a.processes || a.path.length - b.path.length)
  detected.sort((a, b) => b.processes - a.processes || a.path.length - b.path.length)
  return { files, detected, scannedDirs, truncated, timedOut, ms: Date.now() - start, roots }
}
