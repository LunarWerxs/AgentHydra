// The folder menu's Recent list (SPEC "Folder picker"): the folders of the chats and the folders opened or
// chosen in the menu, the latest first, without the ones taken off with a row's X. A folder taken off comes
// back once it is used again: opened or chosen in the menu, or a new chat started in it. Folders that are
// gone from disk are left out. <home>/folders.json keeps what the chats do not say.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isRemotePath } from '../engine/reveal'

export const RECENT_FOLDERS_MAX = 20
/** Marks kept per list in the file. */
const KEEP = 100

interface Mark {
  path: string
  at: number
}

interface Saved {
  /** Opened with Add new folder or chosen from the menu, when. */
  used: Mark[]
  /** Taken off the list with the X, when. */
  removed: Mark[]
}

/** What a chat tells the list: its folder, its last activity (the order) and its start (a use of the folder). */
export interface ChatFolder {
  cwd: string
  createdAt: number
  updatedAt: number
}

/** One spelling per folder: Windows paths are the same folder in any case and with either slash. */
function folderKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function marks(value: unknown): Mark[] {
  if (!Array.isArray(value)) return []
  return value.filter((m): m is Mark => typeof m?.path === 'string' && m.path.length > 0 && typeof m?.at === 'number')
}

function load(file: string): Saved {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved> | null
    return { used: marks(saved?.used), removed: marks(saved?.removed) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[folders] ignoring unreadable ${file}: ${(err as Error).message}`)
    return { used: [], removed: [] }
  }
}

/** A folder still on disk. A network path is not looked at: that alone makes Windows dial the host. */
function onDisk(path: string): boolean {
  if (isRemotePath(path)) return true
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class RecentFolders {
  private saved: Saved

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.saved = load(file)
  }

  /** The list, latest first, at most RECENT_FOLDERS_MAX. */
  list(chats: ChatFolder[]): string[] {
    const rows = new Map<string, { path: string; order: number; used: number }>()
    const add = (path: string, order: number, used: number) => {
      const key = folderKey(path)
      const row = rows.get(key)
      if (!row) rows.set(key, { path, order, used })
      else {
        if (order > row.order) Object.assign(row, { path, order })
        row.used = Math.max(row.used, used)
      }
    }
    for (const c of chats) add(c.cwd, c.updatedAt, c.createdAt)
    for (const m of this.saved.used) add(m.path, m.at, m.at)

    const removed = new Map(this.saved.removed.map((m) => [folderKey(m.path), m.at]))
    const out: string[] = []
    for (const [key, row] of [...rows].sort((a, b) => b[1].order - a[1].order)) {
      const off = removed.get(key)
      if (off !== undefined && row.used <= off) continue
      if (!onDisk(row.path)) continue
      out.push(row.path)
      if (out.length >= RECENT_FOLDERS_MAX) break
    }
    return out
  }

  /** The folder was opened or chosen just now: it goes to the top, and back on the list if it was taken off. */
  remember(path: string): void {
    const key = folderKey(path)
    this.saved.used = [{ path, at: this.now() }, ...this.saved.used.filter((m) => folderKey(m.path) !== key)].slice(0, KEEP)
    this.saved.removed = this.saved.removed.filter((m) => folderKey(m.path) !== key)
    this.save()
  }

  /** Takes the folder off the list until it is used again. */
  forget(path: string): void {
    const key = folderKey(path)
    this.saved.removed = [{ path, at: this.now() }, ...this.saved.removed.filter((m) => folderKey(m.path) !== key)].slice(0, KEEP)
    this.saved.used = this.saved.used.filter((m) => folderKey(m.path) !== key)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.saved, null, 2)}\n`)
    renameSync(tmp, this.file)
  }
}
