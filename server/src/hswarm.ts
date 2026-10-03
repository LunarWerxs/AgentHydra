/**
 * HydraSwarm sidecar management.
 *
 * Starts, restarts with backoff, and stops the hswarm Python sidecar that the daemon exposes
 * through a proxy at /api/hswarm/*. Driven by a daemon setting and integrated into the boot
 * and shutdown sequence.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT, appEnv, DATA_DIR } from './config'
import { killProcessTree } from './core/process'

/** Default port hswarm listens on. */
const DEFAULT_HSWARM_PORT = 7793

const LOG_MAX_BYTES = 5 * 1024 * 1024

const hasPackage = (d: string) => existsSync(join(d, 'hswarm', '__init__.py'))

/** Where the `hswarm` package lives. `AGENTHYDRA_HSWARM_DIR` when set (and only it: a wrong
 *  override is reported, not quietly replaced), else the app root, then one level up (compiled dist/). */
export function hswarmDir(env: NodeJS.ProcessEnv = process.env, appRoot = APP_ROOT): string | null {
  const override = env.AGENTHYDRA_HSWARM_DIR?.trim()
  if (override) return hasPackage(override) ? override : null
  return [appRoot, join(appRoot, '..')].find(hasPackage) ?? null
}

/** hswarm's state dir; the sidecar and the proxy must agree on it (the console token lives here). */
export function hswarmHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HSWARM_HOME?.trim() || join(homedir(), '.hswarm')
}

/** Open `<logDir>/hswarm.log` for append, rotating one generation past 5 MiB first. */
export function openHSwarmLog(logDir: string, maxBytes = LOG_MAX_BYTES): number {
  mkdirSync(logDir, { recursive: true })
  const file = join(logDir, 'hswarm.log')
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
  } catch {
    // no log yet
  }
  return openSync(file, 'a')
}

/** The port hswarm should listen on. `HSWARM_PORT` env var or default. */
function hswarmPort(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.HSWARM_PORT?.trim()
  if (override && /^\d+$/.test(override)) return parseInt(override, 10)
  return DEFAULT_HSWARM_PORT
}

/** The interpreter. `python` on Windows; `python3` on Unix. `AGENTHYDRA_PYTHON` names a specific binary. */
function pythonBinary(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AGENTHYDRA_PYTHON?.trim()
  if (override) return override
  return platform === 'win32' ? 'python' : 'python3'
}

/** Probe GET http://127.0.0.1:<port>/health and return the parsed response, or null if not hswarm. */
async function probeHSwarm(port: number, timeoutMs = 500): Promise<Record<string, unknown> | null> {
  const url = `http://127.0.0.1:${port}/health`
  try {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: abortController.signal })
      if (response.status === 200) {
        const data: unknown = await response.json()
        if (
          typeof data === 'object' &&
          data !== null &&
          (data as Record<string, unknown>)['hswarm'] === true
        ) {
          return data as Record<string, unknown>
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // connection failed, timeout, or invalid JSON
  }
  return null
}

/** Everything startHSwarm can be handed; tests inject spawn, probe and watchEveryMs to stay off the real port. */
interface HSwarmDeps {
  enabled?: boolean
  dir?: string
  python?: string
  port?: number
  logDir?: string
  env?: NodeJS.ProcessEnv
  spawn?: typeof Bun.spawn
  /** Spawns the ZSwarm import (tests pass a fake). */
  importSpawn?: typeof Bun.spawn
  probe?: (port: number) => Promise<Record<string, unknown> | null>
  watchEveryMs?: number
}

interface HSwarmState {
  running: boolean
  port: number | null
  pid: number | null
  lastError: string | null
}

let state: HSwarmState = {
  running: false,
  port: null,
  pid: null,
  lastError: null,
}

let proc: ReturnType<typeof Bun.spawn> | null = null
let stopRequested = false
/** Close one spawn's log handle. Each handle is closed exactly once, by the spawn that opened it
 *  (its exit handler, or its own failed start): a second close could hit a reused fd number. */
function closeLog(fd: number): void {
  if (fd < 0) return
  try {
    closeSync(fd)
  } catch (e) {
    console.error('[hswarm] closing the log failed:', e instanceof Error ? e.message : String(e))
  }
}

/** Backoff: start with a 1s delay, cap at 30s. */
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
let backoffMs = MIN_BACKOFF_MS

/** How often an adopted server's /health is looked at again. */
const ADOPT_WATCH_MS = 15_000
let adoptTimer: ReturnType<typeof setTimeout> | null = null
function clearAdoptTimer(): void {
  if (adoptTimer) clearTimeout(adoptTimer)
  adoptTimer = null
}

