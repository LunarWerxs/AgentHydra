// The manager on fake ports and a fake scan (no real port is read, no home folder touched): one copy per server, a
// conflict is refused and never killed, ids and the import from the old DevWebUI folder, one spawn per concurrent
// start (a real short-lived bun child), starts racing waits, stops and restarts, autostart only on a later load, and the
// resource history the info pane's charts read.

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDevServers } from '../../src/devservers/manager'
import type { DevServers } from '../../src/devservers/contract'
import { killHostTree, pidAlive } from '../../src/host/launch'
import type { Listener, ProcInfo, Scan } from '../../src/localhost/ports'

const dirs: string[] = []
const made: DevServers[] = []

const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-mgr-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  for (const ds of made.splice(0)) await ds.stopAll()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // a child still letting go of its folder: the temp folder is the OS's to clean
    }
  }
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(50)
  }
}

/** The machine as the manager sees it: which ports answer, and the scan behind them. */
class World {
  open = new Set<number>()
  listeners: Listener[] = []
  procs = new Map<number, ProcInfo>()
  killed: number[] = []
  /** Made-up pids that keep listening when killed. */
  stubborn = new Set<number>()
  t = 1_000_000

  listen(port: number, pid: number, name: string, command: string): void {
    this.open.add(port)
    this.listeners.push({ address: '127.0.0.1', port, pid })
    this.procs.set(pid, { pid, ppid: 1, name, command, created: 1_700_000_000_000 })
  }

  close(port: number): void {
    this.open.delete(port)
    this.listeners = this.listeners.filter((l) => l.port !== port)
  }

  make(home: string, extra: { importFrom?: string | null } = {}): DevServers {
    const ds = createDevServers({
      home,
      importFrom: extra.importFrom ?? null,
      watch: false,
      deskPid: 1,
      deskPort: 7798,
      now: () => this.t,
      portListening: async (p) => this.open.has(p),
      // A pid this world made up runs while it still listens; one the manager spawned is asked of the real machine.
      alive: (pid) => (this.procs.has(pid) ? this.listeners.some((l) => l.pid === pid) : pidAlive(pid)),
      scan: async (): Promise<Scan> => ({ listeners: [...this.listeners], procs: new Map(this.procs), error: null }),
      // The first start's project scan would walk every real drive.
      findProjects: async () => ({ files: [], detected: [], scannedDirs: 0, truncated: false, timedOut: false, ms: 0, roots: [] }),
      kill: (pid) => {
        this.killed.push(pid)
        // A pid this world made up stops listening (unless stubborn); one the manager spawned (a real bun child) is
        // really ended, or every stop would wait out the grace time and leave the child behind.
        if (!this.procs.has(pid)) killHostTree(pid)
        else if (!this.stubborn.has(pid)) for (const l of this.listeners.filter((x) => x.pid === pid)) this.close(l.port)
      },
    })
    made.push(ds)
    return ds
  }
}

function project(dir: string, processes: object[], name = 'Example'): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.devwebui')
  writeFileSync(file, JSON.stringify({ name, processes }))
  return file
}

const LONG = 'bun -e "setTimeout(()=>{},30000)"'

function expectedId(file: string): string {
  const abs = path.resolve(file).replace(/\\/g, '/')
  const norm = process.platform === 'linux' ? abs : abs.toLowerCase()
  return `p${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`
}

async function loaded(ds: DevServers, dir: string) {
  const res = await ds.load(dir)
  if (!('ok' in res)) throw new Error('expected a loaded project')
  return res
}

