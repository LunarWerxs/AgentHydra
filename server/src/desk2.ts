// AgentHydra 2.0's window is Hydra Desk 2 (desk2/), its own server on its own port beside this daemon.
// This is the one place that knows it: whether it is here, where it answers, whether it is up, which bun
// runs it, where its log is, and how to start and stop it. The daemon's pages go through `page()`, the
// openers through `open()`, the updater through `stop()` / `start()` (stop before it replaces desk2/,
// start after), the MCP tools and the CliMayte ping through `url()`.
//
// Every effect (the health probe, the process starter, the clock) is a dep, so the routing contract is
// tested without a Desk 2 or a real process: see tests/desk2-routing.test.ts.
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_ROOT, IS_COMPILED, PORT } from './config'
import { openUi } from './open-ui'

export interface StartPlan {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  /** Appended with the child's stdout and stderr (a plan that starts bun itself); null where Desk 2's own
   *  launcher keeps the log. */
  logPath: string | null
  /** Where the started pid is recorded for `stop()` (elsewhere than Windows, whose launcher writes its own). */
  pidFile: string | null
}

export interface Desk2Deps {
  appRoot: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
  /** True when `GET <url>` answers 200. */
  probe: (healthUrl: string) => Promise<boolean>
  /** Starts the plan detached and returns once it has spawned; `wait` runs it to its end instead. */
  run: (plan: StartPlan, wait: boolean) => Promise<{ pid?: number; code?: number | null }>
  /** Asks a running Desk 2 to stop (POST /api/server/shutdown). */
  shutdown: (url: string) => Promise<void>
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** bun on PATH, or null. */
  which: (name: string) => string | null
  openBrowser: (url: string) => boolean
  /** This daemon's own address: what Desk 2's bridge is told to talk to. */
  daemonUrl: () => string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** How long a start waits for health before it gives up (the starting page gives up at the same 30 s). */
  startTimeoutMs: number
  /** How long a health answer is reused, so a burst of page loads costs one probe. */
  healthTtlMs: number
}

export interface Desk2StartResult {
  ok: boolean
  /** False when Desk 2 already answered and nothing was started. */
  started: boolean
  reason?: string
}

export interface Desk2Status {
  present: boolean
  up: boolean
  starting: boolean
  url: string
  log: string
  /** Why the last start failed, or null. */
  error: string | null
}

export const DESK2_START_TIMEOUT_MS = 30_000
const DEFAULT_DESK_PORT = 7798

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function httpProbe(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
    return res.status === 200
  } catch {
    return false
  }
}

