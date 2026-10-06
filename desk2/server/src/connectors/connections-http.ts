// The HTTP half of Desk's Connections client: one shared local Connections server (an `http` entry in the main
// Claude config, with an optional `headersHelper` command) instead of one stdio child per chat. A call is made the
// way Claude Code makes it for a chat: the helper command runs in the chat's folder with CLAUDE_PROJECT_DIR (and
// CLAUDE_CODE_SESSION_ID when the chat has one) in its environment and prints a JSON object, which becomes the
// request headers; then MCP Streamable HTTP is spoken to the url (initialize, notifications/initialized,
// tools/call), keeping the Mcp-Session-Id the server returns and reading either a JSON or an SSE answer.
//
// Header VALUES may carry a credential: they are never logged, thrown in a message or returned. Errors name the
// header count at most.

import { spawn } from 'node:child_process'

export const HTTP_IDLE_MS = 5 * 60_000
export const HELPER_TIMEOUT_MS = 10_000
export const HEALTH_TIMEOUT_MS = 1_500
const CALL_TIMEOUT_MS = 25_000
const PROTOCOL = '2025-03-26'

export interface HttpServerConfig {
  url: string
  /** The shell command whose stdout is a JSON object of request headers, or null. */
  headersHelper: string | null
  /** Static headers of the config entry. */
  headers: Record<string, string>
}

export class HttpMcpError extends Error {
  constructor(
    message: string,
    public status: number | null = null
  ) {
    super(message)
  }
}

const strings = (o: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
  return out
}

/** The `http` entry's fields from a parsed config entry, or null when it is not one. */
export function httpConfig(s: Record<string, unknown>): HttpServerConfig | null {
  if (s.type !== 'http' || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) return null
  return { url: s.url, headersHelper: typeof s.headersHelper === 'string' && s.headersHelper.trim() ? s.headersHelper : null, headers: strings(s.headers) }
}

/** Runs the headersHelper as Claude Code does, for one chat; resolves its JSON object's string values. */
export function runHeadersHelper(cfg: HttpServerConfig, cwd: string, sessionId: string | null): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    if (!cfg.headersHelper) return resolve({ ...cfg.headers })
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: '1',
      CLAUDE_PROJECT_DIR: cwd,
      CLAUDE_CODE_MCP_SERVER_NAME: 'connections',
      CLAUDE_CODE_MCP_SERVER_URL: cfg.url
    }
    if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId
    else delete env.CLAUDE_CODE_SESSION_ID
    let out = ''
    const child = spawn(cfg.headersHelper, { shell: true, cwd, env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill()
      reject(new HttpMcpError('the Connections headers helper did not finish in time'))
    }, HELPER_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      reject(new HttpMcpError('the Connections headers helper could not start'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new HttpMcpError(`the Connections headers helper failed (exit ${code}): the shared server may not be running`))
      try {
        const parsed = JSON.parse(out.trim())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        resolve({ ...cfg.headers, ...strings(parsed) })
      } catch {
        reject(new HttpMcpError('the Connections headers helper did not print a JSON object'))
      }
    })
  })
}

/** The server's address for its /health: the url's origin. */
export const healthUrl = (url: string): string => `${new URL(url).origin}/health`

export type HttpProbe = { up: true; version: string | null } | { up: false; why: string }

/** Does the shared server answer? Its /health says `connectionsLocal: true` and a version. Never throws. */
export async function probeHttp(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HttpProbe> {
  try {
    const res = await fetch(healthUrl(url), { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => null)) as { connectionsLocal?: unknown; version?: unknown } | null
    if (!res.ok || body?.connectionsLocal !== true) return { up: false, why: `${new URL(url).host} answers, but not as the Connections server` }
    return { up: true, version: typeof body.version === 'string' && body.version ? body.version : null }
  } catch {
    return { up: false, why: `the shared Connections server is not running at ${new URL(url).host}` }
  }
}

/** The JSON-RPC message with `id` from an SSE body (events separated by blank lines, `data:` lines joined). */
export function sseMessage(text: string, id: number): unknown {
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const m = JSON.parse(data) as { id?: unknown }
      if (m.id === id) return m
    } catch {
      // floor-ok: a keep-alive or partial event is not the answer
    }
  }
  return null
}

/** One chat's conversation with the shared server: its headers, its MCP session, one call at a time. */
export class HttpSession {
  private headers: Record<string, string> | null = null
  private mcpSession: string | null = null
  private nextId = 1
  private chain: Promise<unknown> = Promise.resolve()
  lastUsed = Date.now()

  constructor(
    private cfg: HttpServerConfig,
    private cwd: string,
    private sessionId: string | null
  ) {}

  private async post(body: object, wantId: number | null): Promise<unknown> {
    const headers: Record<string, string> = { ...(this.headers ?? {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.mcpSession) {
      headers['mcp-session-id'] = this.mcpSession
      headers['mcp-protocol-version'] = PROTOCOL
    }
    let res: Response
    try {
      res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
    } catch {
      throw new HttpMcpError(`the Connections server did not answer at ${new URL(this.cfg.url).host}`)
    }
    if (res.status === 401 || res.status === 404) throw new HttpMcpError('the Connections server refused the session', res.status)
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.mcpSession = sid
    if (wantId === null) return null
    if (!res.ok) throw new HttpMcpError(`the Connections server answered ${res.status}`, res.status)
    const text = await res.text()
    const msg = ((res.headers.get('content-type') ?? '').includes('text/event-stream') ? sseMessage(text, wantId) : JSON.parse(text)) as {
      result?: unknown
      error?: { message?: string }
    } | null
    if (!msg) throw new HttpMcpError('the Connections server sent no answer')
    if (msg.error) throw new HttpMcpError(msg.error.message ?? 'the Connections server refused the call')
    return msg.result
  }

  private async start(): Promise<void> {
    this.headers = await runHeadersHelper(this.cfg, this.cwd, this.sessionId)
    this.mcpSession = null
    const id = this.nextId++
    await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'hydra-desk-2', version: '1' } } }, id)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, null)
  }

  private async attempt(tool: string, params: object): Promise<string> {
    if (!this.headers) await this.start()
    const id = this.nextId++
    const res = (await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'connections_execute', arguments: { local: true, tool_name: tool, params } } }, id)) as {
      content?: { type?: string; text?: unknown }[]
    }
    return (res?.content ?? []).map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n')
  }

  /** Runs one local Connections tool and returns its text answer; a 401 (or a lost MCP session) re-runs the helper once. */
  call(tool: string, params: object = {}): Promise<string> {
    const run = async (): Promise<string> => {
      this.lastUsed = Date.now()
      try {
        return await this.attempt(tool, params)
      } catch (err) {
        if (!(err instanceof HttpMcpError) || (err.status !== 401 && err.status !== 404)) throw err
        this.headers = null
        return await this.attempt(tool, params)
      } finally {
        this.lastUsed = Date.now()
      }
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  /** Ends the MCP session on the server, best effort. */
  async close(): Promise<void> {
    if (!this.mcpSession || !this.headers) return
    try {
      await fetch(this.cfg.url, { method: 'DELETE', headers: { ...this.headers, 'mcp-session-id': this.mcpSession }, signal: AbortSignal.timeout(2000) })
    } catch {
      // floor-ok: the server is gone or already forgot the session
    }
    this.mcpSession = null
  }
}
