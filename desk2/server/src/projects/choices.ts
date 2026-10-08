// The folders the New screen's grid is built from, as the user chose them (DeskSettings' projectFolders, projectRoots
// and hiddenProjects): validating a folder on add, one level of a folder of projects, and one spelling per folder.

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ChatError } from '../engine/chat-manager'
import { isRemotePath } from '../engine/reveal'

const realPaths = new Map<string, string>()

/** One spelling per folder: Windows paths are the same folder in any case and with either slash, and a junction or symlink is its target. */
export function folderKey(path: string): string {
  const full = resolve(path)
  let real = realPaths.get(full)
  if (real === undefined) {
    try {
      real = realpathSync.native(full)
      realPaths.set(full, real)
    } catch {
      real = full
    }
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** The checkout holding `dir` (the nearest folder up with a .git), else `dir` itself. */
export function checkoutOf(dir: string): string {
  let at = resolve(dir)
  for (;;) {
    try {
      statSync(join(at, '.git'))
      return at
    } catch {
      const up = dirname(at)
      if (up === at) return resolve(dir)
      at = up
    }
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A folder the user adds: absolute, on this PC and existing. Anything else is a 400, before the settings change. */
export function localFolderPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new ChatError(400, 'path must be an absolute path')
  if (isRemotePath(value)) throw new ChatError(400, 'path must be a folder on this machine, not a network or device path')
  const full = resolve(value)
  if (!isDir(full)) throw new ChatError(400, 'path must be an existing folder')
  return full
}

/** The folders one level under `root`, never deeper; a file, a dot-folder or a missing root gives none. */
export function subfolders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(root, e.name))
  } catch {
    return []
  }
}

/** The list with `path` added, once: a folder already in it (in any case or slash) is not added twice. */
export function withPath(list: string[], path: string): string[] {
  const key = folderKey(path)
  return list.some((p) => folderKey(p) === key) ? list : [...list, path]
}

/** The list with `path` taken out, whichever spelling it was kept under. */
export function withoutPath(list: string[], path: string): string[] {
  const key = folderKey(path)
  return list.filter((p) => folderKey(p) !== key)
}
