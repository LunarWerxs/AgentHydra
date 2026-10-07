// devservers/mcp.ts against a fake Desk (a fetch function: no network): what each tool asks Desk and what it tells the
// chat. The point of the tools is the reuse message ("Already running at ... use it") against the start one, and the
// "on its way" words for one still starting, so a chat never starts a second copy; another project's server is
// reached only by its full id; and a Desk that is not running, or an answer that is not Desk's, is said plainly.

import { expect, test } from 'bun:test'
import type { DevWebEnsure, DevWebProcess, DevWebServers } from '@shared/devwebui'
import { createDevServersMcp } from '../../src/devservers/mcp'

const CWD = 'C:/Users/me/site'

const proc = (over: Partial<DevWebProcess>): DevWebProcess => ({
  id: 'p1.web',
  localId: 'web',
  name: 'Web',
  command: 'bun run dev',
  cwd: CWD,
  enabled: true,
  port: 4173,
  status: 'stopped',
  owner: null,
  pid: null,
  startedAt: null,
  restarts: 0,
  exitCode: null,
  conflict: null,
  projectId: 'p1',
  projectName: 'Site',
  ...over
})

const web = proc({ status: 'running', owner: 'outside', pid: 77 })
const api = proc({ id: 'p1.api', localId: 'api', name: 'Api', port: 4300, status: 'stopped', conflict: 'port 4300 is in use by example-app (pid 9)' })
const docs = proc({ id: 'p1.docs', localId: 'docs', name: 'Docs', port: 4400, status: 'starting', owner: 'desk', pid: 66 })
const project = { id: 'p1', name: 'Site', path: `${CWD}/.devwebui`, enabled: true, processes: [web, api, docs] }
const worker = proc({ id: 'p2.worker', localId: 'worker', name: 'Worker', cwd: 'C:/Users/me/other', status: 'running', owner: 'desk', pid: 88, projectId: 'p2', projectName: 'Other' })
const other = { id: 'p2', name: 'Other', path: 'C:/Users/me/other/.devwebui', enabled: true, processes: [worker] }
const servers: DevWebServers = {
  project,
  projects: [project, other],
  others: [{ port: 5173, address: '127.0.0.1', pid: 100, process: 'node', kind: 'dev', url: 'http://localhost:5173/', title: 'Example', http: 200 }]
}

interface Call {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

/** A Desk that answers `routes` (by "METHOD path"), and records what it was asked. */
function fakeDesk(routes: Record<string, (body: any, query: URLSearchParams) => unknown>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    calls.push({ method, path: u.pathname, body, headers })
    const route = routes[`${method} ${u.pathname.replace(/^\/dw\/api/, '')}`]
    if (!route) return Response.json({ error: `no route ${method} ${u.pathname}` }, { status: 404 })
    return Response.json(route(body, u.searchParams))
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function call(mcp: ReturnType<typeof createDevServersMcp>, name: string, args: Record<string, unknown> = {}) {
  const reply = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } }
  return { text: reply.result.content[0]!.text, isError: reply.result.isError === true }
}

const make = (routes: Parameters<typeof fakeDesk>[0]) => {
  const desk = fakeDesk(routes)
  return { desk, mcp: createDevServersMcp({ deskUrl: 'http://desk.test', defaultCwd: CWD, fetchImpl: desk.fetchImpl }) }
}

test('dev_server_start says "already running, use it" for a copy that runs, and "started" for one it began', async () => {
  let reused = true
  const { desk, mcp } = make({
    'POST /ensure': (body) =>
      ({ ok: true, reused, process: reused ? web : proc({ owner: 'desk', status: body.wait === false ? 'starting' : 'running', pid: 55 }), url: 'http://localhost:4173', project }) satisfies DevWebEnsure
  })
  const first = await call(mcp, 'dev_server_start', { server: 'web' })
  expect(first).toEqual({ text: 'Already running at http://localhost:4173 (started by outside AgentHydra, pid 77); use it.', isError: false })

  reused = false
  const second = await call(mcp, 'dev_server_start')
  expect(second).toEqual({ text: 'Started Web at http://localhost:4173.', isError: false })

  // The folder is the chat's by default, a given one wins, and nothing a browser would send goes with it.
  expect(desk.calls[0]!.body).toEqual({ cwd: CWD, server: 'web' })
  expect(desk.calls[1]!.body).toEqual({ cwd: CWD })
  // Not waited for, it is not up yet: said so, or a refused first request would read as a failed start.
  const early = await call(mcp, 'dev_server_start', { cwd: 'C:/Users/me/other', wait: false })
  expect(early.text).toStartWith('Starting Web; it will answer at http://localhost:4173 once up.')
  expect(desk.calls[2]!.body).toEqual({ cwd: 'C:/Users/me/other', wait: false })
  for (const c of desk.calls) {
    expect(c.headers.origin).toBeUndefined()
    expect(c.headers['sec-fetch-site']).toBeUndefined()
  }
})

