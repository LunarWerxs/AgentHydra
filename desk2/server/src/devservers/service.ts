// The dev-servers service: `bun service.ts --home <deskHome> [--desk-port N] [--desk-pid N]`. AgentHydra's own code
// run as its own hidden process (Desk starts it outside its tree, client.ts), so ending it ends the dev servers it
// started and never AgentHydra, and a Desk restart leaves it and them running. It has no window, tray, updater or
// data dir of its own: its files are in <home>/devservers/ and its console output is appended to
// <home>/logs/devservers.log (a process started through WMI has no stdout to redirect).
//
// It listens on 127.0.0.1 on a port the OS picks, behind a random token; service.json (ServiceFile) says where and
// how to ask, and is written only once it listens; service.lock (its pid) keeps a second one from starting for the same
// home meanwhile. Every request needs `authorization: Bearer <token>`. The routes
// are the ones the servers pane was built on, answered by the manager (manager.ts); Desk forwards /dw/api/<rest> to
// /api/<rest> one to one.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { renameOver } from '../write-flushed'
import { tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { type Context, Hono } from 'hono'
import { type DevWebAlertRuleInput, type DevWebProcessSpec, type DevWebScanPreset, type DevWebSettings, projectForCwd } from '@shared/devwebui'
import { Localhost, type LocalhostDeps } from '../localhost/servers'
import { pidAlive } from '../host/launch'
import { type DevServers, DevServerError, type ServiceFile } from './contract'
import { serviceStamp } from './stamp'

export const devServersDir = (home: string): string => join(home, 'devservers')
export const serviceFilePath = (home: string): string => join(devServersDir(home), 'service.json')
export const resumeFilePath = (home: string): string => join(devServersDir(home), 'resume.json')
export const serviceLockPath = (home: string): string => join(devServersDir(home), 'service.lock')
/** How long a new service waits for one that holds the lock (starting, or stopping) to answer or go. */
const LOCK_WAIT_MS = 15_000
export const serviceLogPath = (home: string): string => join(home, 'logs', 'devservers.log')

/** The last read of each service.json, kept until the file's mtime or size moves (Desk reads it on every request). */
const serviceFileCache = new Map<string, { mtimeMs: number; size: number; value: ServiceFile | null }>()

/** service.json as it is on disk, or null when it is missing or not one. */
export function readServiceFile(home: string): ServiceFile | null {
  const path = serviceFilePath(home)
  try {
    const st = statSync(path)
    const hit = serviceFileCache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
    const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceFile>
    const good = typeof f.pid === 'number' && typeof f.port === 'number' && typeof f.token === 'string' && typeof f.stamp === 'string'
    const value = good ? (f as ServiceFile) : null
    serviceFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value })
    return value
  } catch {
    serviceFileCache.delete(path)
    return null
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameOver(tmp, path)
}

