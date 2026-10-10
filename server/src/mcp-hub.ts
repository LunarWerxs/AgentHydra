// The owner's stdio MCP servers, served once for the whole PC instead of once per Claude session.
// Each stdio entry in ~/.claude.json started its own child in every session (2026-10-09: 52 quickdictate.exe and
// 52 paramount-games copies). The daemon now owns ONE child per entry and answers every client at
// POST /api/mcp/shared/<name>, stateless like /api/mcp. The original entry is kept in CONFIG_DIR/shared-mcp.json,
// so the hub can spawn it and turning the setting off restores it exactly.
//
// A stateless POST has no open stream, so the child's notifications and its requests to the client are not relayed:
// a child request is refused at once so the child does not wait for an answer.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CONFIG_DIR } from './config'
import { canonicalConfigDir, listCliInstances } from './core/cli-instances'
import { getSetting } from './db'
import {
  claudeCodeConfigPath,
  readConfig,
  registrationBarred,
  writeConfigAtomic,
} from './mcp-register'

type Json = Record<string, unknown>
type Proc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>

export const SHARED_PATH = '/api/mcp/shared'
export const MCP_SHARE_SETTING = 'mcp_share_stdio'
const STORE_PATH = join(CONFIG_DIR, 'shared-mcp.json')
const PROTOCOL_VERSION = '2025-06-18'
const RESTART_WINDOW_MS = 60_000
const MAX_STARTS_PER_WINDOW = 5
const SHARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HUB_URL = /^https?:\/\/[^/]+\/api\/mcp\/shared\/([A-Za-z0-9._-]+)$/
const SECRET_ARG = /token|secret|passw|api[-_]?key|credential|auth/i
const STDIO_KEYS = new Set(['type', 'command', 'args', 'env'])

export interface StdioSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

const errorReply = (id: unknown, code: number, message: string): Json => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The spawn spec of a stdio entry the hub may serve, or null. Anything that could carry a credential (headers,
 *  a helper, a non-empty env value, a secret-looking argument, an unknown field) stays in the account's own config. */
export function shareableSpec(entry: unknown): StdioSpec | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Json
  if (Object.keys(e).some((k) => !STDIO_KEYS.has(k))) return null
  if ((e.type ?? 'stdio') !== 'stdio' || typeof e.command !== 'string' || !e.command) return null
  const args = e.args ?? []
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return null
  if (args.some((a) => SECRET_ARG.test(a))) return null
  const env = e.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env)) return null
  const values = Object.entries(env as Json)
  if (values.some(([, v]) => typeof v !== 'string' || v !== '')) return null
  return {
    command: e.command,
    args: args as string[],
    env: Object.fromEntries(values) as Record<string, string>,
  }
}

export function sharedUrl(daemonUrl: string, name: string): string {
  return `${daemonUrl.replace(/\/+$/, '')}${SHARED_PATH}/${name}`
}

/** The name a hub URL serves, when the entry is one (any port), else null. */
function hubNameOf(entry: unknown): string | null {
  const e = entry as Json | null
  if (!e || typeof e !== 'object' || e.type !== 'http' || typeof e.url !== 'string') return null
  return HUB_URL.exec(e.url)?.[1] ?? null
}

/** One shared server: one child process, many clients. Requests are remapped to child ids the hub owns, so two
 *  clients' id 1 never collide; initialize is run once and its result answered to every client. */
export class SharedServer {
  private proc: Proc | null = null
  private ready: Promise<void> | null = null
  private initResult: unknown = undefined
  private nextId = 1
  private readonly pending = new Map<number, (reply: Json) => void>()
  private starts: number[] = []

  constructor(
    readonly name: string,
    private readonly spec: StdioSpec,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** A client's JSON-RPC message: its reply, or null for a notification (which the child never needs). */
  async handle(msg: Json): Promise<Json | null> {
    if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return null
    try {
      await this.ensure()
    } catch (err) {
      return errorReply(msg.id, -32603, errorText(err))
    }
    if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: this.initResult }
    return { ...(await this.request(msg.method, msg.params)), id: msg.id }
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    this.ready = null
    proc?.kill()
    this.fail(`${this.name} was stopped`)
  }

  private ensure(): Promise<void> {
    const dead = this.proc?.exitCode
    if (this.proc && dead !== null && dead !== undefined) this.exited(this.proc, dead)
    this.ready ??= this.start().catch((err) => {
      this.stop()
      throw err
    })
    return this.ready
  }