test('dev_server_start that could not start gives the error, its last output and the servers to choose from', async () => {
  const { mcp } = make({
    'POST /ensure': () => ({ ok: false, error: 'port 4300 is in use by example-app (pid 9)', logTail: ['listening...', 'EADDRINUSE'], choices: ['Web', 'Api'] }) satisfies DevWebEnsure
  })
  const r = await call(mcp, 'dev_server_start', { server: 'api' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('port 4300 is in use by example-app (pid 9)')
  expect(r.text).toContain('EADDRINUSE')
  expect(r.text).toContain('Web, Api')
})

test('a Desk that does not answer is said to be not running', async () => {
  const mcp = createDevServersMcp({
    deskUrl: 'http://desk.test',
    defaultCwd: CWD,
    fetchImpl: (async () => {
      throw new Error('Unable to connect')
    }) as unknown as typeof fetch
  })
  for (const [tool, args] of [['dev_servers', {}], ['dev_server_start', {}], ['dev_server_stop', { server: 'web' }], ['dev_server_logs', { server: 'web' }]] as const) {
    const r = await call(mcp, tool, args)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/AgentHydra is not running/)
  }
})

test('dev_servers lists the folder\'s servers with who runs them, a conflict, and the other dev servers', async () => {
  const { desk, mcp } = make({ 'GET /servers': () => servers })
  const r = await call(mcp, 'dev_servers')
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Web (id web): running at http://localhost:4173, started by outside AgentHydra, pid 77')
  expect(r.text).toContain('Api (id api): stopped; port 4300 is in use by example-app (pid 9)')
  expect(r.text).toContain('Docs (id docs): starting, will answer at http://localhost:4400, started by AgentHydra; do not start another')
  expect(r.text).toContain('port 5173: node (pid 100)')
  expect(r.text).toContain('http://localhost:5173/')
  expect(desk.calls[0]!.path).toBe('/dw/api/servers')
})

test('dev_server_stop finds the server by name, id or local id, and stops that one', async () => {
  const stopped: string[] = []
  const { mcp } = make({
    'GET /servers': () => servers,
    'POST /processes/p1.web/stop': () => {
      stopped.push('p1.web')
      return { ok: true, process: web, coStopped: ['p1.api'] }
    }
  })
  for (const ref of ['Web', 'web', 'p1.web', 'WEB']) {
    const r = await call(mcp, 'dev_server_stop', { server: ref })
    expect(r.text).toBe('Stopped Web (and 1 started with it).')
  }
  expect(stopped).toHaveLength(4)

  const none = await call(mcp, 'dev_server_stop', { server: 'nothing-like-it' })
  expect(none.isError).toBe(true)
  expect(none.text).toContain('Web, Api')
  expect(stopped).toHaveLength(4)
})

test("another project's server is reached only by its full id, never by a name the folder does not have", async () => {
  const stopped: string[] = []
  const { mcp } = make({
    'GET /servers': () => servers,
    'POST /processes/p2.worker/stop': () => {
      stopped.push('p2.worker')
      return { ok: true, process: worker, coStopped: [] }
    }
  })
  const byName = await call(mcp, 'dev_server_stop', { server: 'worker' })
  expect(byName.isError).toBe(true)
  expect(byName.text).toContain('full id')
  expect(stopped).toEqual([])
  expect((await call(mcp, 'dev_server_stop', { server: 'p2.worker' })).text).toBe('Stopped Worker.')
  expect(stopped).toEqual(['p2.worker'])
})

test('a relative folder is refused before Desk is asked, and an answer that is not JSON is said plainly', async () => {
  const { desk, mcp } = make({ 'POST /ensure': () => '<html>another program</html>' })
  const rel = await call(mcp, 'dev_servers', { cwd: 'site' })
  expect(rel.isError).toBe(true)
  expect(rel.text).toContain('absolute folder')
  expect(desk.calls).toHaveLength(0)

  const odd = await call(mcp, 'dev_server_start')
  expect(odd.isError).toBe(true)
  expect(odd.text).toContain('not a dev-servers answer')
})

test('dev_server_logs gives the last 60 lines by default, marks stderr, and is capped', async () => {
  const lines = Array.from({ length: 700 }, (_, i) => ({ stream: i === 699 ? 'stderr' : 'stdout', line: `line ${i}`, ts: i }))
  const { mcp } = make({ 'GET /servers': () => servers, 'GET /processes/p1.web/logs': () => ({ id: 'p1.web', lines }) })
  const def = (await call(mcp, 'dev_server_logs', { server: 'web' })).text.split('\n')
  expect(def).toHaveLength(60)
  expect(def[0]).toBe('line 640')
  expect(def.at(-1)).toBe('[stderr] line 699')
  expect((await call(mcp, 'dev_server_logs', { server: 'web', lines: 10 })).text.split('\n')).toHaveLength(10)
  expect((await call(mcp, 'dev_server_logs', { server: 'web', lines: 9999 })).text.split('\n')).toHaveLength(500)
})

test('the tools are listed, and an unknown one is an error', async () => {
  const { mcp } = make({})
  const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
  expect(list.result.tools.map((t) => t.name)).toEqual([
    'dev_servers', 'dev_server_start', 'dev_server_stop', 'dev_server_logs',
    'dev_server_restart', 'dev_servers_scan', 'dev_servers_found', 'dev_project_add', 'dev_project_remove',
    'dev_server_config', 'dev_server_add', 'dev_server_update', 'dev_server_remove', 'dev_server_star',
    'dev_server_autostart', 'dev_servers_start_all', 'dev_servers_stop_all', 'dev_server_log_history',
    'dev_server_errors', 'dev_server_errors_clear', 'dev_server_error_dismiss', 'dev_server_free_port',
    'dev_server_alerts', 'dev_server_alert_add', 'dev_server_alert_remove', 'dev_server_alert_events_clear'
  ])
  const bad = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })) as { error: { code: number } }
  expect(bad.error.code).toBe(-32602)
})
