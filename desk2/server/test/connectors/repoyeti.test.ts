import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorStatus } from '../../../shared/connectors'
import factory from '../../src/connectors/defs/repoyeti'

const root = mkdtempSync(join(tmpdir(), 'repoyeti-conn-'))
const state = join(root, 'state')
const home = join(root, 'desk')
const savedEnv = { h: process.env.REPOYETI_HOME, e: process.env.REPOYETI_EXE, l: process.env.LOCALAPPDATA, p: process.env.ProgramFiles, path: process.env.PATH }

let health: ReturnType<typeof Bun.serve> | null = null
let body: unknown = { ok: true, service: 'repoyeti', version: '9.9.9' }

const runtime = (url: string) => {
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'runtime.json'), JSON.stringify({ port: 1, url, pid: 1 }))
}

beforeAll(() => {
  // Nothing on this machine may leak in: its own RepoYeti home, install locations and PATH are all the temp folder.
  process.env.REPOYETI_HOME = state
  delete process.env.REPOYETI_EXE
  process.env.LOCALAPPDATA = join(root, 'local')
  process.env.ProgramFiles = join(root, 'pf')
  process.env.PATH = join(root, 'empty')
  health = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => (new URL(req.url).pathname === '/api/health' ? Response.json(body) : new Response('no', { status: 404 })) })
})

afterEach(() => {
  rmSync(state, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  body = { ok: true, service: 'repoyeti', version: '9.9.9' }
})

afterAll(() => {
  health?.stop(true)
  for (const [k, v] of [['REPOYETI_HOME', savedEnv.h], ['REPOYETI_EXE', savedEnv.e], ['LOCALAPPDATA', savedEnv.l], ['ProgramFiles', savedEnv.p], ['PATH', savedEnv.path]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

const def = () => factory({ home })
const url = () => `http://127.0.0.1:${health?.port}`

describe('detect', () => {
  test('running when its runtime.json url answers health as repoyeti', async () => {
    runtime(url())
    expect(await def().detect()).toEqual({ state: 'running', url: url(), version: '9.9.9' })
  })

  test('a runtime file whose url answers as something else is not RepoYeti', async () => {
    runtime(url())
    body = { ok: true, service: 'other' }
    expect((await def().detect()).state).toBe('absent')
  })

  test('a stale runtime file with nothing answering is not running', async () => {
    runtime('http://127.0.0.1:1')
    expect((await def().detect()).state).toBe('absent')
  })

  test("installed when Desk's own installed.json names a file that exists", async () => {
    const dest = join(home, 'apps', 'repoyeti')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'repoyeti-windows-x64.exe'), 'x')
    writeFileSync(join(dest, 'installed.json'), JSON.stringify({ version: 'v1.3.0', asset: 'repoyeti-windows-x64.exe', sha256: 'x' }))
    expect(await def().detect()).toEqual({ state: 'installed', url: null, version: 'v1.3.0' })
  })

  test("installed when the machine's own exe is where REPOYETI_EXE says", async () => {
    const exe = join(root, 'RepoYeti.exe')
    writeFileSync(exe, 'x')
    process.env.REPOYETI_EXE = exe
    try {
      expect((await def().detect()).state).toBe('installed')
    } finally {
      delete process.env.REPOYETI_EXE
    }
  })
})

describe('chat', () => {
  const status = (over: Partial<ConnectorStatus>): ConnectorStatus => ({ id: 'repoyeti', state: 'running', url: 'http://127.0.0.1:7171', version: null, enabled: true, givesChats: true, checkedAt: 0, ...over })

  test('a running RepoYeti gives its HTTP MCP under the name repoyeti and one paragraph', () => {
    const c = def().chat?.('C:/Users/me/proj', status({}))
    expect(c?.mcpServers).toEqual({ repoyeti: { type: 'http', url: 'http://127.0.0.1:7171/api/mcp' } })
    expect(c?.prompt).toContain('repoyeti tools')
    expect(c?.prompt).toContain('approval gate')
    expect(c?.prompt?.includes('\n')).toBe(false)
  })

  test('gives nothing unless it runs with an address', () => {
    expect(def().chat?.('C:/Users/me/proj', status({ state: 'installed', url: null }))).toBeNull()
    expect(def().chat?.('C:/Users/me/proj', status({ url: null }))).toBeNull()
  })

  test('a credential in its config.json never reaches detect or chat output', async () => {
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'config.json'), JSON.stringify({ oauth: { accessToken: 'SECRET-TOKEN-VALUE' } }))
    runtime(url())
    const d = def()
    const detected = await d.detect()
    const c = d.chat?.('C:/Users/me/proj', status({ url: detected.url }))
    expect(JSON.stringify({ detected, c })).not.toContain('SECRET-TOKEN-VALUE')
  })
})