  private async start(): Promise<void> {
    const now = Date.now()
    this.starts = this.starts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.starts.length >= MAX_STARTS_PER_WINDOW)
      throw new Error(`${this.name} keeps exiting, so it is not started again for a minute`)
    this.starts.push(now)
    const proc = Bun.spawn([this.spec.command, ...this.spec.args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      env: { ...process.env, ...this.spec.env } as Record<string, string>,
    })
    this.proc = proc
    void this.readLines(proc)
    this.discardStderr(proc)
    void proc.exited.then((code) => this.exited(proc, code))
    const reply = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agenthydra-hub', version: '1' },
    })
    if (!('result' in reply))
      throw new Error(`${this.name} did not answer initialize: ${JSON.stringify(reply.error)}`)
    this.initResult = reply.result
    this.write(proc, { jsonrpc: '2.0', method: 'notifications/initialized' })
    this.log(`[mcp-hub] ${this.name} started (pid ${proc.pid})`)
  }

  private request(method: string, params: unknown): Promise<Json> {
    const proc = this.proc
    if (!proc) return Promise.resolve(errorReply(null, -32603, `${this.name} is not running`))
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      try {
        this.write(proc, { jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        resolve(errorReply(null, -32603, errorText(err)))
      }
    })
  }

  private write(proc: Proc, msg: Json): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`)
    proc.stdin.flush()
  }

  private async readLines(proc: Proc): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) this.route(proc, line)
        }
      }
    } catch (err) {
      this.log(`[mcp-hub] ${this.name} output: ${errorText(err)}`)
    }
  }

  private route(proc: Proc, line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null)
        this.write(
          proc,
          errorReply(msg.id, -32601, 'the shared MCP hub does not relay requests from a server'),
        )
      return
    }
    if (typeof msg.id !== 'number') return
    const resolve = this.pending.get(msg.id)
    if (!resolve) return
    this.pending.delete(msg.id)
    resolve(msg)
  }

  // Child diagnostics are not logged: they can quote a value the owner never meant to print.
  private discardStderr(proc: Proc): void {
    ;(proc.stderr as ReadableStream<Uint8Array>).pipeTo(new WritableStream()).catch(() => {})
  }

  private exited(proc: Proc, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = null
    this.fail(`${this.name} exited (code ${code}) before it answered`)
    this.log(`[mcp-hub] ${this.name} exited (code ${code}); the next request starts it again`)
  }

  private fail(reason: string): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const resolve of waiting) resolve(errorReply(null, -32603, reason))
  }
}

const hubs = new Map<string, SharedServer>()

process.once('exit', () => {
  for (const hub of hubs.values()) hub.stop()
})

/** The hub serving `name`, when the store holds a shareable original for it; null otherwise. */
export function sharedMcpServer(name: string, storePath = STORE_PATH): SharedServer | null {
  const spec = shareableSpec(readConfig(storePath).config?.[name])
  if (!spec) return null
  let hub = hubs.get(name)
  if (!hub) {
    hub = new SharedServer(name, spec)
    hubs.set(name, hub)
  }
  return hub
}

export function sharedMcpEnabled(): boolean {
  return getSetting(MCP_SHARE_SETTING) !== '0'
}

const stampOf = (path: string): string | null => {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

const mcpServersOf = (config: Json): Json =>
  config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? (config.mcpServers as Json)
    : {}

/** A CLI instance's entries follow the owner's originals: a hub entry follows the port (or, disabled, goes back to its
 *  original), and an entry equal to its original moves to the hub. An instance entry that differs is never touched. */
function rewriteInstanceEntries(
  servers: Json,
  originals: Json,
  enabled: boolean,
  daemonUrl: string,
): string[] {
  const changed: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (!SHARE_NAME.test(name)) continue
    const url = sharedUrl(daemonUrl, name)
    if (hubNameOf(entry) === name) {
      if (enabled && (entry as Json).url !== url) {
        servers[name] = { type: 'http', url }
        changed.push(name)
      } else if (!enabled && name in originals) {
        servers[name] = originals[name]
        changed.push(name)
      }
    } else if (enabled && name in originals && isDeepStrictEqual(entry, originals[name])) {
      servers[name] = { type: 'http', url }
      changed.push(name)
    }
  }
  return changed
}

/** Each CLI instance's own config, rewritten from the same originals. Never adds to the store; one bad file is
 *  reported and skipped, and the rest still run. */
function syncInstanceFiles(
  paths: string[],
  originals: Json,
  enabled: boolean,
  daemonUrl: string,
): { written: number; problems: string[] } {
  let written = 0
  const problems: string[] = []
  for (const path of paths) {
    try {
      const before = stampOf(path)
      if (before === null) continue
      const read = readConfig(path)
      if (!read.config) {
        problems.push(read.error ?? `${path} could not be read`)
        continue
      }
      const config = read.config
      const servers = mcpServersOf(config)
      if (!rewriteInstanceEntries(servers, originals, enabled, daemonUrl).length) continue
      if (stampOf(path) !== before) {
        problems.push(`${path} was written by another process; the next sync retries`)
        continue
      }
      config.mcpServers = servers
      writeConfigAtomic(path, config)
      written++
    } catch (err) {
      problems.push(`${path}: ${errorText(err)}`)
    }
  }
  return { written, problems }
}

/**
 * Make ~/.claude.json and each CLI instance's config agree with the setting. Enabled: each shareable stdio entry is
 * kept in the store and rewritten to the hub URL, and a hub entry whose port moved is rewritten to the new one.
 * Disabled: every hub entry goes back to its stored original, the instance files before the store forgets it. Never
 * throws; the config and the store are written in the order that cannot lose an original (store first when sharing,
 * config first when restoring).
 */
export function syncSharedMcp(opts: {
  daemonUrl: string
  enabled?: boolean
  configPath?: string
  storePath?: string
  instancePaths?: string[]
  primary?: boolean
  env?: NodeJS.ProcessEnv
}): { changed: string[]; instances: number; error: string | null } {
  const env = opts.env ?? process.env
  const enabled = opts.enabled ?? true
  const configPath = opts.configPath ?? claudeCodeConfigPath(env)
  const storePath = opts.storePath ?? STORE_PATH
  if (registrationBarred(opts.primary, env, !!opts.configPath))
    return { changed: [], instances: 0, error: null }
  try {
    const before = stampOf(configPath)
    const read = readConfig(configPath)
    if (!read.config) return { changed: [], instances: 0, error: read.error }
    const storeRead = readConfig(storePath)
    if (!storeRead.config) return { changed: [], instances: 0, error: storeRead.error }
    const config = read.config
    const servers = mcpServersOf(config)
    const store = storeRead.config
    const nextStore: Json = { ...store }
    const changed: string[] = []
    for (const [name, entry] of Object.entries(servers)) {
      if (!SHARE_NAME.test(name)) continue
      const url = sharedUrl(opts.daemonUrl, name)
      if (enabled) {
        if (hubNameOf(entry) === name) {
          if ((entry as Json).url !== url) {
            servers[name] = { type: 'http', url }
            changed.push(name)
          }
        } else if (shareableSpec(entry)) {
          nextStore[name] = entry
          servers[name] = { type: 'http', url }
          changed.push(name)
        }
      } else if (hubNameOf(entry) === name && name in nextStore) {
        servers[name] = nextStore[name]
        delete nextStore[name]
        changed.push(name)
      }
    }
    for (const name of Object.keys(nextStore)) if (!(name in servers)) delete nextStore[name]
    const storeChanged = JSON.stringify(nextStore) !== JSON.stringify(store)
    const guarded = (changed.length > 0 || storeChanged) && stampOf(configPath) !== before
    const writeStore = () => {
      if (storeChanged) writeConfigAtomic(storePath, nextStore)
    }
    const writeConfig = () => {
      if (!changed.length) return
      config.mcpServers = servers
      writeConfigAtomic(configPath, config)
    }
    if (enabled && !guarded) {
      writeStore()
      writeConfig()
    }
    const instances = syncInstanceFiles(
      opts.instancePaths ?? [],
      enabled && !guarded ? nextStore : store,
      enabled,
      opts.daemonUrl,
    )
    if (!enabled && !guarded) {
      writeConfig()
      writeStore()
      for (const [name, hub] of hubs)
        if (!(name in nextStore)) {
          hub.stop()
          hubs.delete(name)
        }
    }
    const problems = guarded
      ? [
          `${configPath} was written by another process; the next sync retries`,
          ...instances.problems,
        ]
      : instances.problems
    return {
      changed: guarded ? [] : changed,
      instances: instances.written,
      error: problems.join('; ') || null,
    }
  } catch (err) {
    return { changed: [], instances: 0, error: `shared MCP sync failed: ${errorText(err)}` }
  }
}

const cliInstancePaths = (): string[] =>
  listCliInstances().map((rec) => join(canonicalConfigDir(rec), '.claude.json'))

/** The boot and minute-timer entry point: logs only when an entry actually changed or failed. */
export function reassertSharedMcp(daemonUrl: string): void {
  const enabled = sharedMcpEnabled()
  const { changed, instances, error } = syncSharedMcp({
    daemonUrl,
    enabled,
    instancePaths: cliInstancePaths(),
  })
  if (error) console.warn(`[agenthydra] shared MCP servers: ${error}`)
  if (changed.length || instances) {
    const what = [
      changed.length ? `${changed.join(', ')} in ~/.claude.json` : '',
      instances ? `${instances} CLI instance file(s)` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    console.log(
      `[agenthydra] shared MCP servers ${what} ${enabled ? 'now served by the daemon' : 'restored to their own stdio entries'}`,
    )
  }
}
