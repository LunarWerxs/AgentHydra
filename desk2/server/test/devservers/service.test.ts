// devservers/service.ts with a fake DevServers (no manager, no dev server, no real process): every request needs the
// token, the manager's errors keep their status, the localhost list leaves out the service's own port, a shutdown
// stops what it started, records a restart's servers in resume.json, removes service.json and exits, takes no new work
// meanwhile, and one lock keeps a second service of the same home from starting.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DevServers, DevServerError } from '../../src/devservers/contract'
import { readServiceFile, resumeFilePath, serviceAlreadyRunning, serviceFilePath, serviceLockPath, startService, takeServiceLock, type RunningService } from '../../src/devservers/service'
import type { ProcInfo } from '../../src/localhost/ports'

const temps: string[] = []
const running: RunningService[] = []
afterEach(async () => {
  for (const s of running.splice(0)) await s.shutdown(false)
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'desk-service-'))
  temps.push(d)
  return d
}

const project = { id: 'p1', name: 'Site', path: 'C:/Users/me/site/.devwebui', enabled: true, processes: [] }

function fakeDevServers(over: Partial<DevServers> = {}): DevServers & { stopped: number } {
  const dev = {
    ready: Promise.resolve(),
    stopped: 0,
    listProjects: async () => [project],
    process: async () => null,
    start: async () => {
      throw new DevServerError('port 4173 is in use by example-app (pid 7)', 409)
    },
    stop: async () => ({ ok: true as const, process: {} as never, coStopped: [] }),
    restart: async () => ({ ok: true as const, process: {} as never }),
    startProject: async () => ({ ok: true as const }),
    stopProject: async () => ({ ok: true as const }),
    logs: async () => [],
    load: async () => ({ ok: true as const, project, firstLoad: false }),
    scaffold: async () => ({ ok: true as const, project, firstLoad: true, created: 'x' }),
    folder: async () => ({ project }),
    ensure: async () => ({ ok: false as const, error: 'unused' }),
    owned: async () => ({ ports: [4173], pids: [] }),
    runningIds: () => ['p1.web', 'p1.api'],
    found: async () => ({ items: [], scanning: null, lastScan: null }),
    scan: async () => ({ files: [], detected: [], scannedDirs: 0, truncated: false, timedOut: false, ms: 0, roots: [] }),
    forgetFound: async () => ({ ok: true as const }),
    preview: async () => ({ kind: 'none' as const, error: 'unused' }),
    ignored: async () => ({ paths: [] }),
    ignore: async () => ({ paths: [] }),
    unignore: async () => ({ paths: [] }),
    cloneDest: async () => ({ dest: 'C:/Users/me/dev/repo' }),
    clone: async () => ({ ok: true }),
    updateProject: async () => project,
    removeProject: async () => ({ ok: true as const }),
    setProjectEnabled: async () => project,
    addProcess: async () => project,
    processConfig: async () => ({ id: 'web', name: 'Web', command: 'bun dev' }),
    updateProcess: async () => project,
    removeProcess: async () => project,
    setStarred: async () => ({}) as never,
    setProcessEnabled: async () => ({}) as never,
    takeover: async () => ({ triggers: [], backups: [] }),
    takeOver: async () => ({ ok: true, disabled: [], backups: [], skipped: [] }),
    restoreTakeover: async () => ({ ok: true as const, restored: [] }),
    startAllServers: async () => ({ ok: true as const, started: [] }),
    stopAllServers: async () => ({ ok: true as const, stopped: [] }),
    logPage: async () => ({ lines: [], more: false }),
    freePort: async () => ({ ok: true }),
    errors: async () => [],
    dismissError: async () => ({ ok: true as const }),
    clearErrors: async () => ({ ok: true as const }),
    openInEditor: async () => ({ ok: false as const, reason: 'no-editor' as const }),
    settings: async () => ({}) as never,
    saveSettings: async () => ({}) as never,
    restartRunning: async () => ({ ok: true as const, restarted: [] }),
    alerts: async () => ({}) as never,
    addAlert: async () => ({}) as never,
    updateAlert: async () => ({}) as never,
    removeAlert: async () => ({ ok: true as const }),
    clearAlertEvents: async () => ({ ok: true as const }),
    async stopAll() {
      dev.stopped++
    },
    killAllSync() {},
    ...over
  }
  return dev as DevServers & { stopped: number }
}

interface Booted {
  home: string
  svc: RunningService
  exits: number[]
  call: (path: string, init?: RequestInit, token?: string) => Promise<Response>
}

