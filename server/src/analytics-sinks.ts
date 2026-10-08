// server/src/analytics-sinks.ts - the token-sink evidence analytics.ts keeps per session: what a session loaded
// into its prompt prefix (skill listings, MCP instructions and deferred tool names), what it actually used, and
// its deep-context calls. Names and numbers only, never message text. analytics.ts folds each transcript line
// through foldSinkLine and stores storedSinks(...) in the row's sinks_json; its sinkReport ranks them.

import { createHash } from 'node:crypto'

/**
 * A prompt past this many tokens is a "deep context" call.
 *
 * WHY THIS NUMBER: every call re-reads the whole history, so a call at 150k tokens pays for 150k
 * of prompt however small its reply, and long contexts are where answers get worse. It sits below
 * the point Claude Code auto-compacts a 200k window, so it flags sessions drifting toward that
 * rather than only the ones that hit it.
 */
export const DEEP_CONTEXT_TOKENS = 150_000

/**
 * What a session loaded into its prompt prefix, what it actually used, and where its tokens went
 * beyond that. Names and numbers only, never text: a skill's description is measured (its length
 * becomes a token estimate) and then dropped.
 */
export interface SinkScan {
  /** Skill listings seen, by fingerprint -> skill name -> estimated tokens. */
  listings: Map<string, Record<string, number>>
  /** Skill name -> invocations (Skill tool calls and /slash commands). */
  skillUses: Record<string, number>
  /** MCP server -> its instructions block (estimated tokens) and its deferred tool names. */
  mcp: Map<string, { instr: number; tools: Map<string, number> }>
  deepCalls: number
  deepWeighted: number
  /** What deep calls paid to read the part of their prompt past DEEP_CONTEXT_TOKENS (deepExcessOf). */
  deepExcess: number
  /** Weighted tokens spent in subagent transcripts (the session's sibling files). */
  subWeighted: number
}

/** The stored shape of SinkScan: listings by fingerprint only (skill_listings holds the rest). */
export interface StoredSinks {
  listings: string[]
  skillUses: Record<string, number>
  /** MCP server -> estimated prefix tokens (instructions plus deferred tool names). */
  mcpLoad: Record<string, number>
  deepCalls: number
  deepWeighted: number
  deepExcess: number
  subWeighted: number
}

export function emptySinks(): SinkScan {
  return {
    listings: new Map(),
    skillUses: {},
    mcp: new Map(),
    deepCalls: 0,
    deepWeighted: 0,
    deepExcess: 0,
    subWeighted: 0,
  }
}

/** Tokens a piece of injected text costs, estimated at four characters a token. An estimate, and
 *  labelled one wherever it is reported: no tokenizer ships with this daemon. */
const estTokens = (chars: number): number => Math.ceil(chars / 4)

/** An MCP server's name as Claude Code prefixes its tools (`mcp__<server>__<tool>`), so the
 *  server named in an instructions block and the one in a tool name land on the same key. */
function mcpServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The server part of `mcp__<server>__<tool>`, or null for a tool that is not an MCP tool. */
export function mcpServerOfTool(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null
  const end = tool.indexOf('__', 5)
  return end > 5 ? tool.slice(5, end) : null
}

type SinkAttachment = {
  type?: string
  names?: unknown
  content?: unknown
  addedNames?: unknown
  addedBlocks?: unknown
  addedLines?: unknown
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** A skill listing's names with a token estimate each, from its own `- name: description` lines. */
function readSkillListing(a: SinkAttachment, sinks: SinkScan): void {
  const entries: Record<string, number> = {}
  const content = typeof a.content === 'string' ? a.content : ''
  for (const line of content.split('\n')) {
    if (!line.startsWith('- ')) continue
    // Split at the first ': ', not the first ':' - a plugin skill is named `plugin:skill`, and
    // splitting inside its name would fold every skill of that plugin into one fake entry.
    const sep = line.indexOf(': ')
    const name = (sep > 2 ? line.slice(2, sep) : line.slice(2).replace(/:$/, '')).trim()
    if (name) entries[name] = estTokens(line.length + 1)
  }
  // A listing that names a skill without a line for it still carries its name.
  for (const name of strings(a.names)) entries[name] ??= estTokens(name.length + 4)
  const keys = Object.keys(entries).sort()
  if (keys.length === 0) return
  const sorted: Record<string, number> = {}
  for (const k of keys) sorted[k] = entries[k] as number
  const hash = createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 16)
  sinks.listings.set(hash, sorted)
}

