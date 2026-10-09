// server/tests/hydra-family.test.ts - AgentHydra's side of the Hydra family contract
// (server/src/hydra-family.ts): the manifest it publishes, how it reads a peer's, the up/down
// verdict (a peer that is absent or silent is reported, never an error) and the two MCP tools.
// Peers are stand-ins: a throwaway HTTP server for health URLs and a bun script for a command line.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../src/config'
import {
  FAMILY_SCHEMA,
  type FamilyManifest,
  familyAnswer,
  familyDir,
  familyWriteBarred,
  isUp,
  projectContext,
  readManifest,
  runCli,
  selfManifest,
  writeSelfManifest,
} from '../src/hydra-family'
import { TOOLS } from '../src/mcp'
import { desiredEntry } from '../src/mcp-register'

// Real child processes: a cold CI box is far slower than a dev machine (bun's default is 5 s).
const SPAWN_TIMEOUT_MS = 30_000

let root: string
let health: ReturnType<typeof Bun.serve>
let deadUrl: string
let cliScript: string

const peer = (extra: Record<string, unknown> = {}) => ({
  schema: FAMILY_SCHEMA,
  name: 'projecthydra',
  title: 'Project Hydra',
  what: 'Example peer.',
  ask_it_for: ['which project a folder is'],
  mcp: null,
  http: null,
  health: null,
  cli: null,
  version: '1.0.0',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const putManifest = (dir: string, name: string, body: unknown) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body))
}

const freshDir = () => mkdtempSync(join(root, 'family-'))

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ah-family-'))
  health = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/bad'
        ? new Response('no', { status: 500 })
        : Response.json({ ok: true }),
  })
  const closed = Bun.serve({ port: 0, fetch: () => new Response('') })
  deadUrl = `http://127.0.0.1:${closed.port}`
  closed.stop(true)
  cliScript = join(root, 'peer-cli.js')
  writeFileSync(
    cliScript,
    [
      'const [, , verb, cwd, flag] = process.argv',
      "if (cwd === 'boom') { console.error('boom first line\\nsecond line'); process.exit(3) }",
      "if (cwd === 'text') { console.log('not json'); process.exit(0) }",
      "console.log(JSON.stringify({ key: 'example', verb, cwd, flag }))",
    ].join('\n'),
  )
})
afterAll(() => {
  health.stop(true)
  rmSync(root, { recursive: true, force: true })
})

describe('the manifest AgentHydra publishes', () => {
  test('names the daemon, its health URL and its MCP endpoint', () => {
    const m = selfManifest('http://127.0.0.1:7787/', new Date('2026-10-08T12:00:00Z'))
    expect(m).toMatchObject({
      schema: FAMILY_SCHEMA,
      name: 'agenthydra',
      title: 'AgentHydra',
      http: 'http://127.0.0.1:7787',
      health: 'http://127.0.0.1:7787/api/health',
      cli: null,
      version: VERSION,
      updated_at: '2026-10-08T12:00:00.000Z',
    })
    expect(m.ask_it_for.length).toBeGreaterThan(0)
    // The MCP path is repeated in hydra-family.ts so the stdio server loads no database.
    expect(m.mcp).toEqual({ transport: 'http', url: desiredEntry('http://127.0.0.1:7787').url })
  })

  test('is written whole to the family folder, replacing the last one', () => {
    const dir = join(freshDir(), 'nested')
    const file = writeSelfManifest('http://127.0.0.1:7787', dir)
    expect(file).toBe(join(dir, 'agenthydra.json'))
    writeSelfManifest('http://127.0.0.1:7790', dir)
    expect(JSON.parse(readFileSync(file, 'utf8')).http).toBe('http://127.0.0.1:7790')
    expect(readdirSync(dir)).toEqual(['agenthydra.json'])
    expect(readManifest('agenthydra', dir)?.health).toBe('http://127.0.0.1:7790/api/health')
  })

  test('a folder that cannot be made is an error for the caller to log', () => {
    const file = join(freshDir(), 'a-file')
    writeFileSync(file, '')
    expect(() => writeSelfManifest('http://127.0.0.1:7787', join(file, 'sub'))).toThrow()
  })

  test('HYDRA_FAMILY_DIR names the folder; otherwise it is ~/.hydra-family', () => {
    expect(familyDir({ HYDRA_FAMILY_DIR: 'D:/somewhere' })).toBe('D:/somewhere')
    expect(familyDir({})).toMatch(/\.hydra-family$/)
  })

  test('a scratch daemon stays out of the machine folder unless it names one of its own', () => {
    expect(familyWriteBarred(true, false, {})).toBe(false)
    expect(familyWriteBarred(false, false, {})).toBe(true)
    expect(familyWriteBarred(true, true, {})).toBe(true)
    expect(familyWriteBarred(false, true, { HYDRA_FAMILY_DIR: 'D:/scratch' })).toBe(false)
  })
})

describe('reading a peer', () => {
  test('a missing, unreadable or foreign-schema file is not installed', () => {
    const dir = freshDir()
    expect(readManifest('projecthydra', dir)).toBeNull()
    putManifest(dir, 'projecthydra', '{ not json')
    expect(readManifest('projecthydra', dir)).toBeNull()
    putManifest(dir, 'projecthydra', peer({ schema: 'hydra-family/2' }))
    expect(readManifest('projecthydra', dir)).toBeNull()
  })

  test('a good file reads back, with stray fields dropped', () => {
    const dir = freshDir()
    putManifest(dir, 'projecthydra', {
      ...peer({
        cli: ['python', 'ph.py'],
        mcp: { transport: 'stdio', command: ['python', 'mcp.py'], cwd: 'C:/ph' },
      }),
      extra: 1,
    })
    expect(readManifest('projecthydra', dir)).toMatchObject({
      name: 'projecthydra',
      cli: ['python', 'ph.py'],
      mcp: { transport: 'stdio', command: ['python', 'mcp.py'], cwd: 'C:/ph' },
      ask_it_for: ['which project a folder is'],
    })
  })
})

