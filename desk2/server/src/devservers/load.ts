// Turning a path someone gave (pasted, dropped, a chat's folder) into a .devwebui file to load, or a proposal for one
// (ported from DevWebUI's projects/load-target.ts). Accepts the file itself, a folder holding exactly one, a file://
// address (what a browser hands over on a drop), or any other file (its folder is used, so a dropped package.json works).

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { detectProject, type Detection } from './detect'
import { parseProjectSpec, writeJsonAtomic } from './project-file'

export type LoadTarget =
  | { kind: 'file'; file: string }
  | { kind: 'scaffold'; dir: string; fileName: '.devwebui'; proposal: Detection }
  | { kind: 'none'; message: string }

/** A file:// address as a local path; anything else unchanged. */
export function fileUrlToLocalPath(s: string): string {
  if (!/^file:\/\//i.test(s)) return s
  try {
    const u = new URL(s)
    let p = decodeURIComponent(u.pathname)
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
    if (u.host) return `\\\\${u.host}${p.replace(/\//g, '\\')}`
    return p
  } catch {
    return s.replace(/^file:\/\//i, '')
  }
}

export function resolveLoadTarget(input: string): LoadTarget {
  const cleaned = fileUrlToLocalPath((input ?? '').trim())
  if (!cleaned) return { kind: 'none', message: 'Give the path of a .devwebui file or of its folder.' }
  const abs = path.resolve(cleaned)

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(abs)
  } catch {
    return { kind: 'none', message: `Path not found: ${abs}` }
  }

  let dir = abs
  if (st.isFile()) {
    if (abs.toLowerCase().endsWith('.devwebui')) return { kind: 'file', file: abs }
    dir = path.dirname(abs)
  }

  const hits = readdirSync(dir, { withFileTypes: true })
    .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.toLowerCase().endsWith('.devwebui'))
    .map((d) => d.name)
  if (hits.length === 1) return { kind: 'file', file: path.join(dir, hits[0]!) }
  if (hits.length > 1) return { kind: 'none', message: `Several .devwebui files in ${dir}: ${hits.join(', ')}. Give the path of the one you want.` }

  const proposal = detectProject(dir)
  // One canonical dotfile per codebase, like .gitignore: always `.devwebui`, never `<name>.devwebui`.
  if (proposal) return { kind: 'scaffold', dir, fileName: '.devwebui', proposal }
  return { kind: 'none', message: `No .devwebui file found in ${dir}, and no dev script or .claude/launch.json to build one from.` }
}

/** Validates a proposed project and writes it as `<dir>/<fileName>`, never over a file. Returns the path written. */
export function writeScaffold(dir: string, fileName: string, data: unknown): string {
  let safe = path.basename(fileName || '.devwebui')
  if (!safe.toLowerCase().endsWith('.devwebui')) safe += '.devwebui'
  const target = path.join(path.resolve(dir), safe)
  const valid = parseProjectSpec(data)
  if (existsSync(target)) throw new Error(`${target} already exists.`)
  writeJsonAtomic(target, valid)
  return target
}