async function httpShutdown(url: string): Promise<void> {
  try {
    await fetch(`${url}/api/server/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // floor-ok: a Desk 2 that does not answer is stopped by its pid
  }
}

/** Starts a plan the way the launcher scripts need: hidden, outside this process's job, output to the log. */
async function runPlan(
  plan: StartPlan,
  wait: boolean,
): Promise<{ pid?: number; code?: number | null }> {
  let fd: number | null = null
  if (plan.logPath) {
    mkdirSync(dirname(plan.logPath), { recursive: true })
    fd = openSync(plan.logPath, 'a')
  }
  try {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: !wait,
      windowsHide: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
    })
    if (wait) {
      return await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve({ pid: child.pid, code }))
      })
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    child.unref()
    if (plan.pidFile && child.pid) {
      mkdirSync(dirname(plan.pidFile), { recursive: true })
      writeFileSync(
        plan.pidFile,
        JSON.stringify({ serverPid: child.pid, startedAt: new Date().toISOString() }),
      )
    }
    return { pid: child.pid }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function defaultDeps(): Desk2Deps {
  return {
    appRoot: APP_ROOT,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    probe: httpProbe,
    run: runPlan,
    shutdown: httpShutdown,
    kill: (pid, signal) => {
      process.kill(pid, signal)
    },
    which: (name) => (typeof Bun !== 'undefined' ? Bun.which(name) : null),
    openBrowser: openUi,
    daemonUrl: () => `http://127.0.0.1:${PORT}`,
    now: () => Date.now(),
    sleep: sleepMs,
    startTimeoutMs: DESK2_START_TIMEOUT_MS,
    healthTtlMs: 2000,
  }
}

/** The small self-contained page a person lands on while Desk 2 starts: it polls the daemon's own status
 *  route and goes on to `target` when Desk 2 answers, and after ~30 s says it could not start and names the
 *  log file. */
export function startingPageHtml(
  target: string,
  logPath: string,
  giveUpMs = DESK2_START_TIMEOUT_MS,
) {
  // JSON inside a <script>: `<` is escaped so no value can close the tag.
  const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting AgentHydra...</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .4rem 0; opacity: .8; }
  code { word-break: break-all; }
  .spin { width: 1.5rem; height: 1.5rem; margin: 0 auto 1rem; border: 3px solid currentColor; border-right-color: transparent; border-radius: 50%; opacity: .6; animation: s 1s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  [hidden] { display: none; }
</style>
</head>
<body>
<main>
  <section id="wait">
    <div class="spin"></div>
    <h1>Starting AgentHydra...</h1>
    <p>This page goes on by itself as soon as AgentHydra is ready.</p>
  </section>
  <section id="fail" hidden>
    <h1>AgentHydra could not start</h1>
    <p>Its log is <code>${esc(logPath)}</code></p>
    <p><a href="">Try again</a></p>
  </section>
</main>
<script>
(function () {
  var target = ${js(target)};
  var started = Date.now();
  var giveUp = ${js(giveUpMs)};
  function fail() {
    document.getElementById('wait').hidden = true;
    document.getElementById('fail').hidden = false;
  }
  function tick() {
    fetch('/api/desk2/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.up) { location.replace(target); return; }
        if ((s && s.error && !s.starting) || Date.now() - started > giveUp) { fail(); return; }
        setTimeout(tick, 800);
      })
      .catch(function () {
        if (Date.now() - started > giveUp) fail(); else setTimeout(tick, 800);
      });
  }
  tick();
})();
</script>
</body>
</html>
`
}

export function createDesk2(overrides: Partial<Desk2Deps> = {}) {
  const d: Desk2Deps = { ...defaultDeps(), ...overrides }
  const deskDir = () => join(d.appRoot, 'desk2')
  const launcher = (name: string) => join(deskDir(), 'launcher', name)
  const useLauncher = () => d.platform === 'win32' && d.exists(launcher('start.ps1'))

  let healthAt = 0
  let healthVal = false
  let healthPending: Promise<boolean> | null = null
  let inflight: Promise<Desk2StartResult> | null = null
  let lastError: string | null = null
  let daemonUrlOverride: string | null = null

  /** Desk 2 is beside this daemon (a checkout, or a release bundle from 2.0.0). */
  function present(): boolean {
    return d.exists(join(deskDir(), 'server', 'src', 'index.ts'))
  }

  function port(): number {
    return Number(d.env.HYDRA_DESK_PORT) || DEFAULT_DESK_PORT
  }

  /** Where Desk 2 answers, whether or not it sits beside this daemon (a release exe can run beside a Desk 2
   *  that runs from a checkout). Read at each call, so HYDRA_DESK_PORT is honoured. */
  function url(): string {
    return `http://127.0.0.1:${port()}`
  }

  /** desk2/runtime/bun(.exe) when the bundle carries one, else bun on PATH (a checkout), else null. */
  function bun(): string | null {
    const shipped = join(deskDir(), 'runtime', d.platform === 'win32' ? 'bun.exe' : 'bun')
    if (d.exists(shipped)) return shipped
    return d.which('bun') ?? (IS_COMPILED ? null : process.execPath)
  }

  function home(): string {
    return d.env.HYDRA_DESK_HOME || join(homedir(), '.hydra-desk-2')
  }

  function logPath(): string {
    return join(home(), 'logs', 'server.log')
  }

  function forgetHealth(): void {
    healthAt = 0
  }

  /** Whether Desk 2's /api/health answers. Reused for `healthTtlMs`, and one probe at a time. */
  function healthy(fresh = false): Promise<boolean> {
    if (!present()) return Promise.resolve(false)
    if (!fresh && healthAt && d.now() - healthAt < d.healthTtlMs) return Promise.resolve(healthVal)
    if (!healthPending) {
      healthPending = d
        .probe(`${url()}/api/health`)
        .catch(() => false)
        .then((v) => {
          healthVal = v
          healthAt = d.now()
          healthPending = null
          return v
        })
    }
    return healthPending
  }

  /** How a start is run: through Desk 2's launcher on Windows (hidden, `window` for its native window too),
   *  else bun on server/src/index.ts, detached, output appended to the log. Null when it cannot start. */
  function planStart(opts: { window?: boolean; hydraUrl?: string } = {}): StartPlan | null {
    const env = {
      ...d.env,
      HYDRA_DESK_PORT: String(port()),
      HYDRA_URL: opts.hydraUrl ?? daemonUrlOverride ?? d.daemonUrl(),
    }
    if (useLauncher()) {
      if (opts.window) {
        const wscript = join(d.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
        return {
          command: wscript,
          args: ['//B', '//Nologo', launcher('start.vbs')],
          cwd: deskDir(),
          env,
          logPath: null,
          pidFile: null,
        }
      }
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          launcher('start.ps1'),
          '-NoWindow',
          '-NoDialog',
        ],
        cwd: deskDir(),
        env,
        logPath: null,
        pidFile: null,
      }
    }
    const exe = bun()
    if (!exe) return null
    return {
      command: exe,
      args: [join('server', 'src', 'index.ts')],
      cwd: deskDir(),
      env,
      logPath: logPath(),
      pidFile: join(home(), 'server.pid'),
    }
  }

  async function doStart(opts: { window?: boolean; hydraUrl?: string }): Promise<Desk2StartResult> {
    const window = Boolean(opts.window) && useLauncher()
    // The launcher run for a window only focuses an open one, so it is safe to run while Desk 2 is up.
    if (!window && (await healthy(true))) return { ok: true, started: false }
    lastError = null
    const plan = planStart({ ...opts, window })
    if (!plan) {
      lastError = 'bun is not installed, so Desk 2 cannot start'
      return { ok: false, started: false, reason: lastError }
    }
    try {
      await d.run(plan, false)
    } catch (e) {
      lastError = `Desk 2 did not start: ${e instanceof Error ? e.message : String(e)}`
      return { ok: false, started: false, reason: lastError }
    }
    const deadline = d.now() + d.startTimeoutMs
    for (;;) {
      if (await healthy(true)) return { ok: true, started: true }
      if (d.now() >= deadline) break
      await d.sleep(500)
    }
    lastError = `Desk 2 did not answer on ${url()} in ${Math.round(d.startTimeoutMs / 1000)} s`
    return { ok: false, started: true, reason: lastError }
  }

  /** Starts Desk 2 (and, on Windows with `window`, its native window). One start in flight at a time: a
   *  call while one runs gets that one's answer. Resolves when Desk 2 answers or the wait ran out. */
  function start(opts: { window?: boolean; hydraUrl?: string } = {}): Promise<Desk2StartResult> {
    if (!present()) {
      return Promise.resolve({
        ok: false,
        started: false,
        reason: 'Desk 2 (desk2/) is not beside this daemon',
      })
    }
    if (!inflight) {
      inflight = doStart(opts).finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  /** Stops Desk 2's server (and, on Windows, its window host) so desk2/ can be replaced: Windows runs its
   *  stop.ps1; elsewhere it asks the server to shut down, then ends the pid `start()` recorded. Its data
   *  (~/.hydra-desk-2) is not touched. */
  async function stop(): Promise<{ ok: boolean; reason?: string }> {
    if (!present()) return { ok: true }
    if (inflight) await inflight.catch(() => undefined)
    forgetHealth()
    if (d.platform === 'win32' && d.exists(launcher('stop.ps1'))) {
      const plan: StartPlan = {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          launcher('stop.ps1'),
        ],
        cwd: deskDir(),
        env: { ...d.env },
        logPath: null,
        pidFile: null,
      }
      try {
        const r = await d.run(plan, true)
        forgetHealth()
        return r.code === 0 ? { ok: true } : { ok: false, reason: `stop.ps1 exited with ${r.code}` }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
    const waitDown = async (ms: number) => {
      const until = d.now() + ms
      while (d.now() < until) {
        if (!(await healthy(true))) return true
        await d.sleep(250)
      }
      return !(await healthy(true))
    }
    if (!(await healthy(true))) return { ok: true }
    await d.shutdown(url())
    if (await waitDown(10_000)) return { ok: true }
    const pidFile = join(home(), 'server.pid')
    let pid = 0
    try {
      pid = Number(JSON.parse(readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '')).serverPid) || 0
    } catch {
      // floor-ok: no recorded pid, nothing more to end
    }
    if (pid > 0) {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        try {
          d.kill(pid, signal)
        } catch {
          // floor-ok: already gone
        }
        if (await waitDown(5000)) {
          rmSync(pidFile, { force: true })
          return { ok: true }
        }
      }
    }
    return { ok: false, reason: `Desk 2 still answers on ${url()}` }
  }

  /** Opens Desk 2 for a person: Windows runs start.vbs (the server and the native window), elsewhere it
   *  starts the server and opens the default browser at it. False where Desk 2 is not beside this daemon,
   *  so the caller can do what it did before. */
  async function open(opts: { hydraUrl?: string } = {}): Promise<boolean> {
    if (!present()) return false
    if (useLauncher()) return (await start({ window: true, hydraUrl: opts.hydraUrl })).ok
    const r = await start({ hydraUrl: opts.hydraUrl })
    if (r.ok) d.openBrowser(`${url()}/`)
    return r.ok
  }

  async function status(): Promise<Desk2Status> {
    return {
      present: present(),
      up: await healthy(),
      starting: inflight !== null,
      url: url(),
      log: logPath(),
      error: lastError,
    }
  }

  /** Answers a page asked of the daemon (not /api): a 302 to Desk 2 with the query when it answers, else
   *  starts it (once) and answers the starting page. Null where Desk 2 is not beside this daemon: the
   *  caller serves what it served before. */
  async function page(pageUrl: URL): Promise<Response | null> {
    if (!present()) return null
    const target = `${url()}/${pageUrl.search}`
    if (await healthy()) {
      return new Response(null, {
        status: 302,
        headers: { location: target, 'cache-control': 'no-store' },
      })
    }
    start().catch(() => undefined)
    return new Response(startingPageHtml(target, logPath(), d.startTimeoutMs), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  return {
    present,
    url,
    port,
    bun,
    logPath,
    healthy,
    forgetHealth,
    planStart,
    start,
    stop,
    open,
    status,
    page,
    /** This daemon's real address once it is listening (it may have hopped off its default port). */
    setDaemonUrl(u: string) {
      daemonUrlOverride = u
    },
  }
}

export type Desk2 = ReturnType<typeof createDesk2>

export const desk2: Desk2 = createDesk2()
export const desk2Present = () => desk2.present()
export const desk2Url = () => desk2.url()
