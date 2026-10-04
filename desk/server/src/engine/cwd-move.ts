// A chat moves folders when its session really relocated, not when a Bash call cd'd somewhere for a moment
// (Claude Code follows the Bash tool's cwd and writes it on every transcript line). Owner, 2026-10-04: a
// worker that read a session file under ~/.agenthydra, then cd'd to the home folder, moved its chat twice
// with nobody asking. So a move needs a folder a chat can live in (movedOutOf) AND either the owner's
// message asking for it (askedToMove) or the same folder holding across a turn boundary (chat-manager noteCwd).

import { existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** A UNC share or a Windows device path (\\server\share, \\?\C:\, //host/x): never a folder a chat moves to. */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/** True when `inner` is `outer` or inside it (case-insensitive: Windows paths). */
export function isInside(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer).toLowerCase(), resolve(inner).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Folder names a chat never lives under: account and app state (.claude*, .agenthydra, .hydra-desk), dependencies, a repo's own .git. */
const TOOL_SEGMENT = /^(\.claude.*|\.agenthydra|\.hydra-desk|node_modules|\.git)$/i
/** Files or folders that make a folder a project. */
const PROJECT_MARKERS = ['.git', 'package.json', '.devwebui', 'CLAUDE.md', 'AGENTS.md']

export interface MoveRuleOptions {
  /** The user's home folder (default os.homedir()). */
  home?: string
  /** The temp folder (default os.tmpdir()). */
  temp?: string
}

/**
 * The folder the chat moved to, or null. `observed` must be an existing local directory outside the chat's
 * folder tree that a chat can live in: a project folder (it has .git, package.json, .devwebui, CLAUDE.md or
 * AGENTS.md) or a sibling of the chat's folder (another folder under the same parent); never the home folder
 * or one above it, a drive root, a parent of the chat's folder, a .claude*, .agenthydra, .hydra-desk,
 * node_modules or .git folder or anything inside one, nor AppData or Temp unless the chat already lives there.
 */
export function movedOutOf(current: string, observed: string | null, opts: MoveRuleOptions = {}): string | null {
  if (!observed || !isAbsolute(observed) || isUncOrDevicePath(observed)) return null
  const full = resolve(observed)
  if (isInside(current, full)) return null
  try {
    if (!statSync(full).isDirectory()) return null
  } catch {
    return null
  }
  if (parse(full).root.toLowerCase() === full.toLowerCase() || samePath(dirname(full), full)) return null
  if (isInside(full, current)) return null // a parent of the chat's folder
  const home = resolve(opts.home ?? homedir())
  if (isInside(full, home)) return null // the home folder or above it
  if (full.split(/[\\/]/).some((s) => TOOL_SEGMENT.test(s))) return null
  const zones = [join(home, 'AppData'), resolve(opts.temp ?? tmpdir())]
  if (zones.some((z) => isInside(z, full) && !isInside(z, current))) return null
  const sibling = samePath(dirname(full), dirname(resolve(current)))
  if (!sibling && !PROJECT_MARKERS.some((m) => existsSync(join(full, m)))) return null
  return full
}

/**
 * True when the owner's message asked for a move to `target`: it says move, relocate or switch, and names the
 * target by its full path or its folder name as a whole word.
 */
export function askedToMove(text: string | null | undefined, target: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  if (!/\b(move|moving|relocate|switch)\b/.test(t)) return false
  const full = resolve(target).toLowerCase()
  if (t.replaceAll('/', sep).includes(full) || t.replaceAll('\\', '/').includes(full.replaceAll('\\', '/'))) return true
  const name = basename(full).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return name.length > 0 && new RegExp(`(^|[^\\w.-])${name}($|[^\\w.-])`).test(t)
}
