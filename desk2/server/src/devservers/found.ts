// The found list (<home>/devservers/found.json: what every scan found, merged by path) and the ignored folders
// (<home>/devservers/ignored.json: folders a scan no longer offers). The list the page shows leaves out what is added,
// ignored or gone from disk; a merge drops what is gone from disk, and `forget` empties it.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { type DevWebFound, type DevWebFoundItem, type DevWebScanPreset, type DevWebScanResult, folderContains } from '@shared/devwebui'
import { normalizePath, parseJsonText, samePath, writeJsonAtomic } from './project-file'
import { dataDir } from './registry'

type LastScan = NonNullable<DevWebFound['lastScan']>

interface FoundFile {
  items: DevWebFoundItem[]
  lastScan: LastScan | null
}

const foundPath = (home: string): string => path.join(dataDir(home), 'found.json')
const ignoredPath = (home: string): string => path.join(dataDir(home), 'ignored.json')

/** How long a found item's folder is taken as still on disk (or gone) before it is checked again. */
const EXISTS_MS = 10_000

function readJson(file: string): unknown {
  try {
    return parseJsonText(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The last parse of each found.json, kept until the file's mtime or size moves (the page polls the list every 2 s). */
const foundCache = new Map<string, { mtimeMs: number; size: number; value: FoundFile }>()

export function readFound(home: string): FoundFile {
  const file = foundPath(home)
  let st: { mtimeMs: number; size: number } | null = null
  try {
    st = statSync(file)
  } catch {
    // floor-ok: a missing file reads as empty below
  }
  const hit = foundCache.get(file)
  if (st && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  const raw = readJson(file) as Partial<FoundFile> | null
  const items = Array.isArray(raw?.items) ? raw.items.filter((i): i is DevWebFoundItem => !!i && typeof i.path === 'string' && (i.kind === 'file' || i.kind === 'detected')) : []
  const value = { items, lastScan: raw?.lastScan && typeof raw.lastScan === 'object' ? raw.lastScan : null }
  if (st) foundCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  else foundCache.delete(file)
  return value
}

function writeFound(home: string, f: FoundFile): void {
  mkdirSync(dataDir(home), { recursive: true })
  writeJsonAtomic(foundPath(home), f, false)
}

const existsCache = new Map<string, { at: number; yes: boolean }>()

/** existsSync, remembered for EXISTS_MS (the found list checks every item on every poll). */
function stillThere(p: string): boolean {
  const now = Date.now()
  const hit = existsCache.get(p)
  if (hit && now - hit.at < EXISTS_MS) return hit.yes
  if (existsCache.size > 20_000) existsCache.clear()
  const yes = existsSync(p)
  existsCache.set(p, { at: now, yes })
  return yes
}

/** Merges a scan's finds in by normalized path, keeping the `foundAt` of the first find; items gone from disk are dropped. */
export function mergeScan(home: string, res: DevWebScanResult, preset: DevWebScanPreset, at: number): void {
  const cur = readFound(home)
  const byPath = new Map(cur.items.filter((i) => existsSync(i.path)).map((i) => [normalizePath(i.path), i]))
  const put = (item: Omit<DevWebFoundItem, 'foundAt'>) => {
    const key = normalizePath(item.path)
    byPath.set(key, { ...item, foundAt: byPath.get(key)?.foundAt ?? at })
  }
  for (const f of res.files) put({ kind: 'file', path: f.path, name: f.name, processes: f.processes, valid: f.valid })
  for (const d of res.detected) put({ kind: 'detected', path: d.path, name: d.name, processes: d.processes, ...(d.framework ? { framework: d.framework } : {}) })
  writeFound(home, { items: [...byPath.values()], lastScan: { at, preset, ms: res.ms, scannedDirs: res.scannedDirs, truncated: res.truncated, timedOut: res.timedOut } })
}

export function forgetFound(home: string): void {
  writeFound(home, { items: [], lastScan: readFound(home).lastScan })
}

export function readIgnored(home: string, importFrom: string | null): string[] {
  const own = readJson(ignoredPath(home)) as { paths?: unknown } | null
  if (own) return Array.isArray(own.paths) ? own.paths.filter((p): p is string => typeof p === 'string') : []
  // First run: DevWebUI kept its ignored folders as { ignored: [...] }; read only, never written.
  const old = importFrom ? (readJson(path.join(importFrom, 'ignored.json')) as { ignored?: unknown } | null) : null
  const paths = Array.isArray(old?.ignored) ? old.ignored.filter((p): p is string => typeof p === 'string' && p !== '') : []
  if (paths.length) writeIgnored(home, paths)
  return paths
}

function writeIgnored(home: string, paths: string[]): void {
  mkdirSync(dataDir(home), { recursive: true })
  writeJsonAtomic(ignoredPath(home), { paths }, false)
}

export function addIgnored(home: string, importFrom: string | null, dir: string): string[] {
  const list = readIgnored(home, importFrom)
  if (list.some((x) => samePath(x, dir))) return list
  const next = [...list, path.resolve(dir)]
  writeIgnored(home, next)
  return next
}

export function removeIgnored(home: string, importFrom: string | null, dir: string): string[] {
  const list = readIgnored(home, importFrom)
  const next = list.filter((x) => !samePath(x, dir))
  if (next.length !== list.length) writeIgnored(home, next)
  return next
}

/** The folder an item lives in: a file's own folder, a detected item's path. */
export const itemDir = (i: Pick<DevWebFoundItem, 'kind' | 'path'>): string => (i.kind === 'file' ? path.dirname(i.path) : i.path)

/**
 * What the page lists: still on disk, not a loaded project (a registry file, or a folder that is a project's folder or
 * inside one) and not ignored; files first, then most servers, then the shortest path.
 */
export function listFound(home: string, registry: string[], ignored: string[]): DevWebFoundItem[] {
  const dirs = registry.map((f) => path.dirname(f))
  return readFound(home)
    .items.filter((i) => {
      if (!stillThere(i.path)) return false
      if (i.kind === 'file' ? registry.some((f) => samePath(f, i.path)) : dirs.some((d) => folderContains(d, i.path))) return false
      return !ignored.some((g) => folderContains(g, itemDir(i)))
    })
    .sort((a, b) => Number(b.kind === 'file') - Number(a.kind === 'file') || b.processes - a.processes || a.path.length - b.path.length)
}
