// The MCP server list (GET /api/mcp-servers) and a live chat's MCP status and toggle
// (GET /api/chats/:id/mcp, POST /api/chats/:id/mcp/:name). The list reads temp config files only and
// must never carry a server's command, args, env, url, headers or tokens.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpServerConfig, McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, McpServerInfo, McpStatus } from '@shared/protocol'
import { createServer, type DeskServer } from '../../../src/index'
import { ChatError, ChatManager } from '../../../src/engine/chat-manager'
import { listMcpServers, MCP_SERVERS_MAX } from '../../../src/engine/mcp-servers'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'src', 'plugins', '20-engine.ts')

const SECRETS = ['sk-secret-token-123', 'hdr-secret-456', 'secret.example.com', 'C:/secret/bin/server.exe', 'arg-secret-000', 'ENV_SECRET_VALUE']
const CONFIG_WORDS = ['command', 'args', 'env', 'url', 'headers', 'token']

const AGENT_HYDRA: McpServerConfig = { command: 'C:/secret/bin/server.exe', args: ['--api-key=arg-secret-000'], env: { AH_TOKEN: 'sk-secret-token-123' } }

const temps: string[] = []
const servers: DeskServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function boot(o: { agentHydraMcp: McpServerConfig | null; home?: string }) {
  const home = o.home ?? temp('desk-mcp-home-')
  const plugins = temp('desk-mcp-plugins-')
  writeFileSync(join(plugins, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const desk = await createServer({
    port: 0,
    home,
    pluginsDir: plugins,
    deps: { newChats: 'sdk', queryImpl: q.queryImpl, bridge: fakeBridge().bridge, agentHydraMcp: o.agentHydraMcp, env: { PATH: '/bin' }, storeDebounceMs: 1, claudeHome: home },
  })
  servers.push(desk)
  return { desk, home, ...q }
}

async function call<T = any>(desk: DeskServer, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await fetch(desk.url + path, init)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as T }
}

/** An account config dir whose .claude.json has user servers (and a local-scope one under projects). */
function accountDir(cwd: string): string {
  const dir = temp('desk-mcp-account-')
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { accessToken: 'sk-secret-token-123' },
      mcpServers: {
        codegraph: { command: 'C:/secret/bin/server.exe', args: ['--api-key=arg-secret-000'], env: { TOKEN: 'sk-secret-token-123' } },
        remote: { type: 'http', url: 'https://secret.example.com/mcp', headers: { Authorization: 'Bearer hdr-secret-456' } },
        shared: { type: 'sse', url: 'https://secret.example.com/sse' },
        agenthydra: { command: 'node', env: { K: 'ENV_SECRET_VALUE' } },
        socket: { type: 'ws', url: 'wss://secret.example.com/ws' },
        broken: 'not a config',
      },
      projects: { [cwd]: { mcpServers: { localonly: { command: 'C:/secret/bin/server.exe' } } } },
    }),
  )
  return dir
}

function projectDir(): string {
  const cwd = temp('desk-mcp-cwd-')
  writeFileSync(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        shared: { command: 'npx', args: ['--token', 'arg-secret-000'], env: { K: 'ENV_SECRET_VALUE' } },
        docs: { type: 'http', url: 'https://secret.example.com/docs', headers: { 'x-api-key': 'hdr-secret-456' } },
      },
    }),
  )
  return cwd
}

const listPath = (cwd: string, configDir?: string) => `/api/mcp-servers?cwd=${encodeURIComponent(cwd)}${configDir ? `&configDir=${encodeURIComponent(configDir)}` : ''}`

