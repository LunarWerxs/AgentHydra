// The company a folder belongs to, which the sidebar's Dev servers list groups by (owner, 2026-10-07: "sorted by ...
// their main parent company ... by their company, project, name"). Walking down from the drive, it is the first folder
// that is not a container of projects. A container is a drive root, the home folder or a folder above it, a folder
// named like one (`*Projects`, tmp, active, shared, 1offs, `*Retired`, ...), or a folder with no project file of its
// own that holds a dozen folders or more. A folder with a project file (.git, package.json, CLAUDE.md, ...) is never one.
// So D:/PublicProjects/AgentHydra/desk2-p11 is AgentHydra's, D:/Work/active/Shop is Shop's, and
// D:/Code/Example Social/website is Example Social's (a folder holding a few projects and no project file of its own).

import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DevWebCompany } from '@shared/devwebui'

const MARKERS = ['.git', 'package.json', 'CLAUDE.md', 'AGENTS.md', '.devwebui', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'deno.json']
const CONTAINER_NAME = /projects$|retired$|^(tmp|temp|active|shared|1offs|one-?offs|archived?|old|repos|repositories|src|source|code|dev|work|workspaces?|github|git|sites|clients)$/i
/** A folder with no project file of its own holding this many folders or more is a container, not a company. */
const CONTAINER_FOLDERS = 12

export interface CompanyChecks {
  /** The folder holds a project file. */
  marked(dir: string): boolean
  /** How many folders it holds (dot folders left out). */
  folders(dir: string): number
  home: string
}

/** Forward slashes, no trailing one, an upper-case drive letter: one spelling per folder. */
const slashes = (p: string): string =>
  p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^[a-z]:/, (d) => d.toUpperCase())
const key = (p: string): string => slashes(p).toLowerCase()

/** The part of a path no walk goes above: `D:` (a drive, with or without its slash), `//host/share` or `/`. */
const rootOf = (abs: string): string => /^[a-z]:/i.exec(abs)?.[0] ?? /^\/\/[^/]+\/[^/]+/.exec(abs)?.[0] ?? ''

/** The company of a folder, by the checks given: the disk's (`companyOf`) or a test's tree. */
export function companyFrom(dir: string, c: CompanyChecks): DevWebCompany {
  const abs = slashes(dir) || '/'
  const root = rootOf(abs)
  const home = key(c.home)
  let cur = root
  for (const part of abs.slice(root.length).split('/').filter(Boolean)) {
    cur = `${cur}/${part}`
    const k = key(cur)
    // The home folder and the folders above it hold everything of the person's; they are never a company.
    if (home === k || home.startsWith(`${k}/`)) continue
    if (c.marked(cur)) return { name: part, dir: cur }
    if (CONTAINER_NAME.test(part) || c.folders(cur) >= CONTAINER_FOLDERS) continue
    return { name: part, dir: cur }
  }
  // All containers: the home folder itself is "Home" (never the account's name), anything else its own last folder.
  if (key(abs) === home) return { name: 'Home', dir: abs }
  return { name: abs.slice(abs.lastIndexOf('/') + 1) || abs, dir: abs }
}

// The disk's answers, kept for ten minutes: the list asks again on every poll, and folders hardly ever move. Past
// MEMO_MAX answers the stale ones go, and if that is not enough, all of them.
const TTL_MS = 10 * 60_000
const MEMO_MAX = 5000
const memo = new Map<string, { at: number; value: unknown }>()
function remembered<T>(k: string, read: () => T): T {
  const hit = memo.get(k)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) return hit.value as T
  const value = read()
  if (memo.size >= MEMO_MAX) {
    for (const [mk, m] of memo) if (now - m.at >= TTL_MS) memo.delete(mk)
    if (memo.size >= MEMO_MAX) memo.clear()
  }
  memo.set(k, { at: now, value })
  return value
}

const DISK: CompanyChecks = {
  marked: (dir) => remembered(`m:${key(dir)}`, () => MARKERS.some((m) => existsSync(path.join(dir, m)))),
  folders: (dir) =>
    remembered(`f:${key(dir)}`, () => {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
      } catch {
        return 0
      }
    }),
  home: os.homedir()
}

/** The company of a folder on this machine. */
export const companyOf = (dir: string): DevWebCompany => companyFrom(dir, DISK)

// A folder a tool lives in (a global npm package, a runtime's own install) names the tool, not a project.
const TOOL_DIR = /\/(program files( \(x86\))?|windows|appdata|programdata|scoop|nvm4w)(\/|$)|\/\.(bun|npm|nvm|cargo|rustup|pyenv|volta|deno)(\/|$)/i

/**
 * The project folder a server's command line names: the first absolute path after the program that is on disk (a file's
 * folder, or a folder itself), raised to the folder holding its node_modules; null when none is, or it is a tool's own.
 * The script and other plain arguments are looked at before option values (`--env-file=C:/Users/me/.env` names no
 * project). `kind` says what a path is on disk (the tests' tree, or the disk's, kept ten minutes).
 */
export function commandDir(command: string | null, kind: (p: string) => 'file' | 'dir' | null = diskKind): string | null {
  if (!command) return null
  const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '').slice(1)
  const plain = words.filter((w) => !w.startsWith('-'))
  const options = words.filter((w) => /^--?[\w-]+=/.test(w)).map((w) => w.replace(/^--?[\w-]+=/, ''))
  for (const value of [...plain, ...options]) {
    if (!/^([a-z]:[\\/]|\/)/i.test(value)) continue
    const at = kind(value)
    if (!at) continue
    const named = slashes(value)
    let dir = at === 'file' ? named.slice(0, named.lastIndexOf('/')) : named
    const nm = dir.toLowerCase().indexOf('/node_modules')
    if (nm > 0) dir = dir.slice(0, nm)
    return TOOL_DIR.test(dir) ? null : dir
  }
  return null
}

function diskKind(p: string): 'file' | 'dir' | null {
  return remembered(`k:${key(p)}`, () => {
    try {
      return statSync(p).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  })
}
