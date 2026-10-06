// Desk's own small stdio MCP server for dev servers (connectors/defs/devwebui.ts starts it with Desk's bun for every
// chat). Four tools, so a chat uses the dev server that already runs instead of starting a second copy beside it:
//
//   dev_servers      { cwd?, all? }                 the folder's project and servers, and the other dev servers on this PC
//   dev_server_start { server?, cwd?, wait? }       the address of the copy already running, or start it and wait for it
//   dev_server_stop  { server, cwd? }                stop one (only when asked)
//   dev_server_logs  { server, cwd?, lines? }        the last lines it printed
//
// It calls Desk (AGENTHYDRA_DESK_URL, loopback) at /dw/api, which goes on to the dev-servers service. It sends no
// Origin or Sec-Fetch header, so Desk takes it for a local client and not a page. `cwd` defaults to DEVSERVERS_CWD,
// the chat's folder. No dependency on @modelcontextprotocol/sdk: newline-delimited JSON-RPC 2.0 over stdio, written
// by hand like connectors/redesign-mcp.ts, whose stdio loop it shares.

import { type DevWebEnsure, type DevWebLogLine, type DevWebProcess, type DevWebProject, type DevWebServers, type LocalServer, processAddress } from '@shared/devwebui'
import { serveStdio } from '../connectors/redesign-mcp'

export interface DevServersMcpOptions {
  /** Desk's loopback address. */
  deskUrl: string
  /** The chat's folder: the default `cwd` of every tool. */
  defaultCwd?: string
  fetchImpl?: typeof fetch
}

interface RpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })

const CWD = { type: 'string', description: "The folder whose dev servers to use (absolute path). Default: this chat's folder." }

const TOOLS = [
  {
    name: 'dev_servers',
    description:
      "Lists this folder's dev servers (name, status, who runs it, address, any port conflict) and the other dev servers running on this PC. Look here before starting one: it may already run, started by another chat or person.",
    inputSchema: {
      type: 'object',
      properties: { cwd: CWD, all: { type: 'boolean', description: "true: every project's servers on this PC, not only this folder's." } },
      additionalProperties: false
    }
  },
  {
    name: 'dev_server_start',
    description:
      "Runs or opens a dev server (vite, next, `bun run dev`, `npm run dev`, a preview). Answers with the address of the copy that already runs, whoever started it, or starts it and waits until it answers. Use this instead of starting a dev server from the shell: a second copy fights the first for its port.",
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: "Which server: its name or id from dev_servers. Default: the folder's main one." },
        cwd: CWD,
        wait: { type: 'boolean', description: 'Wait until it answers on its port (default true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'dev_server_stop',
    description: 'Stops a dev server and the servers started with it. Only when the person asked: other chats may be using it.',
    inputSchema: { type: 'object', properties: { server: { type: 'string', description: 'Its name or id from dev_servers.' }, cwd: CWD }, required: ['server'], additionalProperties: false }
  },
  {
    name: 'dev_server_logs',
    description: 'The last lines a dev server printed (stdout and stderr). A server started outside AgentHydra has none here.',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Its name or id from dev_servers.' }, cwd: CWD, lines: { type: 'number', description: 'How many lines (default 60, at most 500).' } },
      required: ['server'],
      additionalProperties: false
    }
  }
]

/** Who runs a server that is up, in a few words. */
function runBy(p: Pick<DevWebProcess, 'owner' | 'pid'>): string {
  if (p.owner === 'outside') return `outside AgentHydra${p.pid ? `, pid ${p.pid}` : ''}`
  return 'AgentHydra'
}

function describe(p: DevWebProcess): string {
  const address = processAddress(p)
  const head = `- ${p.name} (id ${p.localId}): ${p.status}`
  if (p.status === 'running') return `${head} at ${address ?? 'no address'}, started by ${runBy(p)}`
  // On its way up: a chat must wait for it, not start another.
  if (p.status === 'starting' || p.status === 'waiting') return `${head}${address ? `, will answer at ${address}` : ''}, started by ${runBy(p)}; do not start another`
  if (p.conflict) return `${head}; ${p.conflict}`
  return address ? `${head} (would run at ${address})` : head
}

