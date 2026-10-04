// The MCP servers a chat's SDK session loads (chat-runtime buildOptions, settingSources 'user', 'project'
// and 'local'): the user-level `mcpServers` of the account's .claude.json, the folder's .mcp.json, the
// local-scope servers `claude mcp add` keeps for the folder under `projects[<folder>]` of that same
// .claude.json, and the agenthydra server Hydra Desk passes itself. Only names, scope and transport leave
// this module: a server's command, args, env, url and headers carry secrets.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerInfo } from '@shared/protocol'

export const MCP_SERVERS_MAX = 100

const TRANSPORTS = new Set<McpServerInfo['transport']>(['stdio', 'http', 'sse'])

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A JSON file's contents, or null when the file is missing or not valid JSON. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The `mcpServers` object of a parsed config, or {} when it has none. */
function serversOf(json: unknown): Record<string, unknown> {
  const servers = isObject(json) ? json.mcpServers : undefined
  return isObject(servers) ? servers : {}
}

/** A folder as .claude.json's `projects` keys it: forward slashes, no trailing one; on Windows any case. */
function folderKey(path: string): string {
  const key = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

/** The local-scope servers of `cwd` in a parsed .claude.json (`projects[<folder>].mcpServers`). */
function localServersOf(json: unknown, cwd: string): Record<string, unknown> {
  const projects = isObject(json) ? json.projects : undefined
  if (!isObject(projects)) return {}
  const want = folderKey(cwd)
  // .claude.json can hold the folder under several spellings (c:/ and C:/): all of them count.
  return Object.assign({}, ...Object.keys(projects).filter((k) => folderKey(k) === want).map((k) => serversOf(projects[k])))
}

/**
 * What plain `claude` would load in `cwd` under Jacob's main .claude.json whatever account the chat runs on:
 * its user-level servers and the folder's local-scope ones (Claude Code looks the folder up by its own key
 * only, never a parent's). A user-level name the folder's .mcp.json also defines is left to the project, as
 * Claude Code ranks project over user. A missing or unreadable file gives nothing and one log line (path only).
 */
export function mainServers(cwd: string, file: string): { user: Record<string, unknown>; local: Record<string, unknown> } {
  const json = readJson(file)
  if (json === null) {
    console.warn(`[mcp] main config ${file} missing or unreadable: its MCP servers are skipped`)
    return { user: {}, local: {} }
  }
  const project = serversOf(readJson(join(cwd, '.mcp.json')))
  const user = Object.fromEntries(Object.entries(serversOf(json)).filter(([name]) => !(name in project)))
  return { user, local: localServersOf(json, cwd) }
}

/** The servers of `mainServers` as the SDK's `mcpServers` option takes them (invalid entries dropped). */
export function mainMcpOption(cwd: string, file: string): Record<string, McpServerConfig> {
  const { user, local } = mainServers(cwd, file)
  const out: Record<string, McpServerConfig> = {}
  for (const [name, config] of Object.entries({ ...user, ...local })) if (transportOf(config)) out[name] = config as McpServerConfig
  return out
}

/** stdio when `type` is absent (the CLI's default); null for a transport the list cannot name. */
function transportOf(config: unknown): McpServerInfo['transport'] | null {
  if (!config || typeof config !== 'object') return null
  const type = (config as { type?: unknown }).type ?? 'stdio'
  return TRANSPORTS.has(type as McpServerInfo['transport']) ? (type as McpServerInfo['transport']) : null
}

/**
 * The servers a chat in `cwd` on the account at `configDir` (null = the default login) loads.
 * A name defined twice is listed once, at the scope that wins: Hydra Desk's over local over the project's
 * over the user's.
 */
export function listMcpServers(o: {
  cwd: string
  configDir: string | null
  agentHydraMcp: McpServerConfig | null
  home?: string
  mainFile?: string | null
}): McpServerInfo[] {
  const account = readJson(join(o.configDir ?? o.home ?? homedir(), '.claude.json'))
  const main = o.mainFile ? mainServers(o.cwd, o.mainFile) : { user: {}, local: {} }
  const sources: [McpServerInfo['scope'], Record<string, unknown>][] = [
    ['user', serversOf(account)],
    ['user', main.user],
    ['project', serversOf(readJson(join(o.cwd, '.mcp.json')))],
    ['local', localServersOf(account, o.cwd)],
    ['local', main.local],
    ['hydra-desk', o.agentHydraMcp ? { agenthydra: o.agentHydraMcp } : {}],
  ]
  const byName = new Map<string, McpServerInfo>()
  for (const [scope, servers] of sources) {
    for (const [name, config] of Object.entries(servers)) {
      const transport = transportOf(config)
      if (!transport) continue
      byName.delete(name)
      byName.set(name, { name, scope, transport })
    }
  }
  return [...byName.values()].slice(0, MCP_SERVERS_MAX)
}
