// The Connections connector and chip over an HTTP entry: one shared local server, with a headersHelper command run per
// chat. A fake HTTP MCP server (JSON and SSE answers, an MCP session id, a 401 on demand) and a fake helper script
// stand in for the real ones. Header values are never asserted, only which names arrived and what the server derived
// from them (the folder and session of the chat).

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONNECTIONS_SWITCH, CONNECTIONS_WORKSPACE } from '@shared/connectors'
import { createServer, type DeskServer } from '../../src/index'
import defFactory from '../../src/connectors/defs/connections'
import { ConnectionsClient, jsonAnswer } from '../../src/connectors/connections-client'
import { sseMessage } from '../../src/connectors/connections-http'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '56-connections.ts')
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = { home: process.env.HYDRA_DESK_HOME, cfg: process.env.HYDRA_DESK_MAIN_CLAUDE_JSON }

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['HYDRA_DESK_HOME', saved.home], ['HYDRA_DESK_MAIN_CLAUDE_JSON', saved.cfg]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const COMPANIES = [
  { companyId: 'c1', projectId: 'p1', name: 'Acme Example' },
  { companyId: 'c2', name: 'Globex Example' }
]

interface Fake {
  url: string
  /** Every tools/call: the tool, its params, the folder and session the server derived from the headers. */
  calls: { tool: string; params: Record<string, unknown>; folder: string; session: string | null; headerNames: string[] }[]
  /** How many times the helper ran, and the env names it saw. */
  helperRuns: () => number
  /** The next tools/call answers 401 once. */
  rejectNext: () => void
  /** Folder → company bound in the fake server. */
  folders: Record<string, (typeof COMPANIES)[number]>
  config: (extra?: object) => string
  stop: () => void
}

function fakeServer(): Fake {
  const dir = temp('desk-cxh-')
  const counter = join(dir, 'helper-runs.txt')
  const helper = join(dir, 'helper.mjs')
  // What Claude Code gives the helper: the env. It prints headers; the token is a made-up value.
  writeFileSync(
    helper,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(counter)}, [process.env.CLAUDE_CODE_MCP_SERVER_NAME, process.env.CLAUDE_CODE_MCP_SERVER_URL ? 'url' : '', process.env.CLAUDECODE].join(',') + '\\n')