describe('one copy per server', () => {
  test('a port that answers from a dev process is that server: running, outside, and a start reuses it', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'web', name: 'Web', command: LONG, port: 4173 }])
    w.listen(4173, 900, 'node', 'node C:/Users/me/app/node_modules/vite/bin/vite.js')
    const ds = w.make(tmp())

    const { project: p } = await loaded(ds, dir)
    const proc = p.processes[0]!
    expect(proc).toMatchObject({ status: 'running', owner: 'outside', pid: 900, conflict: null })

    const ans = await ds.start(proc.id)
    expect(ans.reused).toBe(true)
    expect(ans.coStarted).toEqual([])
    expect(ds.runningIds()).toEqual([]) // nothing was spawned
    expect(w.killed).toEqual([])

    // Its output is not ours to show: one line says so.
    const logs = await ds.logs(proc.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.line).toContain('started outside AgentHydra (pid 900)')

    // The localhost list leaves it out as a server the manager lists.
    expect(await ds.owned()).toEqual({ ports: [4173], pids: [900] })

    // When its port stops answering it is down again.
    w.close(4173)
    w.t += 2000
    expect(await ds.process(proc.id)).toMatchObject({ status: 'stopped', owner: null, pid: null })
  })

  test('a port held by a system or tool process is a conflict: the start is refused with 409 and nothing is killed', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [
      { id: 'a', name: 'A', command: LONG, port: 4173 },
      { id: 'b', name: 'B', command: LONG, port: 4174 },
    ])
    w.listen(4173, 4321, 'svchost', 'C:\\Windows\\System32\\svchost.exe -k netsvcs')
    w.listen(4174, 4322, 'node', 'node C:/tools/codegraph/serve.js')
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)

    for (const [i, text] of [
      [0, 'port 4173 is in use by svchost (pid 4321)'],
      [1, 'port 4174 is in use by node (pid 4322)'],
    ] as const) {
      const id = p.processes[i]!.id
      const err = await ds.start(id).then(
        () => null,
        (e: unknown) => e as { status: number; message: string }
      )
      expect(err).not.toBeNull()
      expect(err!.status).toBe(409)
      expect(err!.message).toContain(text)
      expect(await ds.process(id)).toMatchObject({ status: 'stopped', owner: null, conflict: text })
    }
    expect(w.killed).toEqual([])
    expect(ds.runningIds()).toEqual([])
  })

  test('two concurrent starts of one server spawn it once', async () => {
    const w = new World()
    const dir = tmp()
    const marker = path.join(tmp(), 'spawned.txt').replace(/\\/g, '/')
    project(dir, [{ id: 'job', name: 'Job', command: `bun -e "require('fs').appendFileSync('${marker}','x');setTimeout(()=>{},30000)"` }])
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id

    const [a, b] = await Promise.all([ds.start(id), ds.start(id)])
    expect([a.reused, b.reused].sort()).toEqual([false, true])
    expect(a.process.pid).not.toBeNull()
    expect(ds.runningIds()).toEqual([id])

    await until(() => existsSync(marker))
    await sleep(500) // a second copy would have written by now
    expect(readFileSync(marker, 'utf8')).toBe('x')
  })

  test('a start while one waits for its dependency port joins it, and the server starts when the port answers', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'b', name: 'B', command: LONG, waitForPort: 4999 }])
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id

    expect((await ds.start(id)).process.status).toBe('waiting')
    expect((await ds.start(id)).reused).toBe(true)
    w.open.add(4999)
    await until(() => ds.runningIds().includes(id))
  })

  test('a server taken up as outside is judged again before a start or stop acts on it', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'web', name: 'Web', command: LONG, port: 4173 }])
    w.listen(4173, 900, 'node', 'node C:/Users/me/app/node_modules/vite/bin/vite.js')
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id
    expect(p.processes[0]).toMatchObject({ owner: 'outside', pid: 900 })

    // Vite went and a system service took the port between two looks: the port never stopped answering.
    w.close(4173)
    w.listen(4173, 4321, 'svchost', 'C:\\Windows\\System32\\svchost.exe -k netsvcs')
    w.t += 2000
    const err = await ds.start(id).then(
      () => null,
      (e: unknown) => e as { status: number; message: string }
    )
    expect(err?.status).toBe(409)
    expect(err!.message).toContain('port 4173 is in use by svchost (pid 4321)')
    await ds.stop(id)
    expect(w.killed).toEqual([])
    expect(ds.runningIds()).toEqual([])
  })

  test('a start while an outside server is being stopped waits for it, and never spawns onto its port', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'web', name: 'Web', command: LONG, port: 4173 }])
    w.listen(4173, 900, 'node', 'node C:/Users/me/app/node_modules/vite/bin/vite.js')
    w.stubborn.add(900)
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id

    const stopping = ds.stop(id)
    await sleep(100) // the stop is waiting for the port to go quiet
    const ans = await ds.start(id)
    await stopping
    // It never went, so it is still the server: used, not doubled.
    expect(ans.reused).toBe(true)
    expect(ds.runningIds()).toEqual([])
  })
})

