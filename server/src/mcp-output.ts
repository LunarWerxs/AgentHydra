// MCP OUTPUT SHAPING: what every tool result passes through on its way to an agent's context.
//
// Two things, applied at the one place tools are handed to a transport (stdio in mcp.ts, HTTP in
// index.ts), so no tool has to do either itself:
//
// 1. PROJECTION. Every read tool advertises an optional `jmespath` argument. The expression is
//    parsed BEFORE the tool runs (a bad one refuses the call with nothing done) and applied to the
//    tool's result, so an agent that wants one field of 300 session rows gets that field and not
//    the rows. A projection that matches nothing, or fails on the result's types, answers with the
//    result's top-level keys, so the retry can be written right without fetching the shape first.
//    Write tools (description `MUTATES:`) do not advertise it: their answer IS the confirmation.
//
// 2. A SIZE GUARD. The result is measured in exact UTF-8 bytes of the text the engine sends
//    (mcp-stdio.mjs pretty-prints with two spaces), not a guessed token count. At 80% of the cap it
//    says so; over the cap it is cut in progressively harsher phases until it fits, and every cut
//    is named, with the tool's own arguments for asking for less. Before this, a big transcript
//    or session list either flooded the context or was cut silently by the client.
//
// A WRITE CONFIRMATION SURVIVES EVERY PHASE. The top-level scalars of a result (`ok`, `verdict`,
// `operationId`, `groupId`, `targetNote`, ...) and the fields named in COMMITTED_FIELDS are put back
// after each cut, so an oversized move or fan-out answer still reads as the success it was. An
// agent that reads a landed write as a failure runs it again, which is the worst outcome here.

import { appEnv } from './config'
import { compile, type JmesNode, JmesPathError, search } from './jmespath'
import type { McpEngineTool } from './mcp-stdio.mjs'

/** ~20k tokens of pretty-printed JSON: under what Claude Code itself will accept from one MCP
 *  result, so the guard cuts with notes before the client cuts without them. */
export const DEFAULT_MAX_RESULT_BYTES = 80_000
const MIN_MAX_RESULT_BYTES = 4_096
const WARN_RATIO = 0.8
const MAX_EXPRESSION_BYTES = 1_024

/** The cap, from AGENTHYDRA_MCP_MAX_RESULT_BYTES when set to a sane number. Read per call, so a
 *  test (or an operator) can change it without a restart. */
export function maxResultBytes(): number {
  const raw = Number(appEnv('MCP_MAX_RESULT_BYTES'))
  return Number.isFinite(raw) && raw >= MIN_MAX_RESULT_BYTES
    ? Math.floor(raw)
    : DEFAULT_MAX_RESULT_BYTES
}

/** Exactly what the engine will write for this value (mcp-stdio.mjs handleToolsCall). */
export function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) ?? '', 'utf8')
}

/** Kept to one line on purpose: it is repeated on every read tool in tools/list. */
export const JMESPATH_ARG_DESCRIPTION =
  'Optional JMESPath applied to the result server-side, e.g. "sessions[].{id:id,title:title}".'

/** The grammar, shown once: when an expression does not parse. */
const JMESPATH_HELP =
  'JMESPath: a.b (field), a[0] / a[-1] (index), a[:10] (slice), a[].b (each item), ' +
  "a[?state=='open'].id (filter; ==, !=, <, >, &&, ||, !), {id:id,t:title} / [id,title] (pick), " +
  "x | y (pipe), 'raw', `json` literals; functions length keys values contains starts_with " +
  'sort_by(a,&k) max_by min_by reverse join sum avg max min to_string type not_null.'

/** Fields a write tool's answer carries that must survive a cut even when they are not scalars:
 *  the per-chat or per-member outcome and any bystander the act touched. Top-level scalars
 *  survive on every tool without being listed. */
export const COMMITTED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  move_chat: ['collateral', 'refused'],
  move_chats: ['collateral', 'refused', 'results'],
  fan_out: ['members', 'unassigned'],
  fan_out_send: ['results'],
  fan_out_delete: ['results'],
  import_session_to_desktop: ['session'],
  archive_desktop_chat: ['result'],
  unblock_prompts: ['pressed', 'notFound'],
  sync_versions: ['synced', 'flagged'],
})