/** An adopted server is not our child, so nothing tells us it died: look at /health on an interval and, when
 *  it stops answering, clear the state and start again (which spawns our own supervised child). */
function watchAdopted(deps: HSwarmDeps, port: number): void {
  clearAdoptTimer()
  adoptTimer = setTimeout(async () => {
    adoptTimer = null
    if (stopRequested || !state.running || proc) return
    const live = await (deps.probe ?? probeHSwarm)(port)
    if (stopRequested || !state.running || proc) return
    if (live?.hswarm === true) {
      watchAdopted(deps, port)
      return
    }
    console.log(`[hswarm] adopted server on port ${port} stopped answering; starting our own`)
    state.running = false
    state.pid = null
    state.lastError = 'adopted server stopped answering'
    void startHSwarm(deps)
  }, deps.watchEveryMs ?? ADOPT_WATCH_MS)
}

/**
 * Start hswarm if enabled and not running. Restarts with exponential backoff on crash.
 * Logging goes to a file under the daemon's data dir, resolved lazily.
 */
export async function startHSwarm(deps: HSwarmDeps = {}): Promise<void> {
  if (stopRequested) return

  const enabled = deps.enabled ?? appEnv('HSWARM_ENABLED')?.trim() !== '0'
  if (!enabled) {
    state.lastError = 'hswarm is disabled'
    return
  }

  const dir = deps.dir ?? hswarmDir(deps.env)
  if (!dir) {
    const override = (deps.env ?? process.env).AGENTHYDRA_HSWARM_DIR?.trim()
    state.lastError = override
      ? `AGENTHYDRA_HSWARM_DIR=${override} has no hswarm/__init__.py`
      : 'hswarm package not found (no hswarm/__init__.py beside the app)'
    console.log(`[hswarm] ${state.lastError}; sidecar not started`)
    return
  }
  console.log(`[hswarm] using package folder ${dir}`)
  const port = deps.port ?? hswarmPort(deps.env)
  const python = deps.python ?? pythonBinary(deps.env)

  // Check if hswarm package exists
  const initPy = join(dir, 'hswarm', '__init__.py')
  if (!existsSync(initPy)) {
    state.lastError = `hswarm package not found at ${dir}/hswarm/__init__.py`
    return
  }

  if (state.running && state.pid) return

  // Probe for an existing live hswarm before starting a competitor
  const liveHSwarm = await (deps.probe ?? probeHSwarm)(port)
  if (liveHSwarm?.hswarm === true && typeof liveHSwarm.pid === 'number') {
    state.running = true
    state.pid = liveHSwarm.pid
    state.port = port
    state.lastError = null
    backoffMs = MIN_BACKOFF_MS
    console.log(`[hswarm] adopting existing server on port ${port} with pid ${liveHSwarm.pid}`)
    watchAdopted(deps, port)
    return
  }

  let fd = -1
  try {
    fd = openHSwarmLog(deps.logDir ?? join(DATA_DIR, 'logs'))
    const spawnFn = deps.spawn ?? Bun.spawn

    // The shared server itself, in the foreground: `hswarm ui` only starts it detached and exits,
    // which read as a crash here and restarted it forever.
    const command = [python, '-m', 'hswarm', 'mcp', '--http', '--port', String(port)]

    const env: NodeJS.ProcessEnv = {
      ...(deps.env ?? process.env),
      HSWARM_PORT: String(port),
      HSWARM_HOME: hswarmHome(deps.env),
      HSWARM_SUPERVISED: '1',
      PYTHONUNBUFFERED: '1',
    }

    proc = spawnFn(command, {
      cwd: dir,
      stdout: fd,
      stderr: fd,
      stdin: 'ignore',
      windowsHide: true,
      env,
    })

    state.running = true
    state.pid = proc.pid ?? null
    state.port = port
    state.lastError = null
    backoffMs = MIN_BACKOFF_MS
    startZswarmImport({ python, dir, env, spawn: deps.importSpawn })

    // Watch for crash and restart with backoff
    proc.exited
      .finally(() => closeLog(fd))
      .then(() => {
        if (!stopRequested && state.running) {
          state.running = false
          state.pid = null
          state.lastError = 'process exited'
          scheduleRestart(deps)
        }
      })
      .catch((e) => {
        // A failure in the restart path would otherwise leave hswarm down with no reason shown.
        state.lastError = `restart failed: ${e instanceof Error ? e.message : String(e)}`
        console.error('[hswarm]', state.lastError)
      })
  } catch (e) {
    closeLog(fd)
    state.running = false
    state.pid = null
    state.lastError = e instanceof Error ? e.message : String(e)
    scheduleRestart(deps)
  }
}