async function boot(dev: DevServers, localhost: Parameters<typeof startService>[0]['localhost'] = { scan: async () => ({ listeners: [], procs: new Map(), error: null }), probe: async () => null }): Promise<Booted> {
  const h = home()
  const exits: number[] = []
  const svc = await startService({ home: h, devServers: dev, stamp: 'stamp-1', localhost, exit: (code) => void exits.push(code) })
  running.push(svc)
  const file = readServiceFile(h)!
  const call = (path: string, init?: RequestInit, token = file.token) =>
    fetch(`http://127.0.0.1:${file.port}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) } })
  return { home: h, svc, exits, call }
}

test('service.json says where it listens and how to ask, and every request needs the token', async () => {
  const b = await boot(fakeDevServers())
  const file = readServiceFile(b.home)!
  expect(file).toMatchObject({ pid: process.pid, stamp: 'stamp-1' })
  expect(file.port).toBeGreaterThan(0)

  for (const path of ['/health', '/api/projects', '/api/owned']) {
    expect((await b.call(path, undefined, '')).status).toBe(401)
    expect((await b.call(path, undefined, 'wrong')).status).toBe(401)
    expect((await b.call(path)).status).toBe(200)
  }
  expect((await b.call('/api/shutdown', { method: 'POST', body: '{}' }, 'wrong')).status).toBe(401)
  expect(b.exits).toEqual([])
  expect(await (await b.call('/health')).json()).toEqual({ ok: true, pid: process.pid, stamp: 'stamp-1', running: 2 })
})

test("a manager error answers with its own status and message, an unknown server is a 404", async () => {
  const b = await boot(fakeDevServers())
  const refused = await b.call('/api/processes/p1.web/start', { method: 'POST', body: '{}' })
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({ error: 'port 4173 is in use by example-app (pid 7)' })
  const unknown = await b.call('/api/processes/p1.nope')
  expect(unknown.status).toBe(404)
  expect(((await unknown.json()) as { error: string }).error).toContain('p1.nope')
  expect((await b.call('/api/projects/load', { method: 'POST', body: '{}' })).status).toBe(400)
  expect((await b.call('/api/ensure', { method: 'POST', body: '{"server":"web"}' })).status).toBe(400)
})

test("the DevWebUI routes hand the manager their parsed input, and bad input is a 400 that reaches nothing", async () => {
  const calls: unknown[][] = []
  const record = (name: string, answer: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return answer
  }
  const b = await boot(
    fakeDevServers({
      saveSettings: record('saveSettings', {}) as never,
      logPage: record('logPage', { lines: [], more: false }) as never,
      freePort: record('freePort', { ok: true }) as never,
      scan: record('scan', { files: [], detected: [], scannedDirs: 0, truncated: false, timedOut: false, ms: 0, roots: [] }) as never,
      errors: record('errors', []) as never,
      dismissError: record('dismissError', { ok: true }) as never,
      clearErrors: record('clearErrors', { ok: true }) as never
    })
  )
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
  const cases: [string, string, RequestInit | undefined, unknown[] | 400][] = [
    ['settings', '/api/settings', { method: 'PATCH', body: '{"autoScan":true}' }, ['saveSettings', { autoScan: true }]],
    ['log page', '/api/processes/p1.web/logs?before=40&limit=5', undefined, ['logPage', 'p1.web', { before: 40, limit: 5 }]],
    ['free port, confirmed', '/api/processes/p1.web/free-port', post({ pids: [4242] }), ['freePort', 'p1.web', [4242]]],
    ['free port, no confirm', '/api/processes/p1.web/free-port', post({}), ['freePort', 'p1.web', undefined]],
    ['scan', '/api/scan', post({ preset: 'scoped', roots: ['C:/Users/me/dev'] }), ['scan', { preset: 'scoped', roots: ['C:/Users/me/dev'] }]],
    ["one server's errors", '/api/errors?process=p1.web', undefined, ['errors', 'p1.web']],
    ['dismiss', '/api/errors/dismiss', post({ fingerprint: 'fp-1' }), ['dismissError', 'fp-1']],
    ['clear', '/api/errors/clear', post({ process: 'p1.web' }), ['clearErrors', 'p1.web']],
    ['limit not a number', '/api/processes/p1.web/logs?limit=abc', undefined, 400],
    ['pids not whole positive numbers', '/api/processes/p1.web/free-port', post({ pids: [12, -3] }), 400],
    ['unknown scan preset', '/api/scan', post({ preset: 'everything' }), 400],
    ['dismiss without a fingerprint', '/api/errors/dismiss', post({}), 400]
  ]
  const got: unknown[] = []
  for (const [what, path, init] of cases) {
    calls.length = 0
    const res = await b.call(path, init)
    got.push([what, res.status, [...calls]])
  }
  // Each good request is one call with its input parsed; a refused one never reaches the manager.
  expect(got).toEqual(cases.map(([what, , , want]) => (want === 400 ? [what, 400, []] : [what, 200, [want]])))
})

test('/api/servers lists the folder\'s project and the dev servers no project lists, never the service itself', async () => {
  const procs = new Map<number, ProcInfo>([
    // Names as the scan gives them (ports.ts drops `.exe`): all three are dev runtimes, so only the rules keep two out.
    [100, { pid: 100, ppid: 1, name: 'node', command: 'node vite.js', created: null }],
    [101, { pid: 101, ppid: 1, name: 'node', command: 'node preview.js', created: null }],
    [999, { pid: 999, ppid: 1, name: 'bun', command: 'bun service.ts', created: null }]
  ])
  let servicePort = 0
  const b = await boot(fakeDevServers(), {
    scan: async () => ({
      listeners: [
        { address: '127.0.0.1', port: 5173, pid: 100 }, // a dev server a terminal started
        { address: '127.0.0.1', port: 4173, pid: 101 }, // one the manager lists as up
        { address: '127.0.0.1', port: servicePort, pid: 999 } // the service's own listener
      ],
      procs,
      error: null
    }),
    probe: async () => ({ status: 200, title: 'Example' }),
    deskPid: 1,
    deskPort: 7798
  })
  servicePort = readServiceFile(b.home)!.port
  const found = (await (await b.call(`/api/servers?cwd=${encodeURIComponent('C:/Users/me/site/src')}`)).json()) as { project: { id: string } | null; projects: { id: string }[]; others: { port: number }[] }
  expect(found.project?.id).toBe('p1')
  expect(found.projects.map((p) => p.id)).toEqual(['p1'])
  expect(found.others.map((s) => s.port)).toEqual([5173])

  const elsewhere = (await (await b.call(`/api/servers?cwd=${encodeURIComponent('C:/Users/me/other')}`)).json()) as { project: unknown; projects: unknown[] }
  expect(elsewhere.project).toBeNull()
  expect(elsewhere.projects).toEqual([])
  const every = (await (await b.call(`/api/servers?cwd=${encodeURIComponent('C:/Users/me/other')}&all=1`)).json()) as { projects: { id: string }[] }
  expect(every.projects.map((p) => p.id)).toEqual(['p1'])
})

test('a shutdown with restart records the running servers in resume.json, stops them, removes service.json and exits', async () => {
  const dev = fakeDevServers()
  const b = await boot(dev)
  const res = await b.call('/api/shutdown', { method: 'POST', body: '{"restart":true}' })
  expect(await res.json()).toEqual({ ok: true })
  await b.svc.done
  expect(JSON.parse(readFileSync(resumeFilePath(b.home), 'utf8'))).toEqual({ ids: ['p1.web', 'p1.api'] })
  expect(dev.stopped).toBe(1)
  expect(existsSync(serviceFilePath(b.home))).toBe(false)
  expect(b.exits).toEqual([0])
})

test('a plain shutdown stops the servers and leaves nothing to resume', async () => {
  const dev = fakeDevServers()
  const b = await boot(dev)
  mkdirSync(join(b.home, 'devservers'), { recursive: true })
  writeFileSync(resumeFilePath(b.home), JSON.stringify({ ids: ['p1.old'] }))
  await b.call('/api/shutdown', { method: 'POST', body: '{}' })
  await b.svc.done
  expect(existsSync(resumeFilePath(b.home))).toBe(false)
  expect(dev.stopped).toBe(1)
  expect(existsSync(serviceFilePath(b.home))).toBe(false)
  expect(b.exits).toEqual([0])
})

test('once a shutdown is asked for, /health stops saying ok and no new work is taken', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const started: string[] = []
  const dev = fakeDevServers({
    start: async (id) => {
      started.push(id)
      return { ok: true as const, process: {} as never, reused: false, coStarted: [] }
    },
    stopAll: () => gate
  })
  const b = await boot(dev)
  await b.call('/api/shutdown', { method: 'POST', body: '{}' })
  // The servers are still being stopped: a start now would outlive the service.
  expect((await b.call('/api/processes/p1.web/start', { method: 'POST', body: '{}' })).status).toBe(503)
  expect(((await (await b.call('/health')).json()) as { ok: unknown }).ok).toBe(false)
  expect(started).toEqual([])
  release()
  await b.svc.done
})

test('one service per home: the lock is taken, refused while a live process holds it, and taken over from a dead one', async () => {
  const h = home()
  expect(await takeServiceLock(h, 0)).toEqual({ ok: true })
  expect(readFileSync(serviceLockPath(h), 'utf8')).toBe(String(process.pid))

  // A live process holds it (this test's parent stands in for a service still starting).
  writeFileSync(serviceLockPath(h), String(process.ppid))
  expect((await takeServiceLock(h, 0)).ok).toBe(false)

  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  writeFileSync(serviceLockPath(h), String(gone.pid))
  expect(await takeServiceLock(h, 0)).toEqual({ ok: true })
  expect(readFileSync(serviceLockPath(h), 'utf8')).toBe(String(process.pid))
  // It starts a bun process, which a loaded CI runner can take past bun's 5 s default to start and end.
}, 15_000)

test('a live service is told apart from a file a dead one left behind', async () => {
  const b = await boot(fakeDevServers())
  expect(await serviceAlreadyRunning(b.home)).toBe(true)
  const file = readServiceFile(b.home)!
  // Same file, but its token is not the live one's: the health check fails, so it is not "already running".
  writeFileSync(serviceFilePath(b.home), JSON.stringify({ ...file, token: 'not-the-token' }))
  expect(await serviceAlreadyRunning(b.home)).toBe(false)
  rmSync(serviceFilePath(b.home))
  expect(await serviceAlreadyRunning(b.home)).toBe(false)
})