describe('up or down', () => {
  const m = (extra: Record<string, unknown>) => ({ ...peer(), ...extra }) as FamilyManifest

  test('a health URL that answers 2xx is up; a 5xx or a closed port is down', async () => {
    expect(await isUp(m({ health: `http://127.0.0.1:${health.port}/api/health` }))).toBe(true)
    expect(await isUp(m({ health: `http://127.0.0.1:${health.port}/bad` }))).toBe(false)
    expect(await isUp(m({ health: `${deadUrl}/api/health` }))).toBe(false)
  })

  test('with no health URL, a command line is up while it exists on disk', async () => {
    expect(await isUp(m({ cli: [process.execPath, cliScript] }))).toBe(true)
    expect(await isUp(m({ cli: [process.execPath, join(root, 'gone.py')] }))).toBe(false)
    expect(await isUp(m({ cli: [join(root, 'no-such-exe'), cliScript] }))).toBe(false)
    expect(await isUp(m({}))).toBe(false)
  })

  test('the answer names all three members when peers are absent or down', async () => {
    const dir = freshDir()
    putManifest(dir, 'monkeywerx', peer({ name: 'monkeywerx', health: `${deadUrl}/health` }))
    const answer = await familyAnswer(`http://127.0.0.1:${health.port}`, dir)
    expect(answer.schema).toBe(FAMILY_SCHEMA)
    expect(answer.self).toBe('agenthydra')
    expect(answer.members.map((x) => [x.name, x.installed, x.up])).toEqual([
      ['projecthydra', false, false],
      ['agenthydra', true, true],
      ['monkeywerx', true, false],
    ])
    for (const member of answer.members) expect(member.what).not.toBe('')
  })

  test('a peer that is up is reported with how to reach it', async () => {
    const dir = freshDir()
    putManifest(
      dir,
      'projecthydra',
      peer({ cli: [process.execPath, cliScript], http: 'http://127.0.0.1:1' }),
    )
    const found = (await familyAnswer(deadUrl, dir)).members.find((x) => x.name === 'projecthydra')
    expect(found).toMatchObject({
      installed: true,
      up: true,
      cli: [process.execPath, cliScript],
      http: 'http://127.0.0.1:1',
      version: '1.0.0',
    })
  })
})

describe('a peer command line and project_context', () => {
  test(
    'runCli passes its arguments and parses JSON from stdout',
    async () => {
      const out = await runCli([process.execPath, cliScript], ['which', 'C:/example', '--json'])
      expect(out).toEqual({
        ok: true,
        json: { key: 'example', verb: 'which', cwd: 'C:/example', flag: '--json' },
      })
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'a nonzero exit, non-JSON and a missing exe are unavailable',
    async () => {
      expect(await runCli([process.execPath, cliScript], ['which', 'boom'])).toEqual({
        ok: false,
        reason: 'unavailable: boom first line',
      })
      expect(await runCli([process.execPath, cliScript], ['which', 'text'])).toEqual({
        ok: false,
        reason: 'unavailable: its answer was not JSON',
      })
      const gone = await runCli([join(root, 'no-such-exe')], [])
      expect(gone.ok).toBe(false)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'project_context returns the project JSON as Project Hydra gives it',
    async () => {
      const dir = freshDir()
      putManifest(dir, 'projecthydra', peer({ cli: [process.execPath, cliScript] }))
      expect(await projectContext('C:/example/app', dir)).toEqual({
        key: 'example',
        verb: 'which',
        cwd: 'C:/example/app',
        flag: '--json',
      })
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'project_context says why Project Hydra is not available',
    async () => {
      const dir = freshDir()
      expect(await projectContext('C:/x', dir)).toEqual({
        available: false,
        reason: 'unavailable: Project Hydra is not installed here',
      })
      putManifest(dir, 'projecthydra', peer())
      expect(await projectContext('C:/x', dir)).toMatchObject({ available: false })
      putManifest(dir, 'projecthydra', peer({ cli: [process.execPath, cliScript] }))
      expect(await projectContext('boom', dir)).toEqual({
        available: false,
        reason: 'unavailable: boom first line',
      })
    },
    SPAWN_TIMEOUT_MS,
  )
})

describe('the MCP tools', () => {
  const tool = (name: string) => {
    const t = TOOLS.find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }

  test('hydra_family names all three members and answers with all three', async () => {
    const t = tool('hydra_family')
    for (const name of ['Project Hydra', 'AgentHydra', 'MonkeyWerx'])
      expect(t.description).toContain(name)
    const answer = (await t.run({})) as { self: string; members: unknown[] }
    expect(answer.self).toBe('agenthydra')
    expect(answer.members).toHaveLength(3)
  })

  test('project_context needs a folder path, never one that reads as an option', () => {
    const t = tool('project_context')
    expect(t.inputSchema).toMatchObject({ required: ['cwd'] })
    expect(() => t.run({ cwd: '' })).toThrow('cwd must be a folder path')
    expect(() => t.run({ cwd: '--help' })).toThrow('cwd must be a folder path')
  })
})