const sameToken = (given: string, token: string): boolean => {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ServiceOptions {
  /** Desk's data home. */
  home: string
  devServers: DevServers
  /** The hash of this source (default: computed now). */
  stamp?: string
  /** The localhost list's scan and probe (tests give fakes); `owned` is the manager's plus the service itself. */
  localhost?: Omit<LocalhostDeps, 'owned'>
  /** Ends the process once everything is stopped (default process.exit; tests record the code). */
  exit?: (code: number) => void
}

export interface RunningService {
  file: ServiceFile
  /** Settles once a shutdown has stopped everything and called `exit`. */
  done: Promise<void>
  /** What POST /api/shutdown does, from inside: stop every server it started, remove service.json, exit. */
  shutdown(restart?: boolean): Promise<void>
}

/** True when a live service already answers for this home (its pid answers /health with its own token). */
export async function serviceAlreadyRunning(home: string): Promise<boolean> {
  const file = readServiceFile(home)
  if (!file || !pidAlive(file.pid)) return false
  try {
    const res = await fetch(`http://127.0.0.1:${file.port}/health`, { headers: { authorization: `Bearer ${file.token}` }, signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { ok?: unknown; pid?: unknown }
    return res.ok && body.ok === true && body.pid === file.pid
  } catch {
    return false
  }
}

const lockHolder = (lock: string): number | null => {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Makes this process the one service of `home` for its whole life (service.json alone cannot: it is written only once
 * the service listens). Refused while a live service answers, or while the process holding the lock (one starting or
 * stopping) is alive after `waitMs`. A lock left by a dead process, or from before the last boot, is taken over. The
 * lock goes when this process exits.
 */
export async function takeServiceLock(home: string, waitMs = LOCK_WAIT_MS): Promise<{ ok: true } | { ok: false; why: string }> {
  const lock = serviceLockPath(home)
  mkdirSync(devServersDir(home), { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    if (await serviceAlreadyRunning(home)) return { ok: false, why: 'a service already runs for this home' }
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      process.on('exit', () => {
        if (lockHolder(lock) === process.pid) rmSync(lock, { force: true })
      })
      return { ok: true }
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err
    }
    const holder = lockHolder(lock)
    if (holder === process.pid) return { ok: true }
    let bornBeforeBoot = false
    try {
      bornBeforeBoot = statSync(lock).mtimeMs < Date.now() - uptime() * 1000
    } catch {
      // floor-ok: a lock that went meanwhile is tried again at once
    }
    if (holder === null || !pidAlive(holder) || bornBeforeBoot) {
      rmSync(lock, { force: true })
      continue
    }
    if (Date.now() >= deadline) return { ok: false, why: `another dev-servers service (pid ${holder}) holds ${lock} and does not answer` }
    await Bun.sleep(200)
  }
}

export async function startService(o: ServiceOptions): Promise<RunningService> {
  const { home, devServers: dev } = o
  const stamp = o.stamp ?? serviceStamp()
  const token = randomBytes(24).toString('hex')
  const exit = o.exit ?? ((code: number) => process.exit(code))
  let ownPort = 0
  const localhost = new Localhost({
    ...o.localhost,
    owned: async () => {
      const mine = await dev.owned()
      return { ports: [...mine.ports, ownPort], pids: [...mine.pids, process.pid] }
    }
  })

  const app = new Hono()
  app.onError(answerError)
  app.use('*', async (c, next) => {
    const given = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? ''
    if (!sameToken(given, token)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })
  // Once a shutdown is asked for, no new work: a server started now would outlive the service with nobody to stop it,
  // and /health stops saying ok so Desk starts the next service instead of sending more here.
  let closing = false
  app.use('/api/*', async (c, next) => {
    if (closing && c.req.path !== '/api/shutdown') return c.json({ error: 'the dev-servers service is stopping' }, 503)
    await next()
  })

  app.get('/health', (c) => c.json({ ok: !closing, pid: process.pid, stamp, running: dev.runningIds().length }))
  processRoutes(app, dev)
  projectRoutes(app, dev)
  foundRoutes(app, dev)
  errorAndAlertRoutes(app, dev)
  chatRoutes(app, dev, localhost)

  const { promise: done, resolve: settle } = Promise.withResolvers<void>()
  let finishing: Promise<void> | null = null
  const shutdown = (restart = false): Promise<void> => {
    closing = true
    finishing ??= finish(home, dev, restart).then(() => {
      server.stop(true)
      exit(0)
      settle()
    })
    return finishing
  }
  app.post('/api/shutdown', async (c) => {
    const restart = (await body(c)).restart === true
    closing = true
    // Answer first: the server is closed once the stop is done.
    setTimeout(() => void shutdown(restart), 20)
    return c.json({ ok: true })
  })

  // 255 s is Bun's longest idle timeout: an ensure that waits for a slow dev server is one request.
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 255, fetch: app.fetch })
  ownPort = server.port as number
  const file: ServiceFile = { pid: process.pid, port: ownPort, token, startedAt: Date.now(), stamp }
  writeJsonAtomic(serviceFilePath(home), file)
  return { file, done, shutdown }
}

/** Stops every server (a restart first notes what ran) and removes service.json when it is this process's. */
async function finish(home: string, dev: DevServers, restart: boolean): Promise<void> {
  try {
    // A restart records what ran so the next service starts it again; a plain stop must not bring it back.
    if (restart) writeJsonAtomic(resumeFilePath(home), { ids: dev.runningIds() })
    else rmSync(resumeFilePath(home), { force: true })
    await dev.stopAll()
  } catch (err) {
    console.error('[devservers] stopping the servers failed:', err)
  }
  if (readServiceFile(home)?.pid === process.pid) rmSync(serviceFilePath(home), { force: true })
}

function answerError(err: Error, c: Context): Response {
  if (err instanceof DevServerError) return c.json({ error: err.message }, err.status)
  console.error('[devservers]', err)
  return c.json({ error: err instanceof Error ? err.message || String(err) : String(err) }, 500)
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new DevServerError(`${what} is required`, 400)
  return v
}

/** A query number: absent is undefined; anything but a whole number from 0 up is refused. */
function whole(v: string | undefined, what: string): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new DevServerError(`${what} must be a whole number`, 400)
  return n
}

function flagOn(b: Record<string, unknown>): boolean {
  if (typeof b.on !== 'boolean') throw new DevServerError('on must be true or false', 400)
  return b.on
}

function specOf(b: Record<string, unknown>): DevWebProcessSpec {
  if (!b.spec || typeof b.spec !== 'object' || Array.isArray(b.spec)) throw new DevServerError('spec is required', 400)
  return b.spec as DevWebProcessSpec
}

const queryPath = (c: { req: { query(k: string): string | undefined } }): string => text(c.req.query('path'), 'path')

/** A line or column number: absent is undefined; anything but a whole number from 1 is refused. */
function from1(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new DevServerError(`${what} must be a whole number from 1`, 400)
  return v
}

function positiveNumber(v: unknown, what: string, floor: 'above 0' | 'from 0'): number {
  const ok = typeof v === 'number' && Number.isFinite(v) && (floor === 'above 0' ? v > 0 : v >= 0)
  if (!ok) throw new DevServerError(`${what} must be a number ${floor}`, 400)
  return v as number
}

function alertInput(b: Record<string, unknown>, partial: boolean): Partial<DevWebAlertRuleInput> {
  const out: Partial<DevWebAlertRuleInput> = {}
  if (b.processId !== undefined || !partial) out.processId = text(b.processId, 'processId')
  if (b.metric !== undefined || !partial) {
    if (b.metric !== 'cpu' && b.metric !== 'memory') throw new DevServerError('metric must be cpu or memory', 400)
    out.metric = b.metric
  }
  if (b.threshold !== undefined || !partial) out.threshold = positiveNumber(b.threshold, 'threshold', 'above 0')
  if (b.forMs !== undefined || !partial) out.forMs = positiveNumber(b.forMs, 'forMs', 'from 0')
  if (b.enabled !== undefined) out.enabled = flagOn({ on: b.enabled })
  return out
}

async function logsRoute(c: Context, dev: DevServers): Promise<Response> {
  const id = c.req.param('id') ?? ''
  const before = c.req.query('before')
  const limit = c.req.query('limit')
  if (before === undefined && limit === undefined) return c.json({ id, lines: await dev.logs(id) })
  return c.json({ id, ...(await dev.logPage(id, { before: whole(before, 'before'), limit: whole(limit, 'limit') })) })
}

function processRoutes(app: Hono, dev: DevServers): void {
  app.get('/api/processes/:id', async (c) => {
    const proc = await dev.process(c.req.param('id'))
    if (!proc) throw new DevServerError(`no server ${c.req.param('id')}`, 404)
    return c.json(proc)
  })
  app.post('/api/processes/:id/start', async (c) => c.json(await dev.start(c.req.param('id'))))
  app.post('/api/processes/:id/stop', async (c) => c.json(await dev.stop(c.req.param('id'))))
  app.post('/api/processes/:id/restart', async (c) => c.json(await dev.restart(c.req.param('id'))))
  app.get('/api/processes/:id/logs', (c) => logsRoute(c, dev))
  app.put('/api/processes/:id', async (c) => c.json(await dev.updateProcess(c.req.param('id'), specOf(await body(c)))))
  app.delete('/api/processes/:id', async (c) => c.json(await dev.removeProcess(c.req.param('id'))))
  app.get('/api/processes/:id/config', async (c) => c.json(await dev.processConfig(c.req.param('id'))))
  app.get('/api/processes/:id/metrics', async (c) => c.json(await dev.metricsHistory(c.req.param('id'))))
  app.post('/api/processes/:id/starred', async (c) => c.json(await dev.setStarred(c.req.param('id'), flagOn(await body(c)))))
  app.post('/api/processes/:id/enabled', async (c) => c.json(await dev.setProcessEnabled(c.req.param('id'), flagOn(await body(c)))))
  app.post('/api/processes/:id/free-port', async (c) => {
    const b = await body(c)
    // The pids the person saw and confirmed; no list asks who holds the port first.
    if (b.pids !== undefined && (!Array.isArray(b.pids) || b.pids.some((p) => !Number.isInteger(p) || (p as number) <= 0))) throw new DevServerError('pids must be a list of positive whole numbers', 400)
    return c.json(await dev.freePort(c.req.param('id'), b.pids as number[] | undefined))
  })
  app.post('/api/start-all', async (c) => c.json(await dev.startAllServers()))
  app.post('/api/stop-all', async (c) => c.json(await dev.stopAllServers()))
}

function projectRoutes(app: Hono, dev: DevServers): void {
  app.get('/api/projects', async (c) => c.json(await dev.listProjects()))
  app.post('/api/projects/:id/start', async (c) => c.json(await dev.startProject(c.req.param('id'))))
  app.post('/api/projects/:id/stop', async (c) => c.json(await dev.stopProject(c.req.param('id'))))
  app.post('/api/projects/load', async (c) => c.json(await dev.load(text((await body(c)).path, 'path'))))
  app.post('/api/projects/scaffold', async (c) => {
    const b = await body(c)
    if (!b.project || typeof b.project !== 'object') throw new DevServerError('project is required', 400)
    return c.json(await dev.scaffold(text(b.dir, 'dir'), text(b.fileName, 'fileName'), b.project as Parameters<DevServers['scaffold']>[2]))
  })
  app.get('/api/projects/clone-dest', async (c) => c.json(await dev.cloneDest(text(c.req.query('url'), 'url'))))
  app.post('/api/projects/clone', async (c) => {
    const b = await body(c)
    return c.json(await dev.clone(text(b.url, 'url'), text(b.dest, 'dest')))
  })
  app.patch('/api/projects/:id', async (c) => {
    const b = await body(c)
    if (b.name !== undefined) text(b.name, 'name')
    if (b.color !== undefined && b.color !== null && typeof b.color !== 'string') throw new DevServerError('color must be text', 400)
    return c.json(await dev.updateProject(c.req.param('id'), { name: b.name as string | undefined, color: b.color as string | null | undefined }))
  })
  app.delete('/api/projects/:id', async (c) => c.json(await dev.removeProject(c.req.param('id'))))
  app.post('/api/projects/:id/enabled', async (c) => c.json(await dev.setProjectEnabled(c.req.param('id'), flagOn(await body(c)))))
  app.post('/api/projects/:id/processes', async (c) => c.json(await dev.addProcess(c.req.param('id'), specOf(await body(c)))))
  app.get('/api/projects/:id/takeover', async (c) => c.json(await dev.takeover(c.req.param('id'))))
  app.post('/api/projects/:id/takeover', async (c) => c.json(await dev.takeOver(c.req.param('id'))))
  app.post('/api/projects/:id/takeover/restore', async (c) => c.json(await dev.restoreTakeover(c.req.param('id'))))
}

function foundRoutes(app: Hono, dev: DevServers): void {
  app.get('/api/found', async (c) => c.json(await dev.found()))
  app.post('/api/scan', async (c) => {
    const b = await body(c)
    const presets = ['startup', 'quick', 'deep', 'scoped']
    if (typeof b.preset !== 'string' || !presets.includes(b.preset)) throw new DevServerError('preset must be startup, quick, deep or scoped', 400)
    if (b.roots !== undefined && (!Array.isArray(b.roots) || b.roots.some((r) => typeof r !== 'string' || r.trim() === ''))) throw new DevServerError('roots must be a list of folders', 400)
    return c.json(await dev.scan({ preset: b.preset as DevWebScanPreset, roots: b.roots as string[] | undefined }))
  })
  app.post('/api/found/forget', async (c) => c.json(await dev.forgetFound()))
  app.get('/api/preview', async (c) => c.json(await dev.preview(queryPath(c))))
  app.get('/api/ignored', async (c) => c.json(await dev.ignored()))
  app.post('/api/ignored', async (c) => c.json(await dev.ignore(text((await body(c)).path, 'path'))))
  app.delete('/api/ignored', async (c) => c.json(await dev.unignore(queryPath(c))))
  app.get('/api/settings', async (c) => c.json(await dev.settings()))
  app.patch('/api/settings', async (c) => c.json(await dev.saveSettings(await body(c) as Partial<DevWebSettings>)))
  app.post('/api/settings/restart-running', async (c) => c.json(await dev.restartRunning()))
}

function errorAndAlertRoutes(app: Hono, dev: DevServers): void {
  app.get('/api/errors', async (c) => c.json(await dev.errors(c.req.query('process') || undefined)))
  app.post('/api/errors/dismiss', async (c) => c.json(await dev.dismissError(text((await body(c)).fingerprint, 'fingerprint'))))
  app.post('/api/errors/clear', async (c) => {
    const b = await body(c)
    if (b.process !== undefined && typeof b.process !== 'string') throw new DevServerError('process must be a server id', 400)
    return c.json(await dev.clearErrors((b.process as string | undefined) || undefined))
  })
  app.post('/api/open-in-editor', async (c) => {
    const b = await body(c)
    if (b.processId !== undefined && typeof b.processId !== 'string') throw new DevServerError('processId must be a server id', 400)
    return c.json(await dev.openInEditor({ file: text(b.file, 'file'), line: from1(b.line, 'line'), column: from1(b.column, 'column'), processId: b.processId as string | undefined }))
  })
  app.get('/api/alerts', async (c) => c.json(await dev.alerts()))
  app.post('/api/alerts', async (c) => c.json(await dev.addAlert(alertInput(await body(c), false) as DevWebAlertRuleInput)))
  app.patch('/api/alerts/:id', async (c) => c.json(await dev.updateAlert(c.req.param('id'), alertInput(await body(c), true))))
  app.delete('/api/alerts/:id', async (c) => c.json(await dev.removeAlert(c.req.param('id'))))
  app.post('/api/alerts/events/clear', async (c) => c.json(await dev.clearAlertEvents()))
}

/** What a chat's tools and the localhost list read. */
function chatRoutes(app: Hono, dev: DevServers, localhost: Localhost): void {
  app.post('/api/folder', async (c) => c.json(await dev.folder(text((await body(c)).cwd, 'cwd'))))
  app.post('/api/ensure', async (c) => {
    const b = await body(c)
    const server = typeof b.server === 'string' && b.server.trim() !== '' ? b.server : undefined
    return c.json(await dev.ensure(text(b.cwd, 'cwd'), server, typeof b.wait === 'boolean' ? b.wait : undefined))
  })
  app.get('/api/servers', async (c) => {
    const cwd = c.req.query('cwd')
    const all = c.req.query('all') === '1'
    const [projects, others] = await Promise.all([dev.listProjects(), localhost.list(false)])
    const project = cwd ? projectForCwd(projects, cwd) : null
    return c.json({ project, projects: all ? projects : project ? [project] : [], others: others.servers })
  })
  app.get('/api/owned', async (c) => c.json(await dev.owned()))
}

/** The log is moved to `<file>.1` (replacing the one before) once it grows past this. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/** Appends everything the process prints to `file`, one timestamped line each; one previous file is kept. */
export function logConsoleTo(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    // floor-ok: no log yet
  }
  const write = (level: string, args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')
    const entry = `${new Date().toISOString()} ${level} ${line}\n`
    if (size > LOG_MAX_BYTES) {
      // A rename that fails (the file held open elsewhere) is tried again after another LOG_MAX_BYTES.
      size = 0
      try {
        renameSync(file, `${file}.1`)
      } catch {
        // floor-ok: the lines go on into the same file
      }
    }
    try {
      appendFileSync(file, entry)
      size += Buffer.byteLength(entry)
    } catch {
      // floor-ok: a log that cannot be written must not stop the service
    }
  }
  console.log = (...a) => write('info', a)
  console.info = (...a) => write('info', a)
  console.warn = (...a) => write('warn', a)
  console.error = (...a) => write('error', a)
}

const flag = (name: string): string | null => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const home = flag('--home')
  if (!home) {
    console.error('usage: bun service.ts --home <deskHome>')
    process.exit(2)
  }
  logConsoleTo(serviceLogPath(home))
  const lock = await takeServiceLock(home)
  if (!lock.ok) {
    console.log(`[devservers] ${lock.why}; exiting`)
    process.exit(0)
  }
  const { createDevServers } = await import('./manager')
  const deskPort = Number(flag('--desk-port')) || undefined
  const deskPid = Number(flag('--desk-pid')) || undefined
  const dev = createDevServers({ home, deskPort, deskPid })
  // A crash must not leave the servers it started running with nobody to stop them.
  const crash = (err: unknown) => {
    console.error('[devservers] crashed:', err)
    try {
      dev.killAllSync()
    } finally {
      if (readServiceFile(home)?.pid === process.pid) rmSync(serviceFilePath(home), { force: true })
      process.exit(1)
    }
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)
  await dev.ready
  const service = await startService({ home, devServers: dev, localhost: { deskPort, deskPid } })
  console.log(`[devservers] service ${process.pid} listening on 127.0.0.1:${service.file.port}`)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void service.shutdown(false))
  // A throwaway home (a test's Desk under the temp folder) dies with its Desk: nothing will ever start that Desk again,
  // so its service would idle forever (six were found 2026-10-09). The real home outlives Desk restarts and is left alone.
  if (deskPid && isThrowawayHome(home)) {
    const watch = setInterval(() => {
      if (!pidAlive(deskPid)) {
        clearInterval(watch)
        console.log(`[devservers] desk ${deskPid} of throwaway home is gone; stopping`)
        void service.shutdown(false)
      }
    }, 30_000)
  }
}

/** True for a home under the OS temp folder, where only tests put a Desk. */
export const isThrowawayHome = (home: string): boolean => {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/'
  return norm(home).startsWith(norm(tmpdir()))
}

if (import.meta.main) await main()