const h = { 'X-Fake-Workspace': encodeURIComponent(process.env.CLAUDE_PROJECT_DIR || process.cwd()), 'X-Fake-Token': 'made-up-token' }
if (process.env.CLAUDE_CODE_SESSION_ID) h['X-Fake-Session'] = process.env.CLAUDE_CODE_SESSION_ID
process.stdout.write(JSON.stringify(h))
`
  )
  const pins: Record<string, (typeof COMPANIES)[number] | undefined> = {}
  const folders: Fake['folders'] = {}
  const calls: Fake['calls'] = []
  let reject = false
  const mcpSessions = new Set<string>()
  const tools: Record<string, (p: Record<string, unknown>, folder: string, session: string | null) => string> = {
    connections_whoami: (_p, folder, session) =>
      JSON.stringify({ identity: { signedIn: true }, company: folders[folder] ?? null, ...(session && pins[session] ? { chatPin: pins[session] } : {}) }),
    connections_list_companies: () => JSON.stringify({ companies: COMPANIES }),
    connections_use_workspace: (p, _f, session) => {
      if (session) pins[session] = p.clear ? undefined : COMPANIES.find((c) => c.companyId === p.company)
      return 'ok'
    },
    connections_switch_workspace: (p, folder) => {
      const c = COMPANIES.find((x) => x.companyId === p.company)
      if (c) folders[folder] = c
      return 'ok'
    }
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/health') return Response.json({ connectionsLocal: true, ready: true, version: '9.9.9' })
      if (u.pathname !== '/mcp') return new Response('no', { status: 404 })
      if (req.method === 'DELETE') return new Response(null, { status: 200 })
      if (req.headers.get('x-fake-token') !== 'made-up-token') return new Response('no', { status: 401 })
      const msg = (await req.json()) as { id?: number; method: string; params?: { arguments?: { tool_name: string; params?: Record<string, unknown> } } }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (msg.method === 'initialize') {
        const sid = `mcp-${mcpSessions.size + 1}`
        mcpSessions.add(sid)
        // answered as an SSE stream, with a keep-alive comment before the message
        const body = `: hello\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })}\n\n`
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': sid } })
      }
      if (!mcpSessions.has(req.headers.get('mcp-session-id') ?? '')) return new Response('no session', { status: 404 })
      if (reject) {
        reject = false
        return new Response('no', { status: 401 })
      }
      const a = msg.params?.arguments
      const folder = decodeURIComponent(req.headers.get('x-fake-workspace') ?? '')
      const session = req.headers.get('x-fake-session')
      calls.push({ tool: a?.tool_name ?? '', params: a?.params ?? {}, folder, session, headerNames: Array.from((req.headers as unknown as Iterable<[string, string]>), ([k]) => k).sort() })
      const text = tools[a?.tool_name ?? '']?.(a?.params ?? {}, folder, session) ?? 'unknown tool'
      return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
    }
  })
  const url = `http://127.0.0.1:${server.port}/mcp`
  const cfgFile = join(dir, 'claude.json')
  return {
    url,
    calls,
    helperRuns: () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0),
    rejectNext: () => (reject = true),
    folders,
    config: (extra = {}) => {
      writeFileSync(cfgFile, JSON.stringify({ mcpServers: { connections: { type: 'http', url, headersHelper: `"${process.execPath}" "${helper}"`, ...extra } } }))
      return cfgFile
    },
    stop: () => void server.stop(true)
  }
}

test('detect: running with the version while the shared server answers /health; absent with a reason when it does not', async () => {
  const f = fakeServer()
  stops.push(f.stop)
  process.env.HYDRA_DESK_MAIN_CLAUDE_JSON = f.config()
  const up = await defFactory({ home: temp('desk-cxh-home-') }).detect()
  expect(up).toMatchObject({ state: 'running', url: f.url, version: '9.9.9' })
  f.stop()
  const down = await defFactory({ home: temp('desk-cxh-home-') }).detect()
  expect(down.state).toBe('absent')
  expect(down.reason).toContain('not running')
  process.env.HYDRA_DESK_MAIN_CLAUDE_JSON = join(temp('desk-cxh-none-'), 'missing.json')
  expect((await defFactory({ home: temp('desk-cxh-home-') }).detect()).reason).toContain('not set up')
})

test("a call runs the helper in the chat's folder with its session, speaks MCP over HTTP (SSE initialize, JSON call) and reuses the headers", async () => {
  const f = fakeServer()
  stops.push(f.stop)
  const client = new ConnectionsClient(f.config())
  stops.push(() => client.closeAll())
  const folder = temp('desk-cxh-proj-')
  f.folders[folder] = COMPANIES[0]
  expect(client.available()).toBe(true)
  const who = jsonAnswer(await client.call({ cwd: folder, sessionId: 'sess-1' }, 'connections_whoami'))
  expect(who).toMatchObject({ identity: { signedIn: true }, company: { name: 'Acme Example' } })
  expect(f.calls[0]).toMatchObject({ tool: 'connections_whoami', folder, session: 'sess-1' })
  expect(f.calls[0].headerNames).toContain('x-fake-token')
  expect(f.calls[0].headerNames).toContain('mcp-session-id')
  await client.call({ cwd: folder, sessionId: 'sess-1' }, 'connections_whoami')
  expect(f.helperRuns()).toBe(1)
  // another chat in the same folder is its own helper run and its own session
  await client.call({ cwd: folder, sessionId: null }, 'connections_whoami')
  expect(f.helperRuns()).toBe(2)
  expect(f.calls[2].session).toBeNull()
})

