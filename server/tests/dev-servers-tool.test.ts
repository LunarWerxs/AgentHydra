// server/tests/dev-servers-tool.test.ts - the `dev_servers` MCP tool (server/src/dev-servers-tool.ts) against a
// stand-in AgentHydra 2.0 (Desk) on a free port (HYDRA_DESK_PORT), never the real one: a start reports the copy
// already running (whoever started it) instead of starting a second, a down Desk gets the "not running" answer,
// and stop / logs find a server by id, local id or name.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEV_SERVERS_NOT_RUNNING, devServers } from '../src/dev-servers-tool'
import { SERVER_INSTRUCTIONS, TOOLS } from '../src/mcp'

const CWD = 'C:/Users/me/app'
const proc = (localId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `pabc12345.${localId}`,
  localId,
  name,
  status: 'stopped',
  owner: null,
  conflict: null,
  ...extra,
})
const PROJECT = {
  name: 'Example app',
  processes: [
    proc('web', 'Main SPA', { port: 4173 }),
    proc('api', 'API', { port: 4200 }),
    proc('docs', 'api', { port: 4300, status: 'running', owner: 'desk' }),
  ],
}

let server: ReturnType<typeof Bun.serve>
let savedPort: string | undefined
// What the stand-in answers to POST /dw/api/ensure, and what it was sent.
let ensureAnswer: unknown
const seen: { path: string; method: string; origin: string | null; body: unknown }[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? await req.json().catch(() => null) : null
      seen.push({
        path: url.pathname + url.search,
        method: req.method,
        origin: req.headers.get('origin'),
        body,
      })
      if (url.pathname === '/dw/api/ensure') return Response.json(ensureAnswer)
      if (url.pathname === '/dw/api/servers')
        return Response.json({ project: PROJECT, projects: [PROJECT], others: [] })
      if (url.pathname.endsWith('/stop')) return Response.json({ ok: true, coStopped: [] })
      if (url.pathname.endsWith('/logs'))
        return Response.json({
          id: 'x',
          lines: Array.from({ length: 100 }, (_, i) => ({
            stream: 'stdout',
            line: `line ${i + 1}`,
            ts: i,
          })),
        })
      return Response.json({ error: 'no such route' }, { status: 404 })
    },
  })
  savedPort = process.env.HYDRA_DESK_PORT
  process.env.HYDRA_DESK_PORT = String(server.port)
})
afterAll(() => {
  if (savedPort === undefined) delete process.env.HYDRA_DESK_PORT
  else process.env.HYDRA_DESK_PORT = savedPort
  server.stop(true)
})

describe('dev_servers start', () => {
  test('a server someone else already runs is reported, not started again', async () => {
    seen.length = 0
    ensureAnswer = {
      ok: true,
      reused: true,
      process: proc('web', 'Main SPA', { port: 4173, status: 'running', owner: 'outside' }),
      url: 'http://localhost:4173',
    }
    const out = await devServers({ action: 'start', cwd: CWD, server: 'web' })
    expect(out).toBe(
      'Already running at http://localhost:4173 (started outside AgentHydra); use it.',
    )
    // Local clients send no Origin (Desk's own-page rule), and the body names the folder and server.
    expect(seen[0]).toMatchObject({
      path: '/dw/api/ensure',
      method: 'POST',
      origin: null,
      body: { cwd: CWD, server: 'web' },
    })
  })

  test('a server nobody runs is started and its address given', async () => {
    ensureAnswer = {
      ok: true,
      reused: false,
      process: proc('web', 'Main SPA', { port: 4173, status: 'running', owner: 'desk' }),
      url: 'http://localhost:4173',
    }
    expect(await devServers({ action: 'start', cwd: CWD })).toBe(
      'Started Main SPA at http://localhost:4173.',
    )
  })

  test('a refused start says why, with the choices and the log tail', async () => {
    ensureAnswer = {
      ok: false,
      error: 'port 4173 is in use by postgres (pid 9)',
      choices: ['web', 'api'],
      logTail: ['boom'],
    }
    const out = await devServers({ action: 'start', cwd: CWD })
    expect(out).toContain('port 4173 is in use by postgres (pid 9)')
    expect(out).toContain('Choose one of: web, api.')
    expect(out).toContain('boom')
  })

  test('a relative folder is refused before anything is asked', async () => {
    seen.length = 0
    expect(await devServers({ action: 'start', cwd: 'app' })).toContain('absolute folder')
    // On Windows `/work/app` is relative to the current drive.
    if (process.platform === 'win32')
      expect(await devServers({ action: 'start', cwd: '/work/app' })).toContain('absolute folder')
    expect(seen).toHaveLength(0)
  })
})

describe('dev_servers stop and logs', () => {
  test('stop finds the server by name in any case and posts to its id', async () => {
    seen.length = 0
    expect(await devServers({ action: 'stop', cwd: CWD, server: 'MAIN spa' })).toBe(
      'Stopped Main SPA.',
    )
    expect(seen.at(-1)).toMatchObject({
      path: '/dw/api/processes/pabc12345.web/stop',
      method: 'POST',
    })
  })

  test('with several servers, stop without a name stops none, not even the one that runs', async () => {
    seen.length = 0
    expect(await devServers({ action: 'stop', cwd: CWD })).toContain('Name the server')
    expect(seen.some((s) => s.path.endsWith('/stop'))).toBe(false)
  })

  test('a name two servers share is not guessed: it says which exist', async () => {
    seen.length = 0
    const out = await devServers({ action: 'stop', cwd: CWD, server: 'API' })
    expect(out).toContain('more than one server: api, docs')
    expect(seen.some((s) => s.path.endsWith('/stop'))).toBe(false)
  })

  test('an unknown server lists the ones that exist', async () => {
    const out = await devServers({ action: 'logs', cwd: CWD, server: 'nope' })
    expect(out).toContain('No server "nope"')
    expect(out).toContain('web (Main SPA)')
  })

  test('logs return the last lines asked for, default 60, never more than 500', async () => {
    const some = await devServers({ action: 'logs', cwd: CWD, server: 'web', lines: 3 })
    expect(some.split('\n')).toEqual([
      'Last 3 lines of Main SPA (stopped):',
      'line 98',
      'line 99',
      'line 100',
    ])
    const dflt = await devServers({ action: 'logs', cwd: CWD, server: 'web' })
    expect(dflt.split('\n')).toHaveLength(61)
    const max = await devServers({ action: 'logs', cwd: CWD, server: 'web', lines: 9999 })
    expect(max.split('\n')).toHaveLength(101)
  })
})

describe('dev_servers when Desk is down', () => {
  test('every action answers that AgentHydra 2.0 is not running', async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = String(dead.port)
    dead.stop(true)
    const prior = process.env.HYDRA_DESK_PORT
    process.env.HYDRA_DESK_PORT = port
    try {
      for (const action of ['list', 'start', 'stop', 'logs'])
        expect(await devServers({ action, cwd: CWD, server: 'web' })).toBe(DEV_SERVERS_NOT_RUNNING)
    } finally {
      process.env.HYDRA_DESK_PORT = prior
    }
  })
})

describe('dev_servers is advertised', () => {
  test('a MUTATES tool in the table, and the handshake tells sessions to use it before the shell', () => {
    const tool = TOOLS.find((t) => t.name === 'dev_servers')
    expect(
      tool?.description.startsWith('MUTATES: (start, stop, restart, scan, add_project) '),
    ).toBe(true)
    expect(SERVER_INSTRUCTIONS).toContain('dev_servers {action:"start", cwd}')
    expect(SERVER_INSTRUCTIONS).toContain('never start one from the shell')
  })
})
