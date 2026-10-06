// What the service keeps in <home>/devservers: registry.json (which .devwebui files are loaded), state.json (on/off
// preferences that only decide autostart) and resume.json (the servers to start again after a restart). On the very
// first run the registry and state come from DevWebUI's old data folder, read and never written.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseJsonText, samePath, writeJsonAtomic } from './project-file'

export interface StateShape {
  /** server id -> on/off */
  enabled: Record<string, boolean>
  /** project id -> on/off (a master switch) */
  projectEnabled: Record<string, boolean>
}

export const dataDir = (home: string): string => path.join(home, 'devservers')
export const registryPath = (home: string): string => path.join(dataDir(home), 'registry.json')
export const statePath = (home: string): string => path.join(dataDir(home), 'state.json')
export const resumePath = (home: string): string => path.join(dataDir(home), 'resume.json')

export const defaultImportDir = (): string => path.join(homedir(), '.devwebui')

function readJson(file: string): unknown {
  try {
    return parseJsonText(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const flags = (v: unknown): Record<string, boolean> => {
  const out: Record<string, boolean> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, b] of Object.entries(v)) if (typeof b === 'boolean') out[k] = b
  return out
}

function parseRegistry(v: unknown): string[] {
  const list = v && typeof v === 'object' ? (v as { projects?: unknown }).projects : null
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

export function parseState(v: unknown): StateShape {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return { enabled: flags(o.enabled), projectEnabled: flags(o.projectEnabled) }
}

export interface Loaded {
  registry: string[]
  state: StateShape
  /** The registry and state came from the old DevWebUI folder (and were written to ours). */
  imported: boolean
}

/** Reads our files; on a first run (no registry.json) imports the old DevWebUI folder's, writes ours, never the old. */
export function loadFiles(home: string, importFrom: string | null): Loaded {
  mkdirSync(dataDir(home), { recursive: true })
  if (existsSync(registryPath(home))) {
    return { registry: parseRegistry(readJson(registryPath(home))), state: parseState(readJson(statePath(home))), imported: false }
  }
  let registry: string[] = []
  let state: StateShape = { enabled: {}, projectEnabled: {} }
  let imported = false
  if (importFrom) {
    registry = parseRegistry(readJson(path.join(importFrom, 'registry.json'))).filter((p) => existsSync(p))
    state = parseState(readJson(path.join(importFrom, 'state.json')))
    imported = registry.length > 0 || Object.keys(state.enabled).length > 0 || Object.keys(state.projectEnabled).length > 0
  }
  writeRegistry(home, registry)
  if (imported) writeState(home, state)
  return { registry, state, imported }
}

export function writeRegistry(home: string, paths: string[]): void {
  mkdirSync(dataDir(home), { recursive: true })
  writeJsonAtomic(registryPath(home), { projects: paths }, false)
}

export function writeState(home: string, state: StateShape): void {
  mkdirSync(dataDir(home), { recursive: true })
  writeJsonAtomic(statePath(home), state, false)
}

/** Adds a path to a registry list unless it is there (same file by normalized path). Returns the list and whether it grew. */
export function withPath(list: string[], file: string): { list: string[]; added: boolean } {
  if (list.some((x) => samePath(x, file))) return { list, added: false }
  return { list: [...list, path.resolve(file)], added: true }
}

/** resume.json's ids; the file is removed by the caller once they are started. */
export function readResume(home: string): string[] {
  const v = readJson(resumePath(home))
  const ids = v && typeof v === 'object' ? (v as { ids?: unknown }).ids : null
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

export function removeResume(home: string): void {
  rmSync(resumePath(home), { force: true })
}
