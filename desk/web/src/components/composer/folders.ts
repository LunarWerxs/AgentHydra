// The folder menu's rows (FolderPicker): folder names only, like the real app. Folders that share a name also
// get as much of the end of their parent path as tells them apart. No Vue here, so web/test/composer can test it.

import { folderName } from './logic'

export interface FolderRow {
  path: string
  name: string
  /** Only when another row has the same name: the end of the parent path, e.g. `Agent Hydra\desk`. */
  hint: string | null
  current: boolean
}

/** The same Windows folder: any case, either slash, with or without a trailing slash. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function parentParts(path: string): string[] {
  return path.replace(/[\\/]+$/, '').split(/[\\/]+/).slice(0, -1)
}

export function folderRows(paths: string[], current: string | null): FolderRow[] {
  const rows: FolderRow[] = paths.map((path) => ({
    path,
    name: folderName(path),
    hint: null,
    current: current !== null && sameFolder(path, current)
  }))
  const byName = new Map<string, FolderRow[]>()
  for (const row of rows) {
    const key = row.name.toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), row])
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const parents = group.map((r) => parentParts(r.path))
    const sep = group[0].path.includes('\\') ? '\\' : '/'
    const deepest = Math.max(...parents.map((p) => p.length))
    for (let depth = 1; depth <= deepest; depth++) {
      const hints = parents.map((p) => p.slice(-depth).join(sep))
      if (new Set(hints.map((h) => h.toLowerCase())).size === group.length || depth === deepest) {
        group.forEach((r, i) => (r.hint = hints[i] || null))
        break
      }
    }
  }
  return rows
}