function mcpEntry(sinks: SinkScan, server: string) {
  const e = sinks.mcp.get(server) ?? { instr: 0, tools: new Map<string, number>() }
  sinks.mcp.set(server, e)
  return e
}

/** An `mcp_instructions_delta`: each named server's instructions block, sized. */
function foldMcpInstructions(a: SinkAttachment, sinks: SinkScan): void {
  const names = Array.isArray(a.addedNames) ? a.addedNames : []
  const blocks = Array.isArray(a.addedBlocks) ? a.addedBlocks : []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const block = blocks[i]
    if (typeof name !== 'string') continue
    const e = mcpEntry(sinks, mcpServerKey(name))
    // Largest seen, not summed: a subagent or a reconnect re-announces the same block.
    e.instr = Math.max(e.instr, estTokens(typeof block === 'string' ? block.length : 0))
  }
}

/** A `deferred_tools_delta`: each MCP tool's listing line, sized under its server. */
function foldDeferredTools(a: SinkAttachment, sinks: SinkScan): void {
  const names = Array.isArray(a.addedNames) ? a.addedNames : []
  const lines = Array.isArray(a.addedLines) ? a.addedLines : []
  for (let i = 0; i < names.length; i++) {
    const tool = names[i]
    const server = typeof tool === 'string' ? mcpServerOfTool(tool) : null
    if (!server) continue
    const line = lines[i]
    mcpEntry(sinks, server).tools.set(
      tool,
      estTokens(typeof line === 'string' ? line.length : tool.length),
    )
  }
}

/** Fold one of the three attachments that say what a session's prefix carries. */
function foldSinkAttachment(a: SinkAttachment | undefined, sinks: SinkScan): void {
  if (!a || typeof a !== 'object') return
  if (a.type === 'skill_listing') {
    readSkillListing(a, sinks)
  } else if (a.type === 'mcp_instructions_delta') {
    foldMcpInstructions(a, sinks)
  } else if (a.type === 'deferred_tools_delta') {
    foldDeferredTools(a, sinks)
  }
}

/** `<command-name>/name</command-name>`, which is how a typed slash command lands in a transcript. */
const COMMAND_NAME = /<command-name>\/?([\w:.-]+)<\/command-name>/g

/**
 * Fold a line that carries sink evidence rather than a tool call. Returns true when the line was an
 * attachment (nothing else in the scan wants it), false when the caller should keep looking at it.
 */
export function foldSinkLine(line: string, sinks: SinkScan): boolean {
  if (
    line.includes('"attachment"') &&
    (line.includes('"skill_listing"') ||
      line.includes('"mcp_instructions_delta"') ||
      line.includes('"deferred_tools_delta"'))
  ) {
    try {
      foldSinkAttachment((JSON.parse(line) as { attachment?: SinkAttachment }).attachment, sinks)
    } catch {
      // a partial trailing write
    }
    return true
  }
  // A typed /skill is a use too. Only on a person's own turn: the same markup quoted inside a tool
  // result (a transcript being grepped) is not an invocation.
  if (
    line.includes('<command-name>') &&
    line.includes('"type":"user"') &&
    !line.includes('"tool_result"')
  ) {
    for (const m of line.matchAll(COMMAND_NAME)) {
      const name = m[1]
      if (name) sinks.skillUses[name] = (sinks.skillUses[name] ?? 0) + 1
    }
  }
  return false
}

export function storedSinks(s: SinkScan): StoredSinks {
  const mcpLoad: Record<string, number> = {}
  for (const [server, e] of s.mcp) {
    let tools = 0
    for (const n of e.tools.values()) tools += n
    mcpLoad[server] = e.instr + tools
  }
  return {
    listings: [...s.listings.keys()],
    skillUses: s.skillUses,
    mcpLoad,
    deepCalls: s.deepCalls,
    deepWeighted: s.deepWeighted,
    deepExcess: s.deepExcess,
    subWeighted: s.subWeighted,
  }
}
