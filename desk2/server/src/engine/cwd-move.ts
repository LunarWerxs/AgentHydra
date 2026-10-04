// A chat moves folders when its session's working directory does: the model cd'd somewhere (Claude Code
// follows the Bash tool's cwd and writes it on every transcript line). Only a move OUT of the chat's
// folder counts: a cd into a subfolder, or a repo nested inside it, is still the same chat in the same place.

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** A UNC share or a Windows device path (\\server\share, \\?\C:\, //host/x): never a folder a chat moves to. */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/** True when `inner` is `outer` or inside it (case-insensitive: Windows paths). */
export function isInside(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer).toLowerCase(), resolve(inner).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The folder the chat moved to, or null: observed is an existing local directory outside the chat's own folder tree. */
export function movedOutOf(current: string, observed: string | null): string | null {
  if (!observed || !isAbsolute(observed) || isUncOrDevicePath(observed)) return null
  const full = resolve(observed)
  if (isInside(current, full)) return null
  try {
    if (!statSync(full).isDirectory()) return null
  } catch {
    return null
  }
  return existsSync(full) ? full : null
}
