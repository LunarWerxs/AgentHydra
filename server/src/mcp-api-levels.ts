// FROZEN MCP API LEVELS: one committed snapshot of the MCP tool surface per release.
//
// WHY THIS EXISTS. Agents call these tools from prompts, skills and scripts that outlive any one
// release, and nothing validates their arguments client-side (tests/mcp.test.ts pins that), so a
// tool that disappears, or an optional argument that becomes required, breaks those callers
// SILENTLY: the call still goes out and fails somewhere far from the change. A hand-kept list of
// "tools we promise" only guards what somebody remembered to list. This derives the frozen surface
// from TOOLS itself, so every tool and every argument is guarded without anyone declaring it.
//
// The idea is Neovim's API levels (test/functional/api/version_spec.lua, Apache-2.0): each release
// commits its generated API metadata, and a test replays every committed level against the live
// metadata. Written fresh for AgentHydra; no code copied.
//
// A level is `server/mcp-api-levels/<version>.json`: every tool's name, the release it first
// appeared in (`since`, the earliest committed level holding it; the first level, 1.2.0, is the
// baseline, so `since: 1.2.0` means "at or before 1.2.0"), and its input schema with descriptions
// stripped, because prose changes every week and is not the contract. Written by
// `bun run mcp:api-level --write` as part of a release (docs/RELEASING.md), never edited by hand.
// The directory is outside biome's reach on purpose: reformatting a frozen level rewrites it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpEngineTool } from './mcp-stdio.mjs'

export interface ApiLevelTool {
  name: string
  since: string
  inputSchema: unknown
}

export interface ApiLevel {
  version: string
  tools: ApiLevelTool[]
}

/** One way the live surface fails a caller written against a frozen level. */
export interface ApiBreak {
  /** The level it breaks, e.g. `1.2.0`. */
  level: string
  /** `tool`, `tool.arg`, `tool.arg[].field`: where the break is. */
  path: string
  what: string
}

export const API_LEVELS_DIR = join(import.meta.dir, '..', 'mcp-api-levels')

/**
 * BREAKS SHIPPED ON PURPOSE. Keyed `<level>:<path>`, valued with why and where callers were told.
 * An entry here is the only way past the gate, and it is meant to be rare and visible in review:
 * the precedent is `move_chats.archived` (a boolean replaced by `archived_count` with no shim,
 * 2026-09-13, before levels existed), which was a deliberate, documented break.
 */
export const ACCEPTED_BREAKS: Record<string, string> = {}

type Schema = Record<string, unknown>

const isObject = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v)

/** `1.10.0` sorts after `1.9.0`; a missing segment reads as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The contract part of a JSON Schema: descriptions dropped, keys and `required` sorted, so two
 *  levels differ only where a caller could notice. A property literally named `description` is a
 *  schema object, not a string, and survives. */
export function contractOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(contractOf)
  if (!isObject(schema)) return schema
  const out: Schema = {}
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key]
    if (key === 'description' && typeof value === 'string') continue
    out[key] = key === 'required' && Array.isArray(value) ? [...value].sort() : contractOf(value)
  }
  return out
}

/** The live surface as a level for `version`. `since` comes from the earliest of `earlier` that
 *  holds the tool, else this version: a tool is new exactly when no frozen level has it. */
export function surfaceOf(tools: McpEngineTool[], version: string, earlier: ApiLevel[]): ApiLevel {
  const ordered = [...earlier].sort((a, b) => compareVersions(a.version, b.version))
  return {
    version,
    tools: [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        since: ordered.find((l) => l.tools.some((f) => f.name === t.name))?.version ?? version,
        inputSchema: contractOf(t.inputSchema),
      })),
  }
}

/** Every committed level, oldest first. */
export function loadApiLevels(dir: string = API_LEVELS_DIR): ApiLevel[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^\d+\.\d+\.\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ApiLevel)
    .sort((a, b) => compareVersions(a.version, b.version))
}

const typesOf = (s: Schema): string[] | null =>
  typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : null

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/** Push every way `cur` accepts less than `old` did. Loosening (a new optional field, a dropped
 *  requirement, a wider type) is never a break. Not compared: `const`, `anyOf`/`oneOf`/`allOf`
 *  and `pattern`, so a tightening made through any of them goes unflagged (no tool uses them
 *  today); extend this before a schema starts to. */
function schemaBreaks(old: unknown, cur: unknown, path: string, out: Array<[string, string]>) {
  if (!isObject(old) || !isObject(cur)) return
  const oldTypes = typesOf(old)
  const curTypes = typesOf(cur)
  if (curTypes) {
    const lost = oldTypes ? oldTypes.filter((t) => !curTypes.includes(t)) : ['any']
    if (lost.length) out.push([path, `type no longer accepts ${lost.join(', ')}`])
  }
  if (Array.isArray(cur.enum)) {
    const curEnum = cur.enum as unknown[]
    if (!Array.isArray(old.enum)) out.push([path, 'now restricted to an enum'])
    else {
      const lost = (old.enum as unknown[]).filter((v) => !curEnum.includes(v))
      if (lost.length) out.push([path, `enum value(s) removed: ${lost.join(', ')}`])
    }
  }
  for (const key of ['minimum', 'minLength', 'minItems'] as const) {
    const was = num(old[key]) ?? Number.NEGATIVE_INFINITY
    const now = num(cur[key])
    if (now !== null && now > was) out.push([path, `${key} raised to ${now}`])
  }
  for (const key of ['maximum', 'maxLength', 'maxItems'] as const) {
    const was = num(old[key]) ?? Number.POSITIVE_INFINITY
    const now = num(cur[key])
    if (now !== null && now < was) out.push([path, `${key} lowered to ${now}`])
  }
  if (old.additionalProperties !== false && cur.additionalProperties === false) {
    out.push([path, 'no longer accepts extra properties'])
  }
  const oldProps = isObject(old.properties) ? old.properties : {}
  const curProps = isObject(cur.properties) ? cur.properties : {}
  for (const name of Object.keys(oldProps)) {
    const at = path ? `${path}.${name}` : name
    if (!(name in curProps)) out.push([at, 'argument removed'])
    else schemaBreaks(oldProps[name], curProps[name], at, out)
  }
  const oldRequired = Array.isArray(old.required) ? (old.required as string[]) : []
  const curRequired = Array.isArray(cur.required) ? (cur.required as string[]) : []
  for (const name of curRequired) {
    if (oldRequired.includes(name)) continue
    const at = path ? `${path}.${name}` : name
    out.push([at, name in oldProps ? 'optional argument became required' : 'new required argument'])
  }
  if (old.items !== undefined) schemaBreaks(old.items, cur.items, `${path}[]`, out)
}

/** How `live` breaks a caller written against `frozen`, minus ACCEPTED_BREAKS. */
export function breaksBetween(
  frozen: ApiLevel,
  live: ApiLevel,
  accepted: Record<string, string> = ACCEPTED_BREAKS,
): ApiBreak[] {
  const found: Array<[string, string]> = []
  for (const tool of frozen.tools) {
    const now = live.tools.find((t) => t.name === tool.name)
    if (!now) found.push([tool.name, 'tool removed'])
    else schemaBreaks(tool.inputSchema, now.inputSchema, tool.name, found)
  }
  return found
    .filter(([path]) => !(`${frozen.version}:${path}` in accepted))
    .map(([path, what]) => ({ level: frozen.version, path, what }))
}
