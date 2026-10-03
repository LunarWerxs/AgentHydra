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

/**
 * Start hswarm if enabled and not running. Restarts with exponential backoff on crash.
 * Logging goes to a file under the daemon's data dir, resolved lazily.
 */
export async function startHSwarm(
  deps: {
    enabled?: boolean
    dir?: string
    python?: string
    port?: number
    logDir?: string
    env?: NodeJS.ProcessEnv
    spawn?: typeof Bun.spawn
  } = {},
): Promise<void> {
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
      PYTHONUNBUFFERED: '1',
    }

    // ZSwarm is the live swarm until it retires; HSwarm only reads its history.
    const homeDir = env.HOME || env.USERPROFILE || homedir()
    const zswarmDb = join(homeDir, '.zswarm', 'zswarm.sqlite')
    if (!env.HSWARM_STATS_DB && existsSync(zswarmDb)) {
      env.HSWARM_STATS_DB = zswarmDb
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

function scheduleRestart(deps: {
  enabled?: boolean
  dir?: string
  python?: string
  port?: number
  logDir?: string
  env?: NodeJS.ProcessEnv
  spawn?: typeof Bun.spawn
}): void {
  if (stopRequested) return
  const delay = Math.min(backoffMs, MAX_BACKOFF_MS)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  setTimeout(() => startHSwarm(deps), delay)
}

/** Stop hswarm. Returns a promise that settles once the process is gone. */
export async function stopHSwarm(): Promise<void> {
  stopRequested = true
  if (!proc || !state.running) return

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
  state = { running: false, port: null, pid: null, lastError: null }
  proc = null
  backoffMs = MIN_BACKOFF_MS
}
