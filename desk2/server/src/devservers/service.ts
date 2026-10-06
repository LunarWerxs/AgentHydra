// The dev-servers service: `bun service.ts --home <deskHome> [--desk-port N] [--desk-pid N]`. AgentHydra's own code
// run as its own hidden process (Desk starts it outside its tree, client.ts), so ending it ends the dev servers it
// started and never AgentHydra, and a Desk restart leaves it and them running. It has no window, tray, updater or
// data dir of its own: its files are in <home>/devservers/ and its console output is appended to
// <home>/logs/devservers.log (a process started through WMI has no stdout to redirect).
//
// It listens on 127.0.0.1 on a port the OS picks, behind a random token; service.json (ServiceFile) says where and
// how to ask, and is written only once it listens. Every request needs `authorization: Bearer <token>`. The routes
// are the ones the servers pane was built on, answered by the manager (manager.ts); Desk forwards /dw/api/<rest> to
// /api/<rest> one to one.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { projectForCwd } from '@shared/devwebui'
import { Localhost, type LocalhostDeps } from '../localhost/servers'
import { pidAlive } from '../host/launch'
import { type DevServers, DevServerError, type ServiceFile } from './contract'
import { serviceStamp } from './stamp'

export const devServersDir = (home: string): string => join(home, 'devservers')
export const serviceFilePath = (home: string): string => join(devServersDir(home), 'service.json')
export const resumeFilePath = (home: string): string => join(devServersDir(home), 'resume.json')
export const serviceLogPath = (home: string): string => join(home, 'logs', 'devservers.log')

/** service.json as it is on disk, or null when it is missing or not one. */
export function readServiceFile(home: string): ServiceFile | null {
  try {
    const f = JSON.parse(readFileSync(serviceFilePath(home), 'utf8')) as Partial<ServiceFile>
    const good = typeof f.pid === 'number' && typeof f.port === 'number' && typeof f.token === 'string' && typeof f.stamp === 'string'
    return good ? (f as ServiceFile) : null
  } catch {
    return null
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
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
  app.onError((err, c) => {
    if (err instanceof DevServerError) return c.json({ error: err.message }, err.status)
    console.error('[devservers]', err)
    return c.json({ error: err instanceof Error ? err.message || String(err) : String(err) }, 500)
  })
  app.use('*', async (c, next) => {
    const given = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? ''
    if (!sameToken(given, token)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  const body = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> => {
    const parsed = await c.req.json().catch(() => null)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  }
  const text = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.trim() === '') throw new DevServerError(`${what} is required`, 400)
    return v
  }

  app.get('/health', (c) => c.json({ ok: true, pid: process.pid, stamp, running: dev.runningIds().length }))

  app.get('/api/projects', async (c) => c.json(await dev.listProjects()))
  app.get('/api/processes/:id', async (c) => {
    const proc = await dev.process(c.req.param('id'))
    if (!proc) throw new DevServerError(`no server ${c.req.param('id')}`, 404)
    return c.json(proc)
  })
  app.post('/api/processes/:id/start', async (c) => c.json(await dev.start(c.req.param('id'))))
  app.post('/api/processes/:id/stop', async (c) => c.json(await dev.stop(c.req.param('id'))))
  app.post('/api/processes/:id/restart', async (c) => c.json(await dev.restart(c.req.param('id'))))
  app.get('/api/processes/:id/logs', async (c) => c.json({ id: c.req.param('id'), lines: await dev.logs(c.req.param('id')) }))
  app.post('/api/projects/:id/start', async (c) => c.json(await dev.startProject(c.req.param('id'))))
  app.post('/api/projects/:id/stop', async (c) => c.json(await dev.stopProject(c.req.param('id'))))
  app.post('/api/projects/load', async (c) => c.json(await dev.load(text((await body(c)).path, 'path'))))
  app.post('/api/projects/scaffold', async (c) => {
    const b = await body(c)
    if (!b.project || typeof b.project !== 'object') throw new DevServerError('project is required', 400)
    return c.json(await dev.scaffold(text(b.dir, 'dir'), text(b.fileName, 'fileName'), b.project as Parameters<DevServers['scaffold']>[2]))
  })
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

  let finishing: Promise<void> | null = null
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const shutdown = (restart = false): Promise<void> => {
    finishing ??= (async () => {
      try {
        // A restart records what ran so the next service starts it again; a plain stop must not bring it back.
        if (restart) writeJsonAtomic(resumeFilePath(home), { ids: dev.runningIds() })
        else rmSync(resumeFilePath(home), { force: true })
        await dev.stopAll()
      } catch (err) {
        console.error('[devservers] stopping the servers failed:', err)
      }
      if (readServiceFile(home)?.pid === process.pid) rmSync(serviceFilePath(home), { force: true })
      server.stop(true)
      exit(0)
      settle()
    })()
    return finishing
  }
  app.post('/api/shutdown', async (c) => {
    const restart = (await body(c)).restart === true
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

/** Appends everything the process prints to `file`, one timestamped line each. */
export function logConsoleTo(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const write = (level: string, args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${line}\n`)
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
  if (await serviceAlreadyRunning(home)) {
    console.log('[devservers] a service already runs for this home; exiting')
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
}

if (import.meta.main) await main()