/** Each tool's OWN way of asking for less, named in the truncation note. */
const NARROWING: Readonly<Record<string, string>> = Object.freeze({
  list_sessions: 'project=, source=, instance=, a shorter period=, or limit=/offset= paging',
  search_sessions: 'limit=, source= or instance=',
  list_chats: 'instance=, q=, limit=/offset= paging',
  get_session: 'tail_session {id, limit, textOnly: true} for the latest turns only',
  tail_session: 'a smaller limit=, textOnly: true, humanOnly: true, thinking: false',
  export_session: 'tail_session {id, limit, textOnly: true} instead of the whole export',
  list_rate_limited_sessions: 'limit=, pendingOnly: true, project=',
  get_recent_edits: 'a smaller limit=',
  get_run_events: 'the run id of one run, and a jmespath over its events',
  orchestrator_run: "the script's own --json / --limit flags (run args: ['--help'])",
  orchestrator_operation: 'an id= (one operation) rather than the recent list',
  move_chats: 'fewer chats per call; poll orchestrator_operation {id} for the full report',
  fan_out_status: 'group= (one group)',
})

const TOP_SCALAR_MAX_CHARS = 500
const COMMITTED_STRING_MAX_CHARS = 120
const COMMITTED_ITEMS_MAX = 100

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A JSON round-trip: what the agent would have received, minus undefined and functions. */
function toJson(value: unknown): Json {
  const text = JSON.stringify(value)
  return text === undefined ? null : (JSON.parse(text) as Json)
}

