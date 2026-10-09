// The `.devwebui` project file: DevWebUI's format, kept exactly (the files are committed in people's repos). A small
// hand validator (desk2/server has no zod) whose messages say which server and which field is wrong, the stable ids
// (project = 'p' + sha1 of the file's normalized path, server = `<project>.<local id>`, identical to DevWebUI so its
// state.json overrides and the pane's remembered ids carry over), and the atomic writes every file here goes through.

import { createHash } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { AnswerRule } from './answers'
import { readRules } from './answers'
import type { ComposeSpec } from './compose'
import { renameOver, writeFlushed } from '../write-flushed'

export const ID_RE = /^[a-zA-Z0-9._-]+$/
const MAX_READINESS_MS = 10 * 60_000

export class ProjectFileError extends Error {}

/** A server as written in the file (`compose` and `answers` stay as written; the manager reads them). */
export interface ProcessSpec {
  id: string
  name: string
  command: string
  cwd?: string
  color?: string
  env?: Record<string, string>
  autostart?: boolean
  starred?: boolean
  port?: number
  url?: string
  runtime?: 'node' | 'bun'
  waitForPort?: number | string
  links?: string[]
  companion?: boolean
  compose?: unknown
  answers?: unknown
}

export interface ProjectSpec {
  name: string
  color?: string
  processes: ProcessSpec[]
}

/** A server of a loaded project: the file's entry with absolute cwd and global ids. */
export interface ProcessDef {
  /** `<project id>.<local id>`. */
  id: string
  localId: string
  name: string
  command: string
  /** Absolute. */
  cwd: string
  color?: string
  env?: Record<string, string>
  autostart?: boolean
  starred?: boolean
  port?: number
  url?: string
  /** The entry's own runtime pin; without one Settings decides. */
  runtime?: 'node' | 'bun'
  waitForPort?: number | string
  links?: string[]
  companion?: boolean
  /** Compose dependencies brought up before the server spawns; `file` is absolute. */
  compose?: ComposeSpec
  /** Replies typed to the server's stdin when its output asks. */
  answers?: AnswerRule[]
  projectId: string
  projectName: string
}

export interface LoadedProject {
  id: string
  name: string
  color?: string
  /** The .devwebui file, absolute. */
  path: string
  dir: string
  processes: ProcessDef[]
}

/** Absolute, forward slashes, lowercased where the filesystem ignores case (Windows, macOS). */
export function normalizePath(filePath: string): string {
  const abs = path.resolve(filePath).replace(/\\/g, '/')
  return process.platform === 'linux' ? abs : abs.toLowerCase()
}

export const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)

export function projectIdFromPath(filePath: string): string {
  return `p${createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 8)}`
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function str(v: unknown, what: string, opts: { optional?: boolean } = {}): string | undefined {
  if (v === undefined && opts.optional) return undefined
  if (typeof v !== 'string' || v === '') throw new ProjectFileError(`${what} must be a non-empty text`)
  return v
}

function bool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ProjectFileError(`${what} must be true or false`)
  return v
}

function port(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new ProjectFileError(`${what} must be a positive whole number`)
  return v
}

function parseProcess(raw: unknown, at: string): ProcessSpec {
  if (!isObject(raw)) throw new ProjectFileError(`${at} must be an object`)
  const label = typeof raw.id === 'string' && raw.id ? `${at} ("${raw.id}")` : at
  const id = str(raw.id, `${label}: id`)!
  if (!ID_RE.test(id)) throw new ProjectFileError(`${label}: id may only contain letters, numbers, . _ -`)
  const out: ProcessSpec = { ...(raw as object), id, name: str(raw.name, `${label}: name`)!, command: str(raw.command, `${label}: command`)! } as ProcessSpec
  checkPlainFields(raw, label)
  checkOrdering(raw, label)
  if (raw.compose !== undefined) {
    const compose = parseCompose(raw.compose, label)
    if (compose) out.compose = compose
  }
  if (raw.answers !== undefined && !Array.isArray(raw.answers)) throw new ProjectFileError(`${label}: answers must be a list`)
  return out
}

function checkPlainFields(raw: Record<string, unknown>, label: string): void {
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new ProjectFileError(`${label}: cwd must be text`)
  if (raw.color !== undefined && typeof raw.color !== 'string') throw new ProjectFileError(`${label}: color must be text`)
  if (raw.env !== undefined) {
    if (!isObject(raw.env) || Object.values(raw.env).some((v) => typeof v !== 'string')) throw new ProjectFileError(`${label}: env must map names to text values`)
  }
  bool(raw.autostart, `${label}: autostart`)
  bool(raw.starred, `${label}: starred`)
  bool(raw.companion, `${label}: companion`)
  port(raw.port, `${label}: port`)
  if (raw.url !== undefined) {
    // No javascript:, data:, file: and the like: a stored url must never become a script or redirect vector.
    if (typeof raw.url !== 'string' || !(/^https?:\/\//i.test(raw.url) || !/^[a-z][a-z0-9+.-]*:/i.test(raw.url))) throw new ProjectFileError(`${label}: url must be an http(s):// address or a path`)
  }
  if (raw.runtime !== undefined && raw.runtime !== 'node' && raw.runtime !== 'bun') throw new ProjectFileError(`${label}: runtime must be "node" or "bun"`)
}

function checkOrdering(raw: Record<string, unknown>, label: string): void {
  if (raw.waitForPort !== undefined) {
    const w = raw.waitForPort
    const ok = (typeof w === 'number' && Number.isInteger(w) && w > 0) || (typeof w === 'string' && w !== '')
    if (!ok) throw new ProjectFileError(`${label}: waitForPort must be a port number or the id of another server`)
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links) || raw.links.some((l) => typeof l !== 'string' || !ID_RE.test(l))) throw new ProjectFileError(`${label}: links must be a list of server ids`)
  }
}

