// A small MCP stdio client for the Connections server the person already has in their main Claude config
// (`~/.claude.json` → mcpServers.connections, a node loader). The Connections chip (plugins/56-connections.ts) asks
// it who a chat acts as and moves that. The server is started the way Claude Code starts it for a chat: with
// CLAUDECODE=1, CLAUDE_PROJECT_DIR=<the chat's folder> and, when the chat has one, CLAUDE_CODE_SESSION_ID, which is
// what Connections keys a chat's own workspace pin on. One child per folder+session is kept for 60 s after its last
// call, so a chip refresh does not pay a node start each time; calls on one child run one at a time.
//
// The server's command, args and env are never logged, and neither is any answer (an answer can carry a token):
// callers read the few fields they need from it and drop the rest.

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type HttpServerConfig, HttpMcpError, HttpSession, HTTP_IDLE_MS, httpConfig } from './connections-http'

export const IDLE_MS = 60_000
/** Starting the server (node, then the handshake) may take a while on a cold disk. */
export const START_TIMEOUT_MS = 20_000
export const CALL_TIMEOUT_MS = 25_000

/** A stdio entry: one node child per chat. */
export interface ConnectionsServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export class ConnectionsError extends Error {}

/** The main Claude config to read: HYDRA_DESK_MAIN_CLAUDE_JSON (tests), else ~/.claude.json. */
export const defaultConfigFile = (): string => process.env.HYDRA_DESK_MAIN_CLAUDE_JSON || join(homedir(), '.claude.json')

const parsed = new Map<string, { mtimeMs: number; size: number; json: unknown }>()

/** The parsed config, read again only when its mtime or size changed; throws when it is missing or not JSON. */
function readConfig(file: string): unknown {
  const st = statSync(file)
  const hit = parsed.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.json
  const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
  parsed.set(file, { mtimeMs: st.mtimeMs, size: st.size, json })
  return json
}

