// What a folder can start (SPEC "Localhost"): its .devwebui processes and its package.json dev/start/preview
// scripts, run with the package manager its lockfile names. Only what is found here can be started: the
// start route takes an id from this list, never a command.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { StartableServer } from '@shared/protocol'

export const STARTABLE_SCRIPTS = ['dev', 'start', 'preview'] as const

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** The package manager a folder's lockfile names; npm when there is none. */
export function packageManager(files: string[]): PackageManager {
  const has = (f: string) => files.includes(f)
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  return 'npm'
}

/** The port a script line names (--port 5173, --port=5173, -p 3000, PORT=3000), else null. */
export function scriptPort(script: string): number | null {
  const m = /(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})\b/.exec(` ${script}`)
  const n = m ? Number(m[1]) : NaN
  return n > 0 && n < 65536 ? n : null
}

type Found = Omit<StartableServer, 'running' | 'managed'>

/** package.json's dev/start/preview scripts as startable servers. */
export function packageScripts(folder: string, pkgText: string, files: string[]): Found[] {
  let pkg: unknown
  try {
    pkg = JSON.parse(pkgText)
  } catch {
    return []
  }
  const scripts = pkg && typeof pkg === 'object' ? (pkg as { scripts?: unknown }).scripts : undefined
  if (!scripts || typeof scripts !== 'object') return []
  const pm = packageManager(files)
  const out: Found[] = []
  for (const name of STARTABLE_SCRIPTS) {
    const body = (scripts as Record<string, unknown>)[name]
    if (typeof body !== 'string' || !body.trim()) continue
    out.push({
      id: `script:${name}`,
      name,
      command: pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`,
      cwd: folder,
      source: 'package.json',
      port: scriptPort(body),
    })
  }
  return out
}

/** A .devwebui file's processes (DevWebUI's format: { name, processes: [{ id, name, command, cwd?, port? }] }). */
export function devwebuiProcesses(folder: string, text: string): Found[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const procs = data && typeof data === 'object' ? (data as { processes?: unknown }).processes : undefined
  if (!Array.isArray(procs)) return []
  const out: Found[] = []
  for (const p of procs as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') continue
    const id = typeof p.id === 'string' && /^[\w.-]{1,64}$/.test(p.id) ? p.id : null
    const command = typeof p.command === 'string' ? p.command.trim() : ''
    if (!id || !command) continue
    const cwdRaw = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '.'
    const port = Number(p.port)
    out.push({
      id: `devwebui-file:${id}`,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
      command,
      cwd: isAbsolute(cwdRaw) ? cwdRaw : resolve(folder, cwdRaw),
      source: '.devwebui',
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    })
  }
  return out
}

/** Everything a folder can start: .devwebui processes first, then package.json scripts. */
export function detectStartable(folder: string): Found[] {
  let files: string[]
  try {
    files = readdirSync(folder)
  } catch {
    return []
  }
  const out: Found[] = []
  const seen = new Set<string>()
  for (const f of files.filter((f) => f === '.devwebui' || f.endsWith('.devwebui')).sort()) {
    try {
      for (const p of devwebuiProcesses(folder, readFileSync(join(folder, f), 'utf8'))) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        out.push(p)
      }
    } catch {
      // unreadable: skipped
    }
  }
  const pkgPath = join(folder, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      out.push(...packageScripts(folder, readFileSync(pkgPath, 'utf8'), files))
    } catch {
      // unreadable: skipped
    }
  }
  return out
}