describe('restart', () => {
  test('a restart and a start sent together leave the server running', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'job', name: 'Job', command: LONG }])
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id

    await Promise.all([ds.restart(id), ds.start(id)])
    expect(ds.runningIds()).toEqual([id])
  })

  test('a restart ends what still serves the port after the stop, then starts its own', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'web', name: 'Web', command: LONG, port: 4173 }])
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id
    await ds.start(id)

    // The old run's tree left a listener that is no longer under the child the manager started.
    w.listen(4173, 777, 'node', 'node C:/Users/me/app/node_modules/vite/bin/vite.js')
    w.t += 2000
    await ds.restart(id)
    expect(w.killed).toContain(777)
    expect(await ds.process(id)).toMatchObject({ owner: 'desk' })
    expect(ds.runningIds()).toEqual([id])
  })
})

describe('ids and the import', () => {
  test('ids are DevWebUI\'s, and the first run imports its registry and state without writing the old folder', async () => {
    const w = new World()
    const projDir = tmp()
    const file = project(projDir, [{ id: 'web', name: 'Web', command: LONG, autostart: true }])
    const old = tmp()
    const gone = path.join(tmp(), '.devwebui') // in the old registry, but the file no longer exists
    const pid = expectedId(file)
    writeFileSync(path.join(old, 'registry.json'), JSON.stringify({ projects: [file, gone] }))
    writeFileSync(path.join(old, 'state.json'), JSON.stringify({ enabled: { [`${pid}.web`]: false }, projectEnabled: { [pid]: false } }))
    const before = Object.fromEntries(readdirSync(old).map((n) => [n, readFileSync(path.join(old, n), 'utf8')]))

    const home = tmp()
    const ds = w.make(home, { importFrom: old })
    await ds.ready
    const projects = await ds.listProjects()

    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: pid, path: path.resolve(file), enabled: false })
    expect(projects[0]!.id).toMatch(/^p[0-9a-f]{8}$/)
    // The imported state.json override (off) beats the file's autostart: true.
    expect(projects[0]!.processes[0]).toMatchObject({ id: `${pid}.web`, localId: 'web', enabled: false, status: 'stopped' })

    // Ours is written, so the next run does not import again; the old folder is exactly as it was.
    expect(JSON.parse(readFileSync(path.join(home, 'devservers', 'registry.json'), 'utf8')).projects).toEqual([path.resolve(file)])
    expect(Object.fromEntries(readdirSync(old).map((n) => [n, readFileSync(path.join(old, n), 'utf8')]))).toEqual(before)

    writeFileSync(path.join(old, 'registry.json'), JSON.stringify({ projects: [] }))
    const again = w.make(home, { importFrom: old })
    expect((await again.listProjects()).map((x) => x.id)).toEqual([pid])
  })
})

describe('autostart', () => {
  test('a first load starts nothing; a later load starts the autostart servers', async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [
      { id: 'auto', name: 'Auto', command: LONG, autostart: true },
      { id: 'manual', name: 'Manual', command: LONG },
    ])
    const ds = w.make(tmp())

    const first = await loaded(ds, dir)
    expect(first.firstLoad).toBe(true)
    await sleep(500)
    expect(ds.runningIds()).toEqual([])
    expect(first.project.processes.map((x) => x.status)).toEqual(['stopped', 'stopped'])

    const second = await loaded(ds, dir)
    expect(second.firstLoad).toBe(false)
    const autoId = second.project.processes[0]!.id
    await until(() => ds.runningIds().includes(autoId))
    expect(ds.runningIds()).toEqual([autoId]) // the other server has no autostart
  })
})

describe('resource history', () => {
  test("a running server's samples of the last ten minutes are kept, oldest first, for the info pane's charts", async () => {
    const w = new World()
    const dir = tmp()
    project(dir, [{ id: 'job', name: 'Job', command: LONG }])
    const ds = w.make(tmp())
    const { project: p } = await loaded(ds, dir)
    const id = p.processes[0]!.id
    await ds.start(id)

    // The sampler measures the real child every few seconds; its first sample is there to read.
    await until(async () => (await ds.metricsHistory(id)).points.length > 0, 20_000)
    const first = await ds.metricsHistory(id)
    expect(first).toMatchObject({ id, sampleMs: 3000, windowMs: 600_000 })
    expect(first.points.every((x) => x.t === w.t)).toBe(true)
    expect(first.points[0]!.memory).toBeGreaterThan(0)

    // Eleven minutes on, what was sampled before has left the window: only the new samples are answered.
    w.t += 11 * 60_000
    await until(async () => (await ds.metricsHistory(id)).points.some((x) => x.t === w.t), 20_000)
    const later = (await ds.metricsHistory(id)).points
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((x) => x.t === w.t)).toBe(true)
    await ds.stop(id)
  }, 60_000)
})
