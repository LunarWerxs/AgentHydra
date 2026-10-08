// Desk's own small stdio MCP server for dev servers (connectors/defs/devwebui.ts starts it with Desk's bun for every
// chat). Its main four tools make a chat use the dev server that already runs instead of starting a second copy:
//
//   dev_servers      { cwd?, all? }                 the folder's project and servers, and the other dev servers on this PC
//   dev_server_start { server?, cwd?, wait? }       the address of the copy already running, or start it and wait for it
//   dev_server_stop  { server, cwd? }                stop one (only when asked)
//   dev_server_logs  { server, cwd?, lines? }        the last lines it printed
//
// The rest (extraTools) reach DevWebUI's other routes (DW_ROUTES): scan, found, projects, entries, errors, alerts.
//
// It calls Desk (AGENTHYDRA_DESK_URL, loopback) at /dw/api, which goes on to the dev-servers service. It sends no
// Origin or Sec-Fetch header, so Desk takes it for a local client and not a page. `cwd` defaults to DEVSERVERS_CWD,
// the chat's folder. No dependency on @modelcontextprotocol/sdk: newline-delimited JSON-RPC 2.0 over stdio, written
// by hand like connectors/redesign-mcp.ts, whose stdio loop it shares.

import { type DevWebAddResult, type DevWebEnsure, type DevWebFound, type DevWebLogLine, type DevWebProcess, type DevWebProject, type DevWebServers, DW_ROUTES, type LocalServer, processAddress } from '@shared/devwebui'
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
  },
  ...extraTools()
]