/** `sessions: array(312)`, `ok: boolean` - the shape an agent needs to write its next expression. */
export function describeKeys(value: unknown): string[] {
  if (Array.isArray(value)) return [`(top level is an array of ${value.length})`]
  if (!isRecord(value)) return [`(top level is ${value === null ? 'null' : typeof value})`]
  return Object.entries(value).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: array(${v.length})`
    if (isRecord(v)) return `${k}: object(${Object.keys(v).length} keys)`
    return `${k}: ${v === null ? 'null' : typeof v}`
  })
}

// --- the size guard -------------------------------------------------------------------------------

interface Phase {
  name: string
  stringMax: number
  arrayMax: number
  /** Objects/arrays nested deeper than this become a one-line summary; Infinity keeps them all. */
  depthMax: number
}

/** Five phases, each harsher than the last, each applied to the ORIGINAL result, so the first that
 *  fits keeps the most. The last is a skeleton: every top-level key, nothing below it. */
const PHASES: readonly Phase[] = [
  {
    name: 'long strings cut to 2000 chars',
    stringMax: 2000,
    arrayMax: Infinity,
    depthMax: Infinity,
  },
  {
    name: 'strings cut to 500, lists to 50 items',
    stringMax: 500,
    arrayMax: 50,
    depthMax: Infinity,
  },
  {
    name: 'strings cut to 200, lists to 10, nesting past 4 levels summarized',
    stringMax: 200,
    arrayMax: 10,
    depthMax: 4,
  },
  {
    name: 'strings cut to 100, lists to 3, nesting past 2 levels summarized',
    stringMax: 100,
    arrayMax: 3,
    depthMax: 2,
  },
  { name: 'skeleton: top-level keys only', stringMax: 100, arrayMax: 0, depthMax: 1 },
]

interface CutLog {
  strings: number
  arrays: string[]
  collapsed: number
}

function summarize(v: Json): string {
  if (Array.isArray(v)) return `[array of ${v.length} cut]`
  if (isRecord(v))
    return `[object with ${Object.keys(v).length} keys cut: ${Object.keys(v).slice(0, 8).join(', ')}]`
  return String(v)
}

function shape(v: Json, phase: Phase, path: string, depth: number, log: CutLog): Json {
  if (typeof v === 'string') {
    if (v.length <= phase.stringMax) return v
    log.strings++
    return `${v.slice(0, phase.stringMax)}... [cut ${v.length - phase.stringMax} of ${v.length} chars]`
  }
  if (v === null || typeof v !== 'object') return v
  if (depth >= phase.depthMax) {
    log.collapsed++
    return summarize(v)
  }
  if (Array.isArray(v)) {
    const kept = v.slice(0, phase.arrayMax)
    if (kept.length < v.length)
      log.arrays.push(`${path || '(top)'}: kept ${kept.length} of ${v.length}`)
    return kept.map((x, i) => shape(x, phase, `${path}[${i}]`, depth + 1, log))
  }
  const out: { [key: string]: Json } = {}
  for (const [k, x] of Object.entries(v))
    out[k] = shape(x, phase, path ? `${path}.${k}` : k, depth + 1, log)
  return out
}

/** One element of a committed list, reduced to its own scalars: enough to read what happened to
 *  it (id, state, verdict, why) without its nested detail. */
function committedItem(v: Json): Json {
  if (typeof v === 'string' && v.length > COMMITTED_STRING_MAX_CHARS)
    return `${v.slice(0, COMMITTED_STRING_MAX_CHARS)}...`
  if (!isRecord(v)) return Array.isArray(v) ? `[array of ${v.length}]` : v
  const out: { [key: string]: Json } = {}
  for (const [k, x] of Object.entries(v)) {
    if (x !== null && typeof x === 'object') continue
    out[k] =
      typeof x === 'string' && x.length > COMMITTED_STRING_MAX_CHARS
        ? `${x.slice(0, COMMITTED_STRING_MAX_CHARS)}...`
        : x
  }
  return out
}

/** The fields of `value` that must come through any cut unchanged in meaning. */
function committedPart(tool: string, value: Json): { [key: string]: Json } {
  if (!isRecord(value)) return {}
  const keep: { [key: string]: Json } = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') keep[k] = v
    else if (typeof v === 'string' && v.length <= TOP_SCALAR_MAX_CHARS) keep[k] = v
  }
  for (const k of COMMITTED_FIELDS[tool] ?? []) {
    const v = value[k]
    if (v === undefined) continue
    keep[k] = Array.isArray(v)
      ? v.slice(0, COMMITTED_ITEMS_MAX).map(committedItem)
      : committedItem(v)
  }
  return keep
}

function narrowingHint(tool: string, value: Json, projectable: boolean): string[] {
  const hints: string[] = []
  if (NARROWING[tool]) hints.push(`${tool} takes ${NARROWING[tool]}`)
  if (projectable) {
    const firstList = isRecord(value)
      ? Object.entries(value).find(([, v]) => Array.isArray(v))?.[0]
      : undefined
    hints.push(
      firstList
        ? `pass jmespath to take only what you need, e.g. "${firstList}[:20]" or "keys(@)"`
        : 'pass jmespath to take only what you need, e.g. "keys(@)" to see the shape first',
    )
  }
  return hints
}

/**
 * Hold one result to the byte cap. Under 80% it passes untouched; 80-100% an object gains a
 * `_responseSize` note; over the cap it is cut phase by phase and answers with `_truncated` first,
 * saying what was cut, how big it was, and how to ask for less.
 */
export function guardResult(
  tool: string,
  value: unknown,
  opts: { limit?: number; projectable?: boolean } = {},
): unknown {
  const limit = opts.limit ?? maxResultBytes()
  const bytes = resultBytes(value)
  if (bytes <= limit) {
    if (bytes < limit * WARN_RATIO || !isRecord(value)) return value
    const noted = {
      _responseSize: {
        bytes,
        limit,
        note: `this answer is ${Math.round((bytes / limit) * 100)}% of the per-result cap; a larger one would be cut`,
        narrow: narrowingHint(tool, toJson(value), opts.projectable === true),
      },
      ...value,
    }
    // The note must never be what pushes a fitting answer over the cap.
    return resultBytes(noted) <= limit ? noted : value
  }
  const json = toJson(value)
  const committed = committedPart(tool, json)
  const narrow = narrowingHint(tool, json, opts.projectable === true)
  const committedLists = (COMMITTED_FIELDS[tool] ?? []).filter((k) => isRecord(json) && k in json)
  for (const [i, phase] of PHASES.entries()) {
    const log: CutLog = { strings: 0, arrays: [], collapsed: 0 }
    const cut = shape(json, phase, '', 0, log)
    const notes: string[] = []
    if (log.strings) notes.push(`${log.strings} string(s) cut short`)
    if (log.arrays.length)
      notes.push(
        `list(s) cut: ${log.arrays.slice(0, 8).join('; ')}${log.arrays.length > 8 ? `; +${log.arrays.length - 8} more` : ''}`,
      )
    if (log.collapsed) notes.push(`${log.collapsed} nested value(s) summarized`)
    if (committedLists.length)
      notes.push(
        `${committedLists.join(', ')}: every item kept, each reduced to its own scalar fields`,
      )
    const truncated = {
      bytes,
      limit,
      phase: `${i + 1} of ${PHASES.length}: ${phase.name}`,
      notes,
      narrow,
      ...(i === PHASES.length - 1 ? { keys: describeKeys(json) } : {}),
    }
    const answer = isRecord(cut)
      ? { _truncated: truncated, ...cut, ...committed }
      : { _truncated: truncated, result: cut }
    if (resultBytes(answer) <= limit || i === PHASES.length - 1) return answer
  }
  return value // unreachable: the last phase always answers
}

// --- projection ---------------------------------------------------------------------------------

/** The `jmespath` argument on the read tools, parsed before anything runs. */
function compileArg(tool: string, raw: unknown): JmesNode | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new Error(`${tool}: jmespath must be a string. Nothing ran.`)
  if (Buffer.byteLength(raw, 'utf8') > MAX_EXPRESSION_BYTES)
    throw new Error(`${tool}: jmespath is longer than ${MAX_EXPRESSION_BYTES} bytes. Nothing ran.`)
  try {
    return compile(raw)
  } catch (e) {
    if (!(e instanceof JmesPathError)) throw e
    throw new Error(
      `${tool}: jmespath "${raw}" does not parse: ${e.message}. Nothing ran. ${JMESPATH_HELP}`,
    )
  }
}

/** A read tool is one whose description does not start its contract with MUTATES:. */
export function isProjectable(tool: McpEngineTool): boolean {
  return !/MUTATES:/.test(tool.description)
}

function withJmespathArg(schema: unknown): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return schema
  return {
    ...schema,
    properties: {
      ...schema.properties,
      jmespath: { type: 'string', description: JMESPATH_ARG_DESCRIPTION },
    },
  }
}

/**
 * Put every tool behind the projection and the size guard. Apply it where tools are handed to a
 * transport, beneath the daemon and restart warnings so those still ride on the shaped answer.
 */
export function withOutputShaping(tools: McpEngineTool[]): McpEngineTool[] {
  return tools.map((t) => {
    const projectable = isProjectable(t)
    return {
      ...t,
      inputSchema: projectable ? withJmespathArg(t.inputSchema) : t.inputSchema,
      run: async (args: Record<string, unknown>, signal?: AbortSignal) => {
        if (!projectable) return guardResult(t.name, await t.run(args, signal))
        const { jmespath, ...rest } = args
        const node = compileArg(t.name, jmespath)
        const value = await t.run(rest, signal)
        if (!node) return guardResult(t.name, value, { projectable })
        // From here the tool HAS run, so a failed projection answers as data, never as a tool
        // error: not every tool that acts is labelled MUTATES: (chat_rename, orchestrator_run),
        // and an agent that reads a landed act as a failure runs it again.
        const keys = describeKeys(value).join(', ')
        let projected: unknown
        try {
          projected = search(node, toJson(value))
        } catch (e) {
          if (!(e instanceof JmesPathError)) throw e
          return {
            jmespath,
            result: null,
            projectionError: e.message,
            note: `the call itself ran and completed; only the projection failed. The result's top-level keys: ${keys}.`,
          }
        }
        if (projected === null || projected === undefined)
          return {
            jmespath,
            result: null,
            note: `the call itself ran; the expression matched nothing. The result's top-level keys: ${keys}.`,
          }
        return guardResult(t.name, projected, { projectable })
      },
    }
  })
}
