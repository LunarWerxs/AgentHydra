// Desk's side of the dev-servers service (service.ts): finds it, starts it when something asks, and talks to it.
//
// Found: <home>/devservers/service.json (its port and token) plus a GET /health that answers with that file's pid.
// Started: hidden and OUTSIDE Desk's process tree (host/launch.ts detachedCommand, the way chat hosts start), so a
// Desk restart leaves it and the servers it runs alone; one start at a time however many panes and chats ask, and
// Desk waits up to 20 s for it to answer. Desk never stops it when Desk stops: only `stop()` (Settings) ends it.
// Stale code: when the service's stamp differs from Desk's own (stamp.ts) and it runs no server, it is restarted
// before the next request is forwarded; with servers running it is left alone and status() says `stale`.
// The token goes only to the loopback service and is never returned or logged.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DevWebStatus } from '@shared/devwebui'
import { detachedCommand, killHostTree, pidAlive } from '../host/launch'
import type { ServiceFile } from './contract'
import { readServiceFile, serviceFilePath, serviceLogPath } from './service'
import { serviceStamp } from './stamp'

export const SERVICE_ENTRY = join(import.meta.dir, 'service.ts')
const START_WAIT_MS = 20_000
const HEALTH_MS = 1500
/** A service seen answering is taken as still answering this long (the pane polls every second or two). */
const KNOWN_MS = 4000
const STAMP_MS = 10_000

export interface ClientDeps {
  /** Desk's data home. */
  home: string
  /** Starts the service process and resolves once it was launched (default: hidden, outside this tree). */
  launch?: () => Promise<void> | void
  fetch?: typeof fetch
  now?: () => number
  /** Desk's own stamp (default stamp.ts serviceStamp). */
  stamp?: () => string
  /** Ends a process and its tree (default host/launch.ts killHostTree). */
  kill?: (pid: number) => void
  alive?: (pid: number) => boolean
  /** How long a start may take (default 20 s). */
  startWaitMs?: number
  /** How long a stop waits for the service's pid to go before it is killed (default 8 s). */
  stopWaitMs?: number
  /** Desk's own port, given to a new service so it never takes this window for a dev server. */
  deskPort?: number
}

export interface DevServicesClient {
  /** Where the service stands; never starts it. */
  status(): Promise<DevWebStatus>
  /** Brings it up when it is not (every caller at once shares the one start); never throws, `status` says how it went. */
  ensure(): Promise<DevWebStatus>
  /** Calls the service (`path` is its own, /api/...), starting it first when needed; one retry after a refused connection. */
  request(path: string, init?: RequestInit): Promise<Response>
  /** The service's answer to `path` only while it runs: null when it does not (never starts it). */
  peek(path: string): Promise<Response | null>
  /** Ends the service (and with it the servers it started): asks it, then kills its tree when it does not go. */
  stop(): Promise<DevWebStatus>
  /** Stops it with its running servers noted, and starts the new one (which starts them again). */
  restart(): Promise<DevWebStatus>
}

interface Live {
  file: ServiceFile
  stamp: string
  running: number
}

/** A connection that was refused: nothing listens there, so nothing of the request arrived. */
function isRefused(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ConnectionRefused' || code === 'ECONNREFUSED' || /refused|unable to connect/i.test(err instanceof Error ? err.message : String(err))
}

function lastLine(file: string): string | null {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    return lines.at(-1)?.slice(0, 300) ?? null
  } catch {
    return null
  }
}

async function launchReal(home: string, deskPort: number | undefined): Promise<void> {
  mkdirSync(join(home, 'logs'), { recursive: true })
  // The bun that runs Desk's own server (the daemon's exe in a release bundle), never a PATH lookup.
  const exe = process.execPath
  const args = [exe, SERVICE_ENTRY, '--home', home, '--desk-pid', String(process.pid)]
  if (deskPort) args.push('--desk-port', String(deskPort))
  // Everything the service needs is in its arguments: WMI starts it with the user's default environment, not Desk's.
  const plan = detachedCommand(process.platform, args)
  // The powershell is a console program (hidden); it exits once WMI has started the service.
  const child = spawn(plan.argv[0] as string, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true, detached: plan.detached })
  child.on('error', () => {}) // a failed start shows as no answer in time
  child.unref()
}