describe('GET /api/mcp-servers', () => {
  test('lists user, project, local and Hydra Desk servers by name, scope and transport, and nothing of their config', async () => {
    const t = await boot({ agentHydraMcp: AGENT_HYDRA })
    const cwd = projectDir()
    const res = await call<McpServerInfo[]>(t.desk, 'GET', listPath(cwd, accountDir(cwd)))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { name: 'codegraph', scope: 'user', transport: 'stdio' },
      { name: 'remote', scope: 'user', transport: 'http' },
      { name: 'shared', scope: 'project', transport: 'stdio' },
      { name: 'docs', scope: 'project', transport: 'http' },
      { name: 'localonly', scope: 'local', transport: 'stdio' },
      { name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' },
    ])
    for (const s of res.body) expect(Object.keys(s).sort()).toEqual(['name', 'scope', 'transport'])
    for (const secret of SECRETS) expect(res.text).not.toContain(secret)
    for (const word of CONFIG_WORDS) expect(res.text.toLowerCase()).not.toContain(word)
  })

  test('missing or malformed config files give an empty list', async () => {
    const t = await boot({ agentHydraMcp: null })
    const missing = await call<McpServerInfo[]>(t.desk, 'GET', listPath(temp('desk-mcp-cwd-'), temp('desk-mcp-account-')))
    expect(missing).toMatchObject({ status: 200, body: [] })

    const cwd = temp('desk-mcp-cwd-')
    writeFileSync(join(cwd, '.mcp.json'), '{"mcpServers": {"half": ')
    const account = temp('desk-mcp-account-')
    writeFileSync(join(account, '.claude.json'), JSON.stringify({ mcpServers: ['codegraph'] }))
    const malformed = await call<McpServerInfo[]>(t.desk, 'GET', listPath(cwd, account))
    expect(malformed).toMatchObject({ status: 200, body: [] })
  })

  test('refuses a relative cwd or configDir', async () => {
    const t = await boot({ agentHydraMcp: null })
    expect((await call(t.desk, 'GET', '/api/mcp-servers?cwd=not/absolute')).status).toBe(400)
    expect((await call(t.desk, 'GET', '/api/mcp-servers')).status).toBe(400)
    expect((await call(t.desk, 'GET', listPath(temp('desk-mcp-cwd-'), 'relative/dir'))).status).toBe(400)
  })

  test('refuses a network or device path before reading anything there', async () => {
    const t = await boot({ agentHydraMcp: null })
    for (const p of ['\\\\evil-host\\share', '//evil-host/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) {
      expect((await call(t.desk, 'GET', listPath(p))).status).toBe(400)
      expect((await call(t.desk, 'GET', listPath(temp('desk-mcp-cwd-'), p))).status).toBe(400)
    }
    // absolute on every platform, so the refusal is the network one
    expect((await call(t.desk, 'GET', listPath('//evil-host/share'))).body.error).toMatch(/network or device path/)
    expect((await call(t.desk, 'GET', listPath(temp('desk-mcp-cwd-'), '//evil-host/share'))).body.error).toMatch(/configDir must be a folder on this machine/)
  })
})

describe('listMcpServers', () => {
  test('caps the list', () => {
    const account = temp('desk-mcp-account-')
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`s${i}`, { command: 'x' }]))
    writeFileSync(join(account, '.claude.json'), JSON.stringify({ mcpServers: many }))
    const list = listMcpServers({ cwd: temp('desk-mcp-cwd-'), configDir: account, agentHydraMcp: null })
    expect(list).toHaveLength(MCP_SERVERS_MAX)
    expect(list[0]).toEqual({ name: 's0', scope: 'user', transport: 'stdio' })
  })

  test('local-scope servers are found under the folder whatever its slashes, trailing slash and (on Windows) case', () => {
    const cwd = temp('desk-mcp-cwd-')
    const key = `${cwd.replace(/\\/g, '/')}/`
    const account = temp('desk-mcp-account-')
    writeFileSync(
      join(account, '.claude.json'),
      JSON.stringify({
        mcpServers: { db: { command: 'x' } },
        projects: {
          [process.platform === 'win32' ? key.toUpperCase() : key]: { mcpServers: { db: { type: 'http', url: 'https://secret.example.com' }, mine: { command: 'x' } } },
          [join(cwd, 'other')]: { mcpServers: { elsewhere: { command: 'x' } } },
        },
      }),
    )
    expect(listMcpServers({ cwd, configDir: account, agentHydraMcp: null })).toEqual([
      { name: 'db', scope: 'local', transport: 'http' },
      { name: 'mine', scope: 'local', transport: 'stdio' },
    ])
  })

  test('without an account config dir it reads .claude.json in the home it is given', () => {
    const home = temp('desk-mcp-userhome-')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { zswarm: { type: 'sse', url: 'https://secret.example.com' } } }))
    expect(listMcpServers({ cwd: temp('desk-mcp-cwd-'), configDir: null, agentHydraMcp: null, home })).toEqual([
      { name: 'zswarm', scope: 'user', transport: 'sse' },
    ])
  })
})