function scheduleRestart(deps: HSwarmDeps): void {
  if (stopRequested) return
  const delay = Math.min(backoffMs, MAX_BACKOFF_MS)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  setTimeout(() => startHSwarm(deps), delay)
}

const ZSWARM_IMPORT_FIRST_MS = 30_000
const ZSWARM_IMPORT_EVERY_MS = 60 * 60 * 1000
let importTimer: ReturnType<typeof setTimeout> | null = null
let importRunning = false

/** The counts-only log line for one `import-zswarm --json` result. */
function importSummary(stdout: string): string {
  try {
    const counts = JSON.parse(stdout).counts as Record<string, Record<string, unknown>>
    let read = 0
    let added = 0
    const add = (c: Record<string, unknown>) => {
      read += Number(c.read) || 0
      added += Number(c.added) || 0
    }
    for (const [kind, c] of Object.entries(counts)) {
      if (kind === 'sqlite') for (const t of Object.values(c)) add(t as Record<string, unknown>)
      else add(c)
    }
    return `read ${read}, added ${added}`
  } catch {
    return 'finished with output that is not the counts'
  }
}

/**
 * Bring ZSwarm's stats and history into HSwarm's own home: once shortly after the sidecar starts, then
 * hourly, for as long as ~/.zswarm exists (ZSwarm keeps running until it is retired). One run at a time,
 * hidden, unref'd. Logs counts only.
 */
export function startZswarmImport(deps: {
  python: string
  dir: string
  env: NodeJS.ProcessEnv
  spawn?: typeof Bun.spawn
  firstMs?: number
  everyMs?: number
}): void {
  const homeDir = deps.env.HOME || deps.env.USERPROFILE || homedir()
  const zswarmHome = deps.env.ZSWARM_HOME?.trim() || join(homeDir, '.zswarm')
  if (importTimer) clearTimeout(importTimer)
  const spawnFn = deps.spawn ?? Bun.spawn
  const tick = async () => {
    importTimer = null
    if (stopRequested) return
    if (existsSync(zswarmHome) && !importRunning) {
      importRunning = true
      try {
        const child = spawnFn([deps.python, '-m', 'hswarm', 'import-zswarm', '--json'], {
          cwd: deps.dir,
          stdout: 'pipe',
          stderr: 'ignore',
          stdin: 'ignore',
          windowsHide: true,
          env: deps.env,
        })
        const out = await new Response(child.stdout as ReadableStream).text()
        const code = await child.exited
        console.log(
          `[hswarm] zswarm import ${code === 0 ? importSummary(out) : `failed (exit ${code})`}`,
        )
      } catch (e) {
        console.error('[hswarm] zswarm import failed:', e instanceof Error ? e.message : String(e))
      } finally {
        importRunning = false
      }
    }
    if (!stopRequested && existsSync(zswarmHome)) {
      importTimer = setTimeout(tick, deps.everyMs ?? ZSWARM_IMPORT_EVERY_MS)
      importTimer.unref?.()
    }
  }
  importTimer = setTimeout(tick, deps.firstMs ?? ZSWARM_IMPORT_FIRST_MS)
  importTimer.unref?.()
}

/** Stop hswarm. Returns a promise that settles once the process is gone. */
export async function stopHSwarm(): Promise<void> {
  stopRequested = true
  if (importTimer) clearTimeout(importTimer)
  importTimer = null
  clearAdoptTimer()
  if (!proc) {
    // An adopted server is somebody else's process (a chat's keeper started it): forget it, never kill it.
    state.running = false
    state.pid = null
    return
  }
  if (!state.running) return

  try {
    if (proc.pid) {
      killProcessTree(proc.pid)
    } else {
      proc.kill('SIGKILL')
    }
  } catch {
    // already gone
  }

  try {
    await proc.exited // its exit handler closes its log
  } catch {
    // ignore
  }

  state.running = false
  state.pid = null
  proc = null
}

/** Get the current hswarm status. */
export function getHSwarmStatus(): HSwarmState {
  return { ...state }
}

/** Set whether hswarm should be enabled. */
export function setHSwarmEnabled(enabled: boolean): void {
  if (enabled) {
    stopRequested = false
    void startHSwarm()
  } else {
    stopRequested = true
    void stopHSwarm()
  }
}

/** Exposed for testing: reset internal state. */
export function resetHSwarmStateForTests(): void {
  stopRequested = false
  clearAdoptTimer()
  state = { running: false, port: null, pid: null, lastError: null }
  proc = null
  backoffMs = MIN_BACKOFF_MS
}