/** The `connections` stdio server of a main Claude config, or null when it has none (or the file is unreadable). */
export function connectionsServer(file: string = defaultConfigFile()): ConnectionsServer | null {
  let json: unknown
  try {
    json = readConfig(file)
  } catch {
    return null
  }
  const servers = (json as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
  const s = servers && typeof servers === 'object' ? (servers.connections as Record<string, unknown> | undefined) : undefined
  if (!s || typeof s.command !== 'string' || (s.type !== undefined && s.type !== 'stdio')) return null
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : []
  const env: Record<string, string> = {}
  if (s.env && typeof s.env === 'object') for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') env[k] = v
  return { command: s.command, args, env }
}

/** The `connections` entry of a main Claude config, stdio or http; null when it has none (or the file is unreadable). */
export type ConnectionsEntry = ({ kind: 'stdio' } & ConnectionsServer) | ({ kind: 'http' } & HttpServerConfig)

export function connectionsEntry(file: string = defaultConfigFile()): ConnectionsEntry | null {
  const http = rawEntry(file)
  const h = http ? httpConfig(http) : null
  if (h) return { kind: 'http', ...h }
  const s = connectionsServer(file)
  return s ? { kind: 'stdio', ...s } : null
}

function rawEntry(file: string): Record<string, unknown> | null {
  try {
    const servers = (readConfig(file) as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
    const s = servers && typeof servers === 'object' ? servers.connections : undefined
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** True when the server's loader file (its first path argument) exists on this machine. */
export function loaderExists(server: ConnectionsServer): boolean {
  const loader = server.args.find((a) => /\.(m|c)?js$/.test(a))
  return loader !== undefined && existsSync(loader)
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One running Connections server and the JSON-RPC conversation with it. */
class Session {
  private child: ChildProcessByStdio<Writable, Readable, null>
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private chain: Promise<unknown> = Promise.resolve()
  private idle: ReturnType<typeof setTimeout> | null = null
  private ready: Promise<void>
  dead = false

  constructor(
    server: ConnectionsServer,
    cwd: string,
    sessionId: string | null,
    private onDead: () => void,
  ) {
    const env: Record<string, string | undefined> = { ...process.env, ...server.env, CLAUDECODE: '1', CLAUDE_PROJECT_DIR: cwd }
    if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId
    else delete env.CLAUDE_CODE_SESSION_ID
    this.child = spawn(server.command, server.args, { cwd, env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d: string) => this.read(d))
    this.child.on('error', () => this.die('the Connections server could not start'))
    this.child.on('exit', () => this.die('the Connections server stopped'))
    this.child.stdin.on('error', () => {})
    this.ready = this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hydra-desk-2', version: '1' } }, START_TIMEOUT_MS).then(() =>
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    this.ready.catch(() => this.close())
  }

  private send(msg: object): void {
    if (!this.dead) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private read(data: string): void {
    this.buf += data
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // floor-ok: a stray non-JSON line on stdout is not an answer
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (!p) continue
      this.pending.delete(msg.id as number)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new ConnectionsError(msg.error.message ?? 'the Connections server refused the call'))
      else p.resolve(msg.result)
    }
  }

  private rpc(method: string, params: object, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new ConnectionsError('the Connections server stopped'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ConnectionsError('the Connections server did not answer in time'))
        // A call that timed out leaves the conversation in an unknown state: start over next time.
        this.close()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Runs one local Connections tool and returns its text answer. */
  call(tool: string, params: object = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.idle) clearTimeout(this.idle)
      this.idle = null
      try {
        await this.ready
        const res = (await this.rpc('tools/call', { name: 'connections_execute', arguments: { local: true, tool_name: tool, params } }, timeoutMs)) as {
          content?: { type?: string; text?: unknown }[]
        }
        return (res.content ?? []).map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n')
      } finally {
        if (!this.dead) {
          this.idle = setTimeout(() => this.close(), IDLE_MS)
          this.idle.unref?.()
        }
      }
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  private die(why: string): void {
    if (this.dead) return
    this.dead = true
    if (this.idle) clearTimeout(this.idle)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new ConnectionsError(why))
    }
    this.pending.clear()
    this.onDead()
  }

  close(): void {
    if (!this.dead) {
      try {
        this.child.stdin.end()
        this.child.kill()
      } catch {
        // floor-ok: it is already gone
      }
    }
    this.die('the Connections server was closed')
  }
}

export interface CallTarget {
  /** The chat's folder (CLAUDE_PROJECT_DIR). */
  cwd: string
  /** The chat's Claude Code session id, when it has one (CLAUDE_CODE_SESSION_ID). */
  sessionId: string | null
}

/** Calls the Connections server of `file` (default: the main config). A stdio child, or an HTTP session, is kept per folder+session. */
export class ConnectionsClient {
  private sessions = new Map<string, Session>()
  private http = new Map<string, HttpSession>()

  constructor(private file: string | null = defaultConfigFile()) {}

  /** The server is set up in the config; a stdio one also has its loader on disk. (An HTTP one may be down: a call says so.) */
  available(): boolean {
    const e = this.file ? connectionsEntry(this.file) : null
    return e !== null && (e.kind === 'http' || loaderExists(e))
  }

  async call(target: CallTarget, tool: string, params: object = {}): Promise<string> {
    const entry = this.file ? connectionsEntry(this.file) : null
    if (!entry) throw new ConnectionsError('Connections is not installed on this machine')
    if (entry.kind === 'http') return this.callHttp(entry, target, tool, params)
    const server = entry
    const key = `${target.cwd}
${target.sessionId ?? ''}`
    let s = this.sessions.get(key)
    if (!s || s.dead) {
      const made: Session = new Session(server, target.cwd, target.sessionId, () => {
        if (this.sessions.get(key) === made) this.sessions.delete(key)
      })
      this.sessions.set(key, made)
      s = made
    }
    return s.call(tool, params)
  }

  private async callHttp(cfg: HttpServerConfig, target: CallTarget, tool: string, params: object): Promise<string> {
    const now = Date.now()
    for (const [k, v] of this.http) if (now - v.lastUsed > HTTP_IDLE_MS) this.http.delete(k)
    const key = `${cfg.url}
${cfg.headersHelper ?? ''}
${target.cwd}
${target.sessionId ?? ''}`
    let s = this.http.get(key)
    if (!s) {
      s = new HttpSession(cfg, target.cwd, target.sessionId)
      this.http.set(key, s)
    }
    try {
      return await s.call(tool, params)
    } catch (err) {
      if (err instanceof HttpMcpError) throw new ConnectionsError(err.message)
      throw err
    }
  }

  closeAll(): void {
    for (const s of [...this.sessions.values()]) s.close()
    this.sessions.clear()
    for (const s of this.http.values()) void s.close()
    this.http.clear()
  }
}

/** A tool answer that is a JSON object (it may carry a note after it), or null (an answer in words, such as a sign-in link, is not). */
export function jsonAnswer(text: string): Record<string, unknown> | null {
  const open = text.indexOf('{')
  for (const body of [text, open >= 0 ? text.slice(open, text.lastIndexOf('}') + 1) : '']) {
    try {
      const v = JSON.parse(body)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // floor-ok: not JSON, tried the next shape
    }
  }
  return null
}