test('a 401 re-runs the helper once and the call goes through', async () => {
  const f = fakeServer()
  stops.push(f.stop)
  const client = new ConnectionsClient(f.config())
  stops.push(() => client.closeAll())
  const folder = temp('desk-cxh-proj-')
  await client.call({ cwd: folder, sessionId: 's' }, 'connections_whoami')
  expect(f.helperRuns()).toBe(1)
  f.rejectNext()
  expect(jsonAnswer(await client.call({ cwd: folder, sessionId: 's' }, 'connections_whoami'))?.identity).toEqual({ signedIn: true })
  expect(f.helperRuns()).toBe(2)
})

test('a helper that fails, or a server that is down, is a readable error naming no header', async () => {
  const f = fakeServer()
  const bad = JSON.parse(readFileSync(f.config(), 'utf8'))
  bad.mcpServers.connections.headersHelper = `"${process.execPath}" -e "process.exit(3)"`
  const file = join(temp('desk-cxh-bad-'), 'claude.json')
  writeFileSync(file, JSON.stringify(bad))
  const client = new ConnectionsClient(file)
  await expect(client.call({ cwd: temp('desk-cxh-proj-'), sessionId: null }, 'connections_whoami')).rejects.toThrow(/headers helper failed/)
  f.stop()
  const down = new ConnectionsClient(f.config())
  await expect(down.call({ cwd: temp('desk-cxh-proj-'), sessionId: null }, 'connections_whoami')).rejects.toThrow(/did not answer/)
})

test('the SSE reader finds the answer with the asked id among other events', () => {
  const body = `: ping\n\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\nid: 2\r\ndata: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{"ok":true}}\r\n\r\n`
  expect(sseMessage(body, 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  expect(sseMessage(body, 8)).toBeNull()
})

test("the chip's routes work over HTTP: the folder's workspace, then switching this chat alone and the whole folder", async () => {
  const f = fakeServer()
  stops.push(f.stop)
  const folder = temp('desk-cxh-proj-')
  f.folders[folder] = COMPANIES[0]
  const plugins = temp('desk-cxh-plugins-')
  writeFileSync(join(plugins, '56-connections.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  writeFileSync(join(plugins, '20-chats.ts'), `export default (app) => app.get('/api/chats/:id', (c) => c.json({ cwd: ${JSON.stringify(folder)}, sessionId: c.req.param('id') === 'a' ? 'sess-a' : null }))\n`)
  const home = temp('desk-cxh-home-')
  process.env.HYDRA_DESK_HOME = home
  const desk: DeskServer = await createServer({ port: 0, home, pluginsDir: plugins, deps: { mainClaudeJson: f.config() } })
  stops.push(() => desk.stop())
  const get = async (path: string) => (await fetch(`${desk.url}${path}`)).json() as Promise<Record<string, unknown>>
  const post = async (body: object) => {
    const res = await fetch(`${desk.url}${CONNECTIONS_SWITCH}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  expect(await get(`${CONNECTIONS_WORKSPACE}?chat=a`)).toMatchObject({ signedIn: true, company: { name: 'Acme Example' }, scope: 'folder' })
  expect((await post({ chat: 'a', company: 'c2', scope: 'chat' })).body).toMatchObject({ company: { name: 'Globex Example' }, scope: 'chat' })
  expect(f.calls.find((c) => c.tool === 'connections_use_workspace')).toMatchObject({ folder, session: 'sess-a', params: { company: 'c2' } })
  expect((await post({ chat: 'a', company: null, scope: 'chat' })).body.scope).toBe('folder')
  // a chat with no session cannot be pinned, but the whole folder can be switched
  expect((await post({ chat: 'b', company: 'c2', scope: 'chat' })).status).toBe(409)
  expect((await post({ chat: 'b', company: 'c2', scope: 'folder' })).body).toMatchObject({ company: { name: 'Globex Example' }, scope: 'folder' })
  expect(f.folders[folder].name).toBe('Globex Example')
})
