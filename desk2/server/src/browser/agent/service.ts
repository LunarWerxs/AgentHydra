// AgentHydra's hidden browser-tools service: one process per Desk home, started on demand by client.ts, answering the
// read-only browser tools over loopback HTTP. It is never stopped by Desk; POST /api/shutdown stops it.
//
//   <home>/browser-agent/service.json   { pid, port, token, startedAt, stamp }
//   <home>/browser-agent/service.lock   the running service's pid
//   <home>/logs/browser-agent.log       its log (no console window)

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REAL_HOME } from '../../real-home'
import { isThrowawayHome } from '../../devservers/service'
import { callTool, toolInfos } from './tools'
import type { CallResult, ToolCaller } from './contract'

export const STAMP = 'browser-agent-1'

export interface ServiceFile {
  pid: number
  port: number
  token: string
  startedAt: string
  stamp: string
}

export const agentDir = (home: string): string => join(home, 'browser-agent')
export const serviceFilePath = (home: string): string => join(agentDir(home), 'service.json')
export const serviceLockPath = (home: string): string => join(agentDir(home), 'service.lock')
export const serviceLogPath = (home: string): string => join(home, 'logs', 'browser-agent.log')

export function readServiceFile(home: string): ServiceFile | null {
  try {
    const f = JSON.parse(readFileSync(serviceFilePath(home), 'utf8')) as Partial<ServiceFile>
    if (typeof f.pid !== 'number' || typeof f.port !== 'number' || typeof f.token !== 'string') return null
    return { pid: f.pid, port: f.port, token: f.token, startedAt: String(f.startedAt ?? ''), stamp: String(f.stamp ?? '') }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes the single-service lock; a lock held by a live pid is refused, a stale one is replaced. */
export function takeServiceLock(home: string): boolean {
  mkdirSync(agentDir(home), { recursive: true })
  const path = serviceLockPath(home)
  const claim = (): boolean => {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }
  if (claim()) return true
  const holder = Number(readFileSync(path, 'utf8'))
  if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return false
  rmSync(path, { force: true })
  return claim()
}

function log(home: string, line: string): void {
  mkdirSync(join(home, 'logs'), { recursive: true })
  appendFileSync(serviceLogPath(home), `${new Date().toISOString()} ${line}\n`)
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  const want = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}

interface CallBody {
  name?: unknown
  params?: unknown
  caller?: unknown
}

export interface RunningService {
  file: ServiceFile
  stop(): void
}

/** Serves the tools on a fresh loopback port and writes service.json; the caller owns the lock. */
export function startService(home: string, onStop: () => void = () => {}): RunningService {
  const token = randomBytes(24).toString('hex')
  let server: ReturnType<typeof Bun.serve> | null = null
  const stop = (): void => {
    server?.stop(true)
    rmSync(serviceFilePath(home), { force: true })
    rmSync(serviceLockPath(home), { force: true })
    onStop()
  }
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 255,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, pid: process.pid, stamp: STAMP, running: true })
      }
      if (!authorized(req, token)) return json({ ok: false, error: 'unauthorized' }, 401)
      if (req.method === 'GET' && url.pathname === '/api/tools') return json({ tools: toolInfos() })
      if (req.method === 'POST' && url.pathname === '/api/call') {
        const body = (await req.json().catch(() => ({}))) as CallBody
        if (typeof body.name !== 'string') return json({ ok: false, status: 400, error: 'name is required' } satisfies CallResult, 400)
        const params = typeof body.params === 'object' && body.params !== null ? (body.params as Record<string, unknown>) : {}
        const caller = typeof body.caller === 'object' && body.caller !== null ? (body.caller as ToolCaller) : {}
        const result = await callTool(body.name, params, caller)
        return json(result, result.ok ? 200 : result.status)
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        setTimeout(stop, 20)
        return json({ ok: true })
      }
      return json({ ok: false, error: 'not found' }, 404)
    },
  })
  if (server.port === undefined) throw new Error('the browser tools service has no port')
  const file: ServiceFile = {
    pid: process.pid,
    port: server.port,
    token,
    startedAt: new Date().toISOString(),
    stamp: STAMP,
  }
  mkdirSync(agentDir(home), { recursive: true })
  writeFileSync(serviceFilePath(home), JSON.stringify(file), 'utf8')
  log(home, `listening on 127.0.0.1:${file.port} (pid ${process.pid})`)
  return { file, stop }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const home = argValue(argv, '--home') || process.env.HYDRA_DESK_HOME || REAL_HOME
  const store = argValue(argv, '--store')
  if (store) process.env.HYDRA_DESK_BROWSER_STORE = store
  if (!takeServiceLock(home)) {
    log(home, 'another browser-agent holds the lock; exiting')
    return
  }
  const deskPid = Number(argValue(argv, '--desk-pid'))
  const running = startService(home, () => process.exit(0))
  // A throwaway home (a test's) stops with the Desk that started it; the real home outlives Desk restarts.
  if (Number.isInteger(deskPid) && deskPid > 0 && isThrowawayHome(home)) {
    const watch = setInterval(() => {
      if (!pidAlive(deskPid)) {
        clearInterval(watch)
        running.stop()
      }
    }, 30_000)
  }
}

if (import.meta.main) await main()