/** An absolute folder: a drive or share path, or `/x` off Windows (where it is relative to the current drive). */
const absolute = (p: string): boolean => /^([a-zA-Z]:[\\/]|\\\\)/.test(p) || (process.platform !== 'win32' && p.startsWith('/'))

function describeOther(s: LocalServer): string {
  return `- port ${s.port}: ${s.process ?? 'unknown program'} (pid ${s.pid})${s.title ? `, "${s.title}"` : ''}, ${s.url}`
}

export function createDevServersMcp(o: DevServersMcpOptions) {
  const doFetch = o.fetchImpl ?? fetch
  const base = o.deskUrl.replace(/\/+$/, '')

  /** One call to Desk; a Desk that does not answer is said plainly. */
  async function desk(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response
    try {
      res = await doFetch(`${base}/dw/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) } })
    } catch {
      throw new Error('AgentHydra is not running (nothing answers on its address), so there is no dev-server manager to ask. Start AgentHydra and try again.')
    }
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // floor-ok: a non-JSON answer is shown as text
    }
    return { status: res.status, body }
  }
  const errorOf = (r: { status: number; body: unknown }): string => {
    const e = (r.body as { error?: unknown } | null)?.error
    return typeof e === 'string' ? e : `AgentHydra answered ${r.status}`
  }
  /** A 200 whose body is no JSON object is not a dev-servers answer (another program on Desk's port, an old Desk). */
  const answerOf = <T>(r: { status: number; body: unknown }): T => {
    if (r.status !== 200) throw new Error(errorOf(r))
    if (!r.body || typeof r.body !== 'object') throw new Error(`AgentHydra answered ${r.status} with something that is not a dev-servers answer; is AgentHydra 2.0 the program on ${base}?`)
    return r.body as T
  }

  const cwdOf = (args: Record<string, unknown>): string | null => {
    const v = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : o.defaultCwd?.trim()
    if (!v) return null
    if (!absolute(v)) throw new Error(`cwd must be an absolute folder (for example C:/Users/me/app), not "${v}".`)
    return v
  }

  async function listing(cwd: string | null, all: boolean): Promise<DevWebServers> {
    const q = new URLSearchParams()
    if (cwd) q.set('cwd', cwd)
    if (all) q.set('all', '1')
    return answerOf<DevWebServers>(await desk(`/servers?${q}`))
  }

  /**
   * The server `ref` names: its id, local id or name (any case) among the folder's; in another project only by its full
   * id, so a name that is not the folder's never stops or reads another project's server by chance.
   */
  async function resolve(ref: string, cwd: string | null): Promise<DevWebProcess | string> {
    const found = await listing(cwd, true)
    const want = ref.trim().toLowerCase()
    const matches = (ps: DevWebProcess[]) => ps.filter((p) => p.id.toLowerCase() === want || p.localId.toLowerCase() === want || p.name.toLowerCase() === want)
    const own = matches(found.project?.processes ?? [])
    const hits = own.length ? own : found.projects.flatMap((p: DevWebProject) => p.processes).filter((p) => p.id.toLowerCase() === want)
    if (hits.length === 1) return hits[0]!
    const choices = (found.project?.processes ?? []).map((p) => p.name)
    if (hits.length > 1) return `More than one server is called "${ref}": ${hits.map((p) => `${p.name} (${p.id})`).join(', ')}. Use the id.`
    return `No dev server "${ref}"${choices.length ? ` here. This folder's servers: ${choices.join(', ')}` : ' here'}. Another project's server is named by its full id (dev_servers with all: true lists them).`
  }

  async function devServers(args: Record<string, unknown>): Promise<ToolResult> {
    const cwd = cwdOf(args)
    const all = args.all === true
    if (!cwd && !all) return fail('dev_servers needs cwd (an absolute folder) or all: true.')
    const found = await listing(cwd, all)
    const lines: string[] = []
    if (all) {
      for (const p of found.projects) lines.push(`${p.name} (${p.path}):`, ...(p.processes.length ? p.processes.map(describe) : ['- no servers']))
    } else if (found.project) {
      lines.push(`${found.project.name} (${found.project.path}):`, ...found.project.processes.map(describe))
    } else {
      lines.push(`No dev servers are set up for ${cwd}. dev_server_start sets them up from what the folder has (.claude/launch.json or a dev script in package.json).`)
    }
    lines.push('', found.others.length ? 'Other dev servers on this PC (not part of a project):' : 'No other dev servers are running on this PC.', ...found.others.map(describeOther))
    return ok(lines.join('\n'))
  }

  async function devServerStart(args: Record<string, unknown>): Promise<ToolResult> {
    const cwd = cwdOf(args)
    if (!cwd) return fail('dev_server_start needs cwd (an absolute folder).')
    const server = typeof args.server === 'string' && args.server.trim() !== '' ? args.server : undefined
    const e = answerOf<DevWebEnsure>(await desk('/ensure', { method: 'POST', body: JSON.stringify({ cwd, server, wait: typeof args.wait === 'boolean' ? args.wait : undefined }) }))
    if (!e.ok) {
      const lines = [e.error]
      if (e.logTail?.length) lines.push('', 'Its last output:', ...e.logTail)
      if (e.choices?.length) lines.push('', `Servers here: ${e.choices.join(', ')}. Pass one as server.`)
      return fail(lines.join('\n'))
    }
    const name = e.process.name
    if (e.reused) return ok(`Already running at ${e.url ?? 'no address (it has no port)'} (started by ${runBy(e.process)}); use it.`)
    // wait: false answers before it is up: say so, or a refused first request reads as a failed start.
    if (e.process.status !== 'running') return ok(`Starting ${name}${e.url ? `; it will answer at ${e.url} once up` : ''}. dev_servers or dev_server_logs show how it goes; do not start another copy.`)
    return ok(e.url ? `Started ${name} at ${e.url}.` : `Started ${name} (it has no port or address to open).`)
  }

  async function devServerStop(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.server !== 'string' || args.server.trim() === '') return fail('dev_server_stop needs server (a name or id from dev_servers).')
    const p = await resolve(args.server, cwdOf(args))
    if (typeof p === 'string') return fail(p)
    const also = answerOf<{ coStopped?: string[] }>(await desk(`/processes/${encodeURIComponent(p.id)}/stop`, { method: 'POST', body: '{}' })).coStopped ?? []
    return ok(`Stopped ${p.name}${also.length ? ` (and ${also.length} started with it)` : ''}.`)
  }

  async function devServerLogs(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.server !== 'string' || args.server.trim() === '') return fail('dev_server_logs needs server (a name or id from dev_servers).')
    const p = await resolve(args.server, cwdOf(args))
    if (typeof p === 'string') return fail(p)
    const body = answerOf<{ lines?: DevWebLogLine[] }>(await desk(`/processes/${encodeURIComponent(p.id)}/logs`))
    const n = Math.min(500, Math.max(1, Math.round(Number(args.lines)) || 60))
    const lines = (body.lines ?? []).slice(-n)
    return ok(lines.length ? lines.map((l) => (l.stream === 'stderr' ? `[stderr] ${l.line}` : l.line)).join('\n') : `${p.name} has printed nothing.`)
  }

  /** One JSON-RPC message in; the reply to send, or null for a notification. */
  async function handle(msg: RpcMessage): Promise<unknown | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
    if (msg.id === undefined || msg.id === null) return null
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'devservers', version: '1.0.0' }
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = msg.params?.name
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        try {
          if (name === 'dev_servers') return reply(await devServers(args))
          if (name === 'dev_server_start') return reply(await devServerStart(args))
          if (name === 'dev_server_stop') return reply(await devServerStop(args))
          if (name === 'dev_server_logs') return reply(await devServerLogs(args))
          return error(-32602, `unknown tool ${String(name)}`)
        } catch (err) {
          return reply(fail(err instanceof Error ? err.message : String(err)))
        }
      }
      default:
        return error(-32601, `method not found: ${String(msg.method)}`)
    }
  }

  return { handle }
}

if (import.meta.main) {
  const deskUrl = process.env.AGENTHYDRA_DESK_URL?.trim() || `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`
  await serveStdio(createDevServersMcp({ deskUrl, defaultCwd: process.env.DEVSERVERS_CWD?.trim() || undefined }))
}