describe('a chat\'s MCP status and toggle', () => {
  test('a live chat reports name and status only, and toggles through the SDK', async () => {
    const t = await boot({ agentHydraMcp: null })
    const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-mcp-cwd-'), prompt: 'go' })
    const fake = t.last()
    fake.mcp = [
      { name: 'codegraph', status: 'connected', config: { type: 'stdio', command: 'C:/secret/bin/server.exe', args: ['arg-secret-000'], env: { T: 'sk-secret-token-123' } } },
      { name: 'remote', status: 'failed', error: 'boom', config: { type: 'http', url: 'https://secret.example.com/mcp' } },
    ]

    const status = await call<McpStatus>(t.desk, 'GET', `/api/chats/${chat.id}/mcp`)
    expect(status.body).toEqual({
      live: true,
      servers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'remote', status: 'failed' },
      ],
    })
    for (const secret of SECRETS) expect(status.text).not.toContain(secret)

    const off = await call(t.desk, 'POST', `/api/chats/${chat.id}/mcp/codegraph`, { enabled: false })
    expect(off).toMatchObject({ status: 200, body: { ok: true } })
    expect(fake.calls.toggleMcpServer).toEqual([['codegraph', false]])
    expect((await call(t.desk, 'POST', `/api/chats/${chat.id}/mcp/codegraph`, { enabled: 'no' })).status).toBe(400)
    expect((await call(t.desk, 'GET', '/api/chats/nope/mcp')).status).toBe(404)
  })

  test('a chat without a live session is not live and refuses a toggle', async () => {
    const first = await boot({ agentHydraMcp: null })
    const { body: chat } = await call<ChatSummary>(first.desk, 'POST', '/api/chats', { cwd: temp('desk-mcp-cwd-'), prompt: 'go' })
    await servers.splice(servers.indexOf(first.desk), 1)[0]!.stop()

    const second = await boot({ agentHydraMcp: null, home: first.home })
    expect((await call<McpStatus>(second.desk, 'GET', `/api/chats/${chat.id}/mcp`)).body).toEqual({ live: false, servers: [] })
    expect((await call(second.desk, 'POST', `/api/chats/${chat.id}/mcp/codegraph`, { enabled: true })).status).toBe(409)
  })

  test('a session that does not answer in time: the status is not live (not "nothing loaded"), and a toggle says it timed out', async () => {
    const home = temp('desk-mcp-home-')
    process.env.HYDRA_DESK_HOME = home
    const q = fakeQueries()
    const m = new ChatManager({
      home,
      claudeHome: home,
      emit: () => {},
      settings: () => DEFAULT_SETTINGS,
      bridge: fakeBridge().bridge,
      queryImpl: q.queryImpl,
      agentHydraMcp: null,
      env: { PATH: '/bin' },
      storeDebounceMs: 1,
      liveListTimeoutMs: 30,
      newChats: 'sdk',
    })
    try {
      const chat = await m.create({ cwd: temp('desk-mcp-cwd-'), prompt: 'go' })
      q.last().mcp = [{ name: 'codegraph', status: 'connected' } as McpServerStatus]
      q.last().mcpHangs = true
      expect(await m.mcpStatus(chat.id)).toEqual({ live: false, servers: [] })
      const err = await m.toggleMcp(chat.id, 'codegraph', false).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ChatError)
      expect(err).toMatchObject({ status: 502, message: 'could not turn codegraph off: the session did not answer within 0.03s' })
    } finally {
      await m.closeAll()
    }
  })
})
