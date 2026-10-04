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

test('an adopted server is watched and replaced by our own child once it stops answering', async () => {
  let live = true
  const adoptedDir = withPackage('adopted')
  const probe = async () => (live ? { hswarm: true, pid: 4242, package: adoptedDir } : null)
  let spawns = 0
  const spawn = (() => {
    spawns++
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn
  mkdirSync(join(tmp, '.zswarm'), { recursive: true })
  let imports = 0
  const importSpawn = (() => {
    imports++
    return { stdout: new Response('{}').body, exited: Promise.resolve(0) }
  }) as unknown as typeof Bun.spawn

  await startHSwarm({
    enabled: true,
    dir: adoptedDir,
    logDir: join(tmp, 'logs'),
    env: { HOME: tmp, USERPROFILE: tmp },
    spawn,
    importSpawn,
    importFirstMs: 5,
    probe,
    watchEveryMs: 5,
    port: 1,
  })
  expect(spawns).toBe(0)
  expect(getHSwarmStatus()).toMatchObject({ running: true, pid: 4242 })

  await Bun.sleep(40) // several intervals, all answered
  expect(spawns).toBe(0)
  expect(imports).toBe(1) // the hourly ZSwarm import runs for an adopted server too

  live = false
  await Bun.sleep(80)
  expect(spawns).toBe(1)
  expect(getHSwarmStatus().pid).not.toBe(4242)
})

/** A server on the port that answers until `kill` is called with its pid; reports `pkg` as its folder. */
function serverOnPort(pkg: string | undefined) {
  let up = true
  const killed: number[] = []
  return {
    killed,
    probe: async () => (up ? { hswarm: true, pid: 4242, package: pkg } : null),
    kill: (pid: number) => {
      killed.push(pid)
      up = false
    },
  }
}

function countingSpawn() {
  const calls: number[] = []
  const spawn = (() => {
    calls.push(1)
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn
  return { calls, spawn }
}

test('a server running another package folder (or one that names none) is ended and replaced by our own', async () => {
  for (const theirs of [withPackage('stale'), undefined]) {
    const server = serverOnPort(theirs)
    const { calls, spawn } = countingSpawn()
    await startHSwarm({
      enabled: true,
      dir: withPackage('fresh'),
      logDir: join(tmp, 'logs'),
      probe: server.probe,
      kill: server.kill,
      spawn,
      port: 1,
    })
    expect(server.killed).toEqual([4242])
    expect(calls).toHaveLength(1)
    await stopHSwarm()
    resetHSwarmStateForTests()
  }
})

test('a side-run daemon adopts a foreign server read-only and never ends it; the primary does end it', async () => {
  for (const sideRun of [true, false]) {
    const server = serverOnPort(withPackage('primary-checkout'))
    const { calls, spawn } = countingSpawn()
    await startHSwarm({
      enabled: true,
      dir: withPackage('scratch-checkout'),
      logDir: join(tmp, 'logs'),
      probe: server.probe,
      kill: server.kill,
      spawn,
      watchEveryMs: 5,
      sideRun,
      port: 1,
    })
    await Bun.sleep(40) // several watch intervals: the watcher must not replace it either
    if (sideRun) {
      expect(server.killed).toEqual([])
      expect(calls).toHaveLength(0)
      expect(getHSwarmStatus()).toMatchObject({ running: true, pid: 4242 })
    } else {
      expect(server.killed).toEqual([4242])
      expect(calls).toHaveLength(1)
    }
    await stopHSwarm()
    resetHSwarmStateForTests()
  }
})

test('a server running our own package folder is adopted and left alone', async () => {
  const dir = withPackage('ours')
  const server = serverOnPort(dir)
  const { calls, spawn } = countingSpawn()
  await startHSwarm({
    enabled: true,
    dir,
    logDir: join(tmp, 'logs'),
    probe: server.probe,
    kill: server.kill,
    spawn,
    watchEveryMs: 60_000,
    port: 1,
  })
  expect(server.killed).toEqual([])
  expect(calls).toHaveLength(0)
  expect(getHSwarmStatus()).toMatchObject({ running: true, pid: 4242 })
})

test('a ZSwarm home is imported into HSwarm by a hidden import-zswarm run, and the stats DB is left to HSwarm', async () => {
  mkdirSync(join(tmp, '.zswarm'), { recursive: true })
  let sidecarEnv: NodeJS.ProcessEnv | null = null
  const spawn = ((cmd: string[], opts: any) => {
    sidecarEnv = opts.env
    let exit = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = () => resolve(0)
    })
    return { pid: undefined, exited, kill: () => exit() }
  }) as unknown as typeof Bun.spawn

  const importCalls: { cmd: string[]; opts: any }[] = []
  const importSpawn = ((cmd: string[], opts: any) => {
    importCalls.push({ cmd, opts })
    const counts = { sqlite: { utilizations: { read: 3, added: 2, already_there: 1 } } }
    return {
      stdout: new Response(JSON.stringify({ counts })).body,
      exited: Promise.resolve(0),
    }
  }) as unknown as typeof Bun.spawn

  const { startZswarmImport } = await import('../src/hswarm')
  startZswarmImport({
    python: 'python',
    dir: tmp,
    env: { HOME: tmp, USERPROFILE: tmp },
    spawn: importSpawn,
    firstMs: 5,
    everyMs: 20,
  })
  await Bun.sleep(200)
  expect(importCalls).toHaveLength(1) // a one-shot: a run that exits 0 is not scheduled again
  expect(importCalls[0].cmd.slice(1)).toEqual(['-m', 'hswarm', 'import-zswarm', '--json'])
  expect(importCalls[0].opts).toMatchObject({ cwd: tmp, windowsHide: true })
  await stopHSwarm()
  resetHSwarmStateForTests()

  await startHSwarm({
    enabled: true,
    dir: withPackage('stats-test'),
    logDir: join(tmp, 'logs'),
    spawn,
    importSpawn,
    port: 1,
    env: { HOME: tmp, USERPROFILE: tmp },
  })
  expect(sidecarEnv!.HSWARM_STATS_DB).toBeUndefined()
  expect(sidecarEnv!.HSWARM_SUPERVISED).toBe('1')

  // A person's own HSWARM_STATS_DB still reaches the sidecar.
  await stopHSwarm()
  resetHSwarmStateForTests()
  await startHSwarm({
    enabled: true,
    dir: withPackage('stats-test'),
    logDir: join(tmp, 'logs'),
    spawn,
    importSpawn,
    port: 1,
    env: { HOME: tmp, USERPROFILE: tmp, HSWARM_STATS_DB: join(tmp, 'mine.sqlite') },
  })
  expect(sidecarEnv!.HSWARM_STATS_DB).toBe(join(tmp, 'mine.sqlite'))
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

test('a signed-out account is named from known accounts and login history, never over a current login', async () => {
  const { hswarmAccountMap, hswarmAccountId } = await import('../src/routes/hswarm')
  const current = '00000000-0000-0000-0000-0000000000a1'
  const moved = '00000000-0000-0000-0000-0000000000a2'
  const nameOnly = '00000000-0000-0000-0000-0000000000a3'
  const stranger = '00000000-0000-0000-0000-0000000000a4'
  const history: Record<string, Array<{ accountUuid: string; lastSeenAt: string | null }>> = {
    'dir-2': [
      { accountUuid: moved, lastSeenAt: '2026-01-01T00:00:00Z' },
      { accountUuid: current, lastSeenAt: '2026-01-02T00:00:00Z' },
    ],
    'dir-5': [{ accountUuid: moved, lastSeenAt: '2026-03-01T00:00:00Z' }],
  }
  const map = hswarmAccountMap({
    desktop: [
      { num: 2, name: 'inst-2', label: null, loginUuid: current, account: null, dir: 'dir-2' },
      { num: 5, name: 'inst-5', label: null, loginUuid: null, account: null, dir: 'dir-5' },
    ],
    cli: [],
    cliUuid: () => null,
    known: {
      [current]: { name: 'Stale Name', email: null },
      [nameOnly]: { name: null, email: 'someone@example.com' },
    },
    pastLogins: (dir) => history[dir] ?? [],
  })
  // The current login keeps its instance and is not marked former, though known and history name it too.
  expect(map[hswarmAccountId(current)]).toEqual({ num: 2, label: 'inst-2', kind: 'desktop' })
  // Known only from history: the instance it last ran on (newest activity), flagged former.
  expect(map[hswarmAccountId(moved)]).toEqual({
    num: 5,
    label: 'inst-5',
    kind: 'desktop',
    former: true,
  })
  // Known by name only: former, no instance number.
  expect(map[hswarmAccountId(nameOnly)]).toEqual({ label: 'someone@example.com', former: true })
  // Nobody knows it: absent.
  expect(map[hswarmAccountId(stranger)]).toBeUndefined()
})