/** Validates `compose`; answers a replacement only when its readiness wait had to be capped. */
function parseCompose(c: unknown, label: string): Record<string, unknown> | undefined {
  if (!isObject(c)) throw new ProjectFileError(`${label}: compose must be an object`)
  // Omitted, compose finds compose.yaml in the server's folder.
  str(c.file, `${label}: compose.file`, { optional: true })
  if (c.mode !== undefined && c.mode !== 'none' && c.mode !== 'start-only' && c.mode !== 'start-and-stop') throw new ProjectFileError(`${label}: compose.mode must be "none", "start-only" or "start-and-stop"`)
  bool(c.skipIfRunning, `${label}: compose.skipIfRunning`)
  bool(c.injectEnv, `${label}: compose.injectEnv`)
  // A longer wait would hold a start for hours on a typo; `up` itself gives up after 10 minutes.
  const wait = port(c.readinessTimeoutMs, `${label}: compose.readinessTimeoutMs`)
  if (c.services !== undefined && (!Array.isArray(c.services) || c.services.some((s) => typeof s !== 'string' || s === ''))) throw new ProjectFileError(`${label}: compose.services must be a list of service names`)
  return wait && wait > MAX_READINESS_MS ? { ...c, readinessTimeoutMs: MAX_READINESS_MS } : undefined
}

/** Validates a parsed .devwebui body (also the scaffold body). Throws ProjectFileError with a readable message. */
export function parseProjectSpec(raw: unknown): ProjectSpec {
  if (!isObject(raw)) throw new ProjectFileError('the project must be an object with a name and a list of processes')
  const name = str(raw.name, 'name')!
  if (raw.color !== undefined && typeof raw.color !== 'string') throw new ProjectFileError('color must be text')
  if (!Array.isArray(raw.processes) || raw.processes.length === 0) throw new ProjectFileError('processes must list at least one server')
  const seen = new Set<string>()
  const processes = raw.processes.map((p, i) => {
    const spec = parseProcess(p, `processes[${i}]`)
    if (seen.has(spec.id)) throw new ProjectFileError(`processes[${i}]: duplicate id "${spec.id}"`)
    seen.add(spec.id)
    return spec
  })
  return { ...(raw as object), name, processes } as ProjectSpec
}

/** Parses JSON from disk, tolerating a UTF-8 BOM (Notepad writes one). */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^﻿/, ''))
}

/** Reads and validates a .devwebui file into a loadable project. Throws an Error whose message names the file. */
export function readProjectFile(filePath: string): LoadedProject {
  const abs = path.resolve(filePath)
  let spec: ProjectSpec
  let raw: unknown
  try {
    raw = parseJsonText(readFileSync(abs, 'utf8'))
  } catch (e) {
    throw new ProjectFileError(`Could not read ${abs}: ${(e as Error).message}`)
  }
  try {
    spec = parseProjectSpec(raw)
  } catch (e) {
    throw new ProjectFileError(`${abs} is not a valid .devwebui file: ${(e as Error).message}`)
  }
  const id = projectIdFromPath(abs)
  const dir = path.dirname(abs)
  const processes = spec.processes.map((p): ProcessDef => {
    const compose = p.compose as ComposeSpec | undefined
    const answers = readRules(p.answers)
    return {
      id: `${id}.${p.id}`,
      localId: p.id,
      name: p.name,
      command: p.command,
      cwd: path.resolve(dir, p.cwd ?? '.'),
      ...(p.color ? { color: p.color } : {}),
      ...(p.env ? { env: p.env } : {}),
      ...(p.autostart !== undefined ? { autostart: p.autostart } : {}),
      ...(p.starred !== undefined ? { starred: p.starred } : {}),
      ...(p.port !== undefined ? { port: p.port } : {}),
      ...(p.url ? { url: p.url } : {}),
      ...(p.runtime ? { runtime: p.runtime } : {}),
      ...(p.waitForPort !== undefined ? { waitForPort: p.waitForPort } : {}),
      ...(p.links ? { links: p.links } : {}),
      ...(p.companion !== undefined ? { companion: p.companion } : {}),
      ...(compose ? { compose: compose.file ? { ...compose, file: path.resolve(dir, compose.file) } : compose } : {}),
      ...(answers.length ? { answers } : {}),
      projectId: id,
      projectName: spec.name,
    }
  })
  return { id, name: spec.name, ...(spec.color ? { color: spec.color } : {}), path: abs, dir, processes }
}

/**
 * Temp file beside the target, then rename: a crash leaves the old file or the new one whole, never half. The temp is
 * a sibling (rename is only atomic inside one filesystem) and carries the pid so two writers cannot collide on it.
 */
export function writeFileAtomic(filePath: string, contents: string): void {
  const target = path.resolve(filePath)
  if (sameContents(target, contents)) return
  const tmp =`${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFlushed(tmp, contents)
    renameOver(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the error below is the one worth reporting
    }
    throw e
  }
}

/** The file already holds exactly this text, so a write would change nothing (and wake every watcher for nothing). */
function sameContents(file: string, contents: string): boolean {
  try {
    return statSync(file).size === Buffer.byteLength(contents) && readFileSync(file, 'utf8') === contents
  } catch {
    return false
  }
}

export function writeJsonAtomic(filePath: string, value: unknown, trailingNewline = true): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`)
}
