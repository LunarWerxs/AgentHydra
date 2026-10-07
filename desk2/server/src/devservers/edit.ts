// Editing a project's .devwebui file in place. Every change reads the file as written, keeps every key it does not
// edit (compose, answers, unknown keys) and the servers' order, validates the result with parseProjectSpec, and writes
// it atomically; nothing is written when the result is not valid. Errors are DevServerError 400 with the validator's
// own message.

import { readFileSync } from 'node:fs'
import type { DevWebProcessSpec } from '@shared/devwebui'
import { DevServerError } from './contract'
import { ID_RE, parseJsonText, parseProjectSpec, ProjectFileError, writeJsonAtomic } from './project-file'

type Raw = Record<string, unknown> & { processes: Record<string, unknown>[] }

const SPEC_KEYS = ['id', 'name', 'command', 'cwd', 'color', 'env', 'autostart', 'starred', 'port', 'url', 'runtime', 'waitForPort', 'links', 'companion', 'compose', 'answers'] as const

function readRaw(file: string): Raw {
  let raw: unknown
  try {
    raw = parseJsonText(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new DevServerError(`Could not read ${file}: ${(e as Error).message}`, 400)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as Raw).processes)) throw new DevServerError(`${file} is not a valid .devwebui file`, 400)
  return raw as Raw
}

function save(file: string, raw: Raw): void {
  try {
    parseProjectSpec(raw)
  } catch (e) {
    if (e instanceof ProjectFileError) throw new DevServerError(e.message, 400)
    throw e
  }
  writeJsonAtomic(file, raw)
}

const indexOf = (raw: Raw, localId: string): number => raw.processes.findIndex((p) => p.id === localId)

/** The spec's own known keys with a value; anything else the page sent is dropped. */
function cleanSpec(spec: DevWebProcessSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of SPEC_KEYS) if (spec[k] !== undefined && spec[k] !== null) out[k] = spec[k]
  return out
}

/** Renames and recolors the project (`color: null` clears it). */
export function editProject(file: string, patch: { name?: string; color?: string | null }): void {
  const raw = readRaw(file)
  if (patch.name !== undefined) raw.name = patch.name
  if (patch.color === null) delete raw.color
  else if (patch.color !== undefined) raw.color = patch.color
  save(file, raw)
}

export function readSpec(file: string, localId: string): DevWebProcessSpec {
  const p = readRaw(file).processes.find((x) => x.id === localId)
  if (!p) throw new DevServerError(`No server "${localId}" in ${file}.`, 404)
  return p as unknown as DevWebProcessSpec
}

export function addSpec(file: string, spec: DevWebProcessSpec): void {
  const raw = readRaw(file)
  const clean = cleanSpec(spec)
  if (typeof clean.id !== 'string' || !ID_RE.test(clean.id)) throw new DevServerError('The server id may only contain letters, numbers, . _ -', 400)
  if (indexOf(raw, clean.id) >= 0) throw new DevServerError(`There is already a server with the id "${clean.id}".`, 400)
  raw.processes.push(clean)
  save(file, raw)
}

/**
 * Replaces one server's entry with `spec` (its id may change), keeping the keys the form does not own: unknown ones,
 * and `compose` and `starred` when the spec leaves them out (the page edits those elsewhere). Answers the entry's new
 * local id.
 */
export function replaceSpec(file: string, localId: string, spec: DevWebProcessSpec): string {
  const raw = readRaw(file)
  const at = indexOf(raw, localId)
  if (at < 0) throw new DevServerError(`No server "${localId}" in ${file}.`, 404)
  const old = raw.processes[at]!
  const clean = cleanSpec(spec)
  if (typeof clean.id !== 'string' || !ID_RE.test(clean.id)) throw new DevServerError('The server id may only contain letters, numbers, . _ -', 400)
  if (clean.id !== localId && indexOf(raw, clean.id) >= 0) throw new DevServerError(`There is already a server with the id "${clean.id}".`, 400)
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(old)) if (!(SPEC_KEYS as readonly string[]).includes(k)) next[k] = v
  for (const k of ['compose', 'starred'] as const) if (clean[k] === undefined && old[k] !== undefined) next[k] = old[k]
  raw.processes[at] = { ...next, ...clean }
  // A renamed id must not leave other servers pointing at the old one.
  if (clean.id !== localId)
    for (const p of raw.processes) {
      if (p.waitForPort === localId) p.waitForPort = clean.id
      if (Array.isArray(p.links)) p.links = p.links.map((l) => (l === localId ? clean.id : l))
    }
  save(file, raw)
  return clean.id
}

export function removeSpec(file: string, localId: string): void {
  const raw = readRaw(file)
  const at = indexOf(raw, localId)
  if (at < 0) throw new DevServerError(`No server "${localId}" in ${file}.`, 404)
  if (raw.processes.length === 1) throw new DevServerError('A project needs at least one server: remove the project instead.', 400)
  raw.processes.splice(at, 1)
  for (const p of raw.processes) {
    if (Array.isArray(p.links)) p.links = p.links.filter((l) => l !== localId)
    if (p.waitForPort === localId) delete p.waitForPort
  }
  save(file, raw)
}

export function setStarredInFile(file: string, localId: string, on: boolean): void {
  const raw = readRaw(file)
  const p = raw.processes[indexOf(raw, localId)]
  if (!p) throw new DevServerError(`No server "${localId}" in ${file}.`, 404)
  if (on) p.starred = true
  else delete p.starred
  save(file, raw)
}