export function createDevServicesClient(deps: ClientDeps): DevServicesClient {
  const home = deps.home
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const stampOf = deps.stamp ?? serviceStamp
  const kill = deps.kill ?? killHostTree
  const alive = deps.alive ?? pidAlive
  const startWaitMs = deps.startWaitMs ?? START_WAIT_MS
  const stopWaitMs = deps.stopWaitMs ?? 8000
  const launch = deps.launch ?? (() => launchReal(home, deps.deskPort ?? (Number(process.env.HYDRA_DESK_PORT) || 7798)))

  let known: { live: Live; at: number } | null = null
  let pending: Promise<Live> | null = null
  let failure: string | null = null
  let stampCache: { value: string; at: number } | null = null

  const ownStamp = (): string => {
    if (!stampCache || now() - stampCache.at > STAMP_MS) stampCache = { value: stampOf(), at: now() }
    return stampCache.value
  }

  const call = (file: ServiceFile, path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${file.token}`)
    return doFetch(`http://127.0.0.1:${file.port}${path}`, { ...init, headers })
  }

  /** The service that answers right now (service.json plus /health naming its pid), or null. */
  const probe = async (): Promise<Live | null> => {
    const file = readServiceFile(home)
    // A file whose pid is gone was left by a dead service: whatever listens on its port now never gets the token.
    if (!file || !alive(file.pid)) return null
    try {
      const res = await call(file, '/health', { signal: AbortSignal.timeout(HEALTH_MS) })
      if (!res.ok) return null
      const b = (await res.json()) as { ok?: unknown; pid?: unknown; stamp?: unknown; running?: unknown }
      if (b.ok !== true || b.pid !== file.pid) return null
      return { file, stamp: typeof b.stamp === 'string' ? b.stamp : '', running: typeof b.running === 'number' ? b.running : 0 }
    } catch {
      return null
    }
  }

  const seen = async (): Promise<Live | null> => {
    if (known && now() - known.at < KNOWN_MS && readServiceFile(home)?.token === known.live.file.token) return known.live
    const live = await probe()
    known = live ? { live, at: now() } : null
    return live
  }

  /** Asks the service to end (`restart`: noting what ran), then waits for its pid to go and kills its tree if it stays. */
  const endService = async (live: Live, restart: boolean): Promise<void> => {
    known = null
    try {
      await call(live.file, '/api/shutdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ restart }),
        signal: AbortSignal.timeout(HEALTH_MS)
      })
    } catch {
      // floor-ok: a service that does not answer is ended below
    }
    const deadline = now() + stopWaitMs
    while (alive(live.file.pid) && now() < deadline) await Bun.sleep(100)
    if (alive(live.file.pid)) kill(live.file.pid)
    if (readServiceFile(home)?.pid === live.file.pid) rmSync(serviceFilePath(home), { force: true })
  }

  const startNew = async (): Promise<Live> => {
    failure = null
    try {
      await launch()
      const deadline = now() + startWaitMs
      for (;;) {
        const live = await probe()
        if (live) {
          known = { live, at: now() }
          return live
        }
        if (now() >= deadline) throw new Error(lastLine(serviceLogPath(home)) ?? `the dev-servers service did not answer within ${Math.round(startWaitMs / 1000)} s`)
        await Bun.sleep(150)
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  const bringUp = async (): Promise<Live> => {
    let live = await seen()
    if (live && live.stamp !== ownStamp() && live.running === 0) {
      await endService(live, false)
      live = null
    }
    return live ?? startNew()
  }

  /** One start at a time: every caller that comes while it runs gets the same one. */
  const ensureLive = (): Promise<Live> => {
    pending ??= bringUp().finally(() => {
      pending = null
    })
    return pending
  }

  const status = async (): Promise<DevWebStatus> => {
    if (pending) return { state: 'starting', pid: null }
    const live = await seen()
    if (live) return { state: 'running', pid: live.file.pid, running: live.running, ...(live.stamp !== ownStamp() ? { stale: true } : {}) }
    if (failure) return { state: 'failed', pid: null, reason: failure }
    return { state: 'stopped', pid: null }
  }

  const ensure = async (): Promise<DevWebStatus> => {
    try {
      await ensureLive()
    } catch {
      // floor-ok: the failure is in status()
    }
    return status()
  }

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const live = await ensureLive()
    try {
      return await call(live.file, path, init)
    } catch (err) {
      if (!isRefused(err)) throw err
      // service.json is there and nobody answers: it died. A new one, and the request once more.
      known = null
      return call((await ensureLive()).file, path, init)
    }
  }

  const peek = async (path: string): Promise<Response | null> => {
    const live = await seen()
    if (!live) return null
    try {
      return await call(live.file, path, { signal: AbortSignal.timeout(2000) })
    } catch {
      known = null
      return null
    }
  }

  const stop = async (): Promise<DevWebStatus> => {
    if (pending) await pending.catch(() => {})
    const live = await probe()
    if (live) await endService(live, false)
    failure = null
    return status()
  }

  const restart = async (): Promise<DevWebStatus> => {
    if (pending) await pending.catch(() => {})
    const live = await probe()
    if (live) await endService(live, true)
    return ensure()
  }

  return { status, ensure, request, peek, stop, restart }
}

const clients = new Map<string, DevServicesClient>()

/** The one client of this Desk home: the plugin and the connector share it, so they share one start at a time. */
export function devServicesClient(home: string): DevServicesClient {
  let c = clients.get(home)
  if (!c) {
    c = createDevServicesClient({ home })
    clients.set(home, c)
  }
  return c
}
