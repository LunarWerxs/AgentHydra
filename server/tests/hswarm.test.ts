// server/tests/hswarm.test.ts - the HydraSwarm sidecar the daemon runs (server/src/hswarm.ts).
//
// A sidecar that exits is started again on its own, and a wrong AGENTHYDRA_HSWARM_DIR is reported
// by name rather than quietly swapped for another copy of the package.

import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getHSwarmStatus,
  hswarmDir,
  resetHSwarmStateForTests,
  startHSwarm,
  stopHSwarm,
} from '../src/hswarm'

const tmp = mkdtempSync(join(tmpdir(), 'hswarm-test-'))

function withPackage(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(join(dir, 'hswarm'), { recursive: true })
  writeFileSync(join(dir, 'hswarm', '__init__.py'), '')
  return dir
}

afterEach(async () => {
  await stopHSwarm()
  resetHSwarmStateForTests()
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

test('a wrong AGENTHYDRA_HSWARM_DIR is reported, never replaced by the copy beside the app', async () => {
  const app = withPackage('app')
  const other = withPackage('other')
  const empty = join(tmp, 'empty')
  mkdirSync(empty)

  expect(hswarmDir({}, app)).toBe(app)
  expect(hswarmDir({ AGENTHYDRA_HSWARM_DIR: other }, app)).toBe(other)
  expect(hswarmDir({ AGENTHYDRA_HSWARM_DIR: empty }, app)).toBeNull()

  let spawns = 0
  const spawn = (() => {
    spawns++
    throw new Error('must not start')
  }) as unknown as typeof Bun.spawn
  await startHSwarm({ enabled: true, env: { AGENTHYDRA_HSWARM_DIR: empty }, spawn })
  expect(spawns).toBe(0)
  expect(getHSwarmStatus()).toMatchObject({
    running: false,
    lastError: expect.stringContaining(empty),
  })
})

test('the proxy hands a binary reply through as bytes with hswarm’s own type', async () => {
  // A provider logo, as the HSwarm tab's <img> asks for it: the bytes and the image type must
  // arrive unchanged (re-read as text it came back text/plain, and an SVG logo never drew).
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80,
  ])
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response(png, { headers: { 'content-type': 'image/png' } }),
  })
  const home = process.env.HSWARM_HOME
  process.env.HSWARM_HOME = tmp // no console token of the user's is read
  try {
    const spawn = (() => {
      let exit = () => {}
      const exited = new Promise<number>((resolve) => {
        exit = () => resolve(0)
      })
      return { pid: undefined, exited, kill: () => exit() }
    }) as unknown as typeof Bun.spawn
    await startHSwarm({
      enabled: true,
      dir: withPackage('proxied'),
      logDir: join(tmp, 'logs'),
      spawn,
      port: upstream.port,
    })
    const { Hono } = await import('hono')
    const { app } = await import('../src/http-app')
    await import('../src/routes/hswarm')
    const http = new Hono().route('/', app) // the shared app stays open for later files

    const res = await http.request('/api/hswarm/ui/favicon/groq')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png)
  } finally {
    upstream.stop(true)
    if (home === undefined) delete process.env.HSWARM_HOME
    else process.env.HSWARM_HOME = home
  }
})

test('a sidecar that exits is started again', async () => {
  const exits: (() => void)[] = []
  const spawn = (() => {
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    exits.push(exit)
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn

  await startHSwarm({
    enabled: true,
    dir: withPackage('crashy'),
    logDir: join(tmp, 'logs'),
    spawn,
    port: 1,
  })
  expect(exits).toHaveLength(1)

  exits[0]()
  await Bun.sleep(1_300) // the first restart waits 1 s
  expect(exits).toHaveLength(2)
  expect(getHSwarmStatus()).toMatchObject({ running: true, lastError: null })
})

test('HSWARM_STATS_DB is set when zswarm.sqlite exists and env does not override it', async () => {
  const { writeFileSync } = await import('node:fs')
  const zswarmDb = join(tmp, '.zswarm', 'zswarm.sqlite')
  mkdirSync(join(tmp, '.zswarm'), { recursive: true })
  writeFileSync(zswarmDb, '')

  let capturedEnv: NodeJS.ProcessEnv | null = null
  const spawn = ((cmd: string[], opts: any) => {
    capturedEnv = opts.env
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn

  const home = tmp
  await startHSwarm({
    enabled: true,
    dir: withPackage('stats-test'),
    logDir: join(tmp, 'logs'),
    spawn,
    port: 1,
    env: { HOME: home, USERPROFILE: home },
  })

  expect(capturedEnv).toBeDefined()
  expect(capturedEnv!.HSWARM_STATS_DB).toBe(zswarmDb)

  // Clean up for next test
  await stopHSwarm()
  resetHSwarmStateForTests()
})

test('HSWARM_STATS_DB is not set when zswarm.sqlite does not exist', async () => {
  let capturedEnv: NodeJS.ProcessEnv | null = null
  const spawn = ((cmd: string[], opts: any) => {
    capturedEnv = opts.env
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn

  const emptyHome = join(tmp, 'no-zswarm')
  mkdirSync(emptyHome, { recursive: true })
  await startHSwarm({
    enabled: true,
    dir: withPackage('no-stats'),
    logDir: join(tmp, 'logs'),
    spawn,
    port: 1,
    env: { HOME: emptyHome, USERPROFILE: emptyHome },
  })

  expect(capturedEnv).toBeDefined()
  expect(capturedEnv!.HSWARM_STATS_DB).toBeUndefined()

  // Clean up for next test
  await stopHSwarm()
  resetHSwarmStateForTests()
})

test('an account uuid maps to the acct id hswarm prints and to the instance signed in as it', async () => {
  const { createHash } = await import('node:crypto')
  const { hswarmAccountMap } = await import('../src/routes/hswarm')
  const uuid = '00000000-0000-0000-0000-000000000001'
  const id = `acct-${createHash('sha256').update(uuid).digest('hex').slice(0, 8)}`
  const dir = join(tmp, 'cli-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }))

  const map = hswarmAccountMap({
    desktop: [
      { num: 4, name: 'inst-4', label: null, loginUuid: null, account: null },
      { num: 2, name: 'inst-2', label: 'Work', loginUuid: uuid, account: null },
    ],
    cli: [{ num: 9, name: 'cli-a', configDir: dir }],
    cliUuid: (d) =>
      JSON.parse(readFileSync(join(d, '.claude.json'), 'utf8')).oauthAccount.accountUuid,
  })
  // The desktop instance wins over the CLI one for the same account.
  expect(map[id]).toEqual({ num: 2, label: 'Work', kind: 'desktop' })

  const cliOnly = hswarmAccountMap({
    desktop: [],
    cli: [{ num: 9, name: 'cli-a', configDir: dir }],
    cliUuid: () => uuid,
  })
  expect(cliOnly[id]).toEqual({ num: 9, label: 'cli-a', kind: 'cli' })
})