/** The tools beyond the first four; each answers the service's JSON as it is. */
function extraTools() {
  const SERVER = { type: 'string', description: 'Its name or id from dev_servers.' }
  const PROJECT = { type: 'string', description: 'The project: its id or name from dev_servers with all: true.' }
  const ON = { type: 'boolean', description: 'true turns it on, false off.' }
  const SPEC = { type: 'object', description: 'The server entry as a .devwebui writes it: id, name, command, and optional cwd, port, url, env, runtime, autostart, links, waitForPort, companion.' }
  const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }
  })
  return [
    tool('dev_server_restart', 'Restarts a dev server. Only when the person asked: other chats may be using it.', { server: SERVER, cwd: CWD }, ['server']),
    tool('dev_servers_scan', 'Scans the disk for projects with dev servers; the results join the found list.', {
      preset: { type: 'string', enum: ['quick', 'deep'], description: 'quick (default) looks in the usual folders, deep looks further.' },
      roots: { type: 'array', items: { type: 'string' }, description: 'Absolute folders to scan instead.' }
    }),
    tool('dev_servers_found', 'What scans found that is not added yet.'),
    tool('dev_project_add', 'Adds a project from a folder or .devwebui file. A folder without one answers a proposal; call again with accept: true to write it.', {
      path: { type: 'string', description: 'Absolute folder or .devwebui file.' },
      accept: { type: 'boolean', description: 'Write the proposed .devwebui.' }
    }, ['path']),
    tool('dev_project_remove', 'Forgets a project and stops what AgentHydra runs of it. Its .devwebui file is kept.', { project: PROJECT }, ['project']),
    tool('dev_server_config', "A server's entry as written in its .devwebui.", { server: SERVER, cwd: CWD }, ['server']),
    tool('dev_server_add', "Adds a server to a project's .devwebui.", { project: PROJECT, spec: SPEC }, ['project', 'spec']),
    tool('dev_server_update', "Rewrites a server's .devwebui entry (a changed id renames it).", { server: SERVER, spec: SPEC, cwd: CWD }, ['server', 'spec']),
    tool('dev_server_remove', "Removes a server's entry from its .devwebui, stopping it first if AgentHydra runs it.", { server: SERVER, cwd: CWD }, ['server']),
    tool('dev_server_star', 'Stars or unstars a server.', { server: SERVER, on: ON, cwd: CWD }, ['server', 'on']),
    tool('dev_server_autostart', "Turns a server's autostart on or off. Starts or stops nothing.", { server: SERVER, on: ON, cwd: CWD }, ['server', 'on']),
    tool('dev_servers_start_all', 'Starts every enabled server of every enabled project. Only when the person asked.'),
    tool('dev_servers_stop_all', 'Stops every dev server that is up, whoever started it. Only when the person asked.'),
    tool('dev_server_log_history', "Pages back through a server's saved log.", {
      server: SERVER,
      cwd: CWD,
      before: { type: 'number', description: 'Lines before this seq (from an earlier page). Default: the newest.' },
      limit: { type: 'number', description: 'How many lines.' }
    }, ['server']),
    tool('dev_server_errors', 'Errors servers printed, newest first: one server or all.', { server: { ...SERVER, description: 'Its name or id. Default: every server.' }, cwd: CWD }),
    tool('dev_server_errors_clear', 'Clears the errors of one server or all.', { server: { ...SERVER, description: 'Its name or id. Default: every server.' }, cwd: CWD }),
    tool('dev_server_error_dismiss', 'Dismisses one error.', { fingerprint: { type: 'string', description: 'The fingerprint from dev_server_errors.' } }, ['fingerprint']),
    tool('dev_server_free_port', "Frees a server's port. When programs AgentHydra did not start hold it, pass their pids to end them; omit pids to see the list first and confirm.", { server: SERVER, cwd: CWD, pids: { type: 'array', items: { type: 'number' }, description: 'The pids of external programs to end (from a previous needsConfirm answer).' } }, ['server']),
    tool('dev_server_alerts', 'Alert rules and the alerts that fired.'),
    tool('dev_server_alert_add', 'Adds an alert: a server staying over a CPU or memory threshold for a time.', {
      server: SERVER,
      cwd: CWD,
      metric: { type: 'string', enum: ['cpu', 'memory'] },
      threshold: { type: 'number', description: 'cpu: percent of one core; memory: bytes.' },
      forMs: { type: 'number', description: 'How long it must stay over, in ms.' },
      enabled: { type: 'boolean' }
    }, ['server', 'metric', 'threshold', 'forMs']),
    tool('dev_server_alert_remove', 'Removes an alert rule.', { id: { type: 'string', description: 'The rule id from dev_server_alerts.' } }, ['id']),
    tool('dev_server_alert_events_clear', 'Clears the alerts that fired.')
  ]
}

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

  /** One service route through Desk; the answer goes back to the chat as JSON. */
  async function route(path: string, method = 'GET', body?: unknown): Promise<ToolResult> {
    const init: RequestInit = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    return ok(JSON.stringify(answerOf<unknown>(await desk(`/${path}`, init)), null, 2))
  }

  /** The id of the server args.server names; a name that names none or several is thrown as the reason. */
  async function serverId(args: Record<string, unknown>, tool: string): Promise<string> {
    if (typeof args.server !== 'string' || args.server.trim() === '') throw new Error(`${tool} needs server (a name or id from dev_servers).`)
    const p = await resolve(args.server, cwdOf(args))
    if (typeof p === 'string') throw new Error(p)
    return p.id
  }

  async function projectId(args: Record<string, unknown>, tool: string): Promise<string> {
    const want = typeof args.project === 'string' ? args.project.trim().toLowerCase() : ''
    if (!want) throw new Error(`${tool} needs project (an id or name from dev_servers with all: true).`)
    const hits = (await listing(null, true)).projects.filter((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want)
    if (hits.length === 1) return hits[0]!.id
    throw new Error(hits.length ? `More than one project is called "${args.project}": ${hits.map((p) => p.id).join(', ')}. Use the id.` : `No project "${args.project}".`)
  }

  async function projectAdd(args: Record<string, unknown>): Promise<ToolResult> {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!absolute(path)) return fail('dev_project_add needs path (an absolute folder or .devwebui file).')
    const r = answerOf<DevWebAddResult>(await desk(`/projects/load`, { method: 'POST', body: JSON.stringify({ path }) }))
    if (!r.needsScaffold) return ok(JSON.stringify(r, null, 2))
    if (args.accept !== true) return ok(`${path} has no .devwebui. This would be written:\n${JSON.stringify(r.proposal, null, 2)}\nCall again with accept: true to write it.`)
    return route('projects/scaffold', 'POST', { dir: r.dir, fileName: r.fileName, project: r.proposal })
  }

  /** The tools after the first four, by name. */
  async function extra(name: string, a: Record<string, unknown>): Promise<ToolResult | null> {
    return (await serverExtra(name, a)) ?? (await listExtra(name, a)) ?? errorExtra(name, a)
  }

  /** The `before` and `limit` of a log history call, when they are numbers. */
  function historyQuery(a: Record<string, unknown>): URLSearchParams {
    const q = new URLSearchParams()
    if (Number.isFinite(Number(a.before)) && a.before !== undefined) q.set('before', String(Math.round(Number(a.before))))
    if (Number.isFinite(Number(a.limit)) && a.limit !== undefined) q.set('limit', String(Math.round(Number(a.limit))))
    return q
  }

  /** The tools that act on one server (args.server). */
  async function serverExtra(name: string, a: Record<string, unknown>): Promise<ToolResult | null> {
    const sid = () => serverId(a, name)
    switch (name) {
      case 'dev_server_restart':
        return route(`processes/${encodeURIComponent(await sid())}/restart`, 'POST', {})
      case 'dev_server_config':
        return route(DW_ROUTES.processConfig(await sid()))
      case 'dev_server_update':
        return route(DW_ROUTES.process(await sid()), 'PUT', { spec: a.spec })
      case 'dev_server_remove':
        return route(DW_ROUTES.process(await sid()), 'DELETE')
      case 'dev_server_star':
        return route(DW_ROUTES.processStarred(await sid()), 'POST', { on: a.on === true })
      case 'dev_server_autostart':
        return route(DW_ROUTES.processEnabled(await sid()), 'POST', { on: a.on === true })
      case 'dev_server_log_history':
        return route(`${DW_ROUTES.processLogs(await sid())}?${historyQuery(a)}`)
      case 'dev_server_free_port':
        return route(DW_ROUTES.freePort(await sid()), 'POST', Array.isArray(a.pids) ? { pids: a.pids } : {})
      case 'dev_server_alert_add':
        return route(DW_ROUTES.alerts, 'POST', {
          processId: await sid(),
          metric: a.metric,
          threshold: a.threshold,
          forMs: a.forMs,
          ...(typeof a.enabled === 'boolean' ? { enabled: a.enabled } : {})
        })
      default:
        return null
    }
  }

  /** The tools on the project list, the found list and every server at once. */
  async function listExtra(name: string, a: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'dev_servers_scan':
        return route(DW_ROUTES.scan, 'POST', { preset: a.preset === 'deep' ? 'deep' : 'quick', ...(Array.isArray(a.roots) ? { roots: a.roots } : {}) })
      case 'dev_servers_found': {
        // Each found row carries its company for the sidebar's grouping; a chat has the path, so the hundreds of
        // repeated company objects stay out of its context.
        const body = answerOf<DevWebFound>(await desk(`/${DW_ROUTES.found}`))
        return ok(JSON.stringify({ ...body, items: (body.items ?? []).map(({ company: _company, ...item }) => item) }, null, 2))
      }
      case 'dev_project_add':
        return projectAdd(a)
      case 'dev_project_remove':
        return route(DW_ROUTES.project(await projectId(a, name)), 'DELETE')
      case 'dev_server_add':
        return route(DW_ROUTES.projectProcesses(await projectId(a, name)), 'POST', { spec: a.spec })
      case 'dev_servers_start_all':
        return route(DW_ROUTES.startAll, 'POST', {})
      case 'dev_servers_stop_all':
        return route(DW_ROUTES.stopAll, 'POST', {})
      default:
        return null
    }
  }

  /** The errors panel and the alert rules. */
  async function errorExtra(name: string, a: Record<string, unknown>): Promise<ToolResult | null> {
    const optionalSid = async () => (typeof a.server === 'string' && a.server.trim() !== '' ? serverId(a, name) : undefined)
    switch (name) {
      case 'dev_server_errors': {
        const id = await optionalSid()
        return route(`${DW_ROUTES.errors}${id ? `?process=${encodeURIComponent(id)}` : ''}`)
      }
      case 'dev_server_errors_clear': {
        const id = await optionalSid()
        return route(DW_ROUTES.clearErrors, 'POST', id ? { process: id } : {})
      }
      case 'dev_server_error_dismiss':
        if (typeof a.fingerprint !== 'string' || !a.fingerprint) return fail('dev_server_error_dismiss needs fingerprint.')
        return route(DW_ROUTES.dismissError, 'POST', { fingerprint: a.fingerprint })
      case 'dev_server_alerts':
        return route(DW_ROUTES.alerts)
      case 'dev_server_alert_remove':
        if (typeof a.id !== 'string' || !a.id) return fail('dev_server_alert_remove needs id.')
        return route(DW_ROUTES.alert(a.id), 'DELETE')
      case 'dev_server_alert_events_clear':
        return route(DW_ROUTES.clearAlertEvents, 'POST', {})
      default:
        return null
    }
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
        try {
          const result = await callTool(String(name), (msg.params?.arguments ?? {}) as Record<string, unknown>)
          return result ? reply(result) : error(-32602, `unknown tool ${String(name)}`)
        } catch (err) {
          return reply(fail(err instanceof Error ? err.message : String(err)))
        }
      }
      default:
        return error(-32601, `method not found: ${String(msg.method)}`)
    }
  }

  /** A tool's answer, or null for a tool by no such name. */
  async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    if (name === 'dev_servers') return devServers(args)
    if (name === 'dev_server_start') return devServerStart(args)
    if (name === 'dev_server_stop') return devServerStop(args)
    if (name === 'dev_server_logs') return devServerLogs(args)
    return extra(name, args)
  }

  return { handle }
}

if (import.meta.main) {
  const deskUrl = process.env.AGENTHYDRA_DESK_URL?.trim() || `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`
  await serveStdio(createDevServersMcp({ deskUrl, defaultCwd: process.env.DEVSERVERS_CWD?.trim() || undefined }))
}
