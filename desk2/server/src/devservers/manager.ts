// The dev-server manager the dev-servers service runs: DevWebUI's manager (start/stop/restart with linked groups,
// companions and waitForPort ordering; the staggered batch queue; the per-server log ring; the live reload of
// `.devwebui` files) without what AgentHydra does not take (compose, prompt answers, metrics, alerts, the errors
// panel, the log vault, SSE, runtime rewriting, takeover, the freePortOnStart kill), and with what it adds: one copy
// per server. A server already answering on its port, or running from its folder, is used as it is (`outside`) and
// never started twice; a port held by something that is not a dev server is a `conflict` and a start is refused.
// NOTHING here ends a process to free a port; stopping an outside server happens only when asked to.
//
// Dev servers are this process's children (stdio piped, hidden), so ending the service ends them (stopAll on a clean
// exit, killAllSync on a crash). The service itself is started outside Desk's tree (service.ts), so a Desk restart
// leaves them running.

import { type ChildProcess, spawn } from 'node:child_process'
import net from 'node:net'
import { type DevWebEnsure, type DevWebLogLine, type DevWebProcess, type DevWebProcessStatus, type DevWebProject, type DevWebStartAnswer, processAddress } from '@shared/devwebui'
import { killHostTree } from '../host/launch'
import { type Scan, scanPorts } from '../localhost/ports'
import { type AdoptContext, findByFolder, judgePort } from './adopt'
import { stripAnsi } from './ansi'
import type { CreateDevServers, DevServers, DevServersDeps, LoadAnswer, ScaffoldProposal } from './contract'
import { DevServerError } from './contract'
import { setUpFolder } from './folder'
import { coStartIds, DependencyCycleError, linkedGroupIds, orderByDependency, resolveWaitPort } from './links'
import { resolveLoadTarget, writeScaffold } from './load'
import { type LoadedProject, type ProcessDef, readProjectFile } from './project-file'
import { defaultImportDir, loadFiles, readResume, removeResume, type StateShape, withPath, writeRegistry, writeState } from './registry'
import { planManagedSpawn } from './spawn-plan'
import { createProjectWatch, type ProjectWatch } from './watch'

const MAX_LOGS = 500
/** The least time between two status looks (a forced look, before a start, ignores it). */
const LOOK_MIN_MS = 1500
/** A port scan is reused this long when a probe found a listener we do not own. */
const SCAN_TTL_MS = 8000
/** A server with no port is found by scanning; at most this often while it is down. */
const PORTLESS_SCAN_MS = 10_000
const START_STAGGER_MS = 1200
const WAIT_FOR_PORT_TIMEOUT_MS = 30_000
const WAIT_FOR_PORT_POLL_MS = 300
/** A started server with a port is `starting` until it answers; after this long it counts as running anyway. */
const READY_POLL_MS = 500
const READY_GIVE_UP_MS = 60_000
const KILL_GRACE_MS = 5000
const OUTSIDE_STOP_WAIT_MS = 4000
const ENSURE_WAIT_MS = 45_000
const ENSURE_POLL_MS = 250

interface Outside {
  pid: number
  /** The port it answers on (the server's own, or the one found for a server with none). */
  port: number | null
  since: number
}

interface Entry {
  def: ProcessDef
  /** The state of this manager's own run: what a view shows unless an outside server answers. */
  status: DevWebProcessStatus
  child: ChildProcess | null
  pid: number | null
  startedAt: number | null
  restarts: number
  exitCode: number | null
  outside: Outside | null
  conflict: string | null
  waitingOnPort: number | null
  logs: DevWebLogLine[]
  configChanged: boolean
  stopping: boolean
  /** A start waits for its dependency port (no child yet). */
  pendingStart: boolean
  /** The start in flight: a second start of the same server joins it instead of spawning again. */
  startOp: Promise<DevWebStartAnswer> | null
  exitWaiters: Array<() => void>
  /** Bumped by every start and stop: a start that finds it moved was overtaken (stopped meanwhile) and gives up. */
  generation: number
  readyTimer: ReturnType<typeof setInterval> | null
  stopTimer: ReturnType<typeof setTimeout> | null
}

interface Project {
  id: string
  name: string
  color?: string
  path: string
  processIds: string[]
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const sock = net.connect({ host, port })
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Something accepts a TCP connection on 127.0.0.1 or ::1 (a server bound to `localhost` may be on either). */
export async function defaultPortListening(port: number): Promise<boolean> {
  return (await Promise.all([connects('127.0.0.1', port, 300), connects('::1', port, 300)])).some(Boolean)
}

class Manager implements DevServers {
  readonly ready: Promise<void>

  private readonly home: string
  private readonly now: () => number
  private readonly kill: (pid: number) => void
  private readonly portListening: (port: number) => Promise<boolean>
  private readonly scanFn: () => Promise<Scan>
  private readonly deps: DevServersDeps

  private entries = new Map<string, Entry>()
  private projects = new Map<string, Project>()
  private registry: string[] = []
  private state: StateShape = { enabled: {}, projectEnabled: {} }
  private queued = new Map<string, ReturnType<typeof setTimeout>>()
  private watcher: ProjectWatch | null = null
  private closed = false

  private looking: Promise<void> | null = null
  private lookQueued: Promise<void> | null = null
  private lastLookAt = Number.NEGATIVE_INFINITY
  private scanCache: { scan: Scan; at: number } | null = null
  private scanning: Promise<Scan> | null = null

  constructor(deps: DevServersDeps) {
    this.deps = deps
    this.home = deps.home
    this.now = deps.now ?? Date.now
    this.kill = deps.kill ?? killHostTree
    this.portListening = deps.portListening ?? defaultPortListening
    this.scanFn = deps.scan ?? scanPorts
    this.ready = this.boot().catch((e) => this.note(`start-up failed: ${(e as Error).message}`))
  }

  // ---- boot, registry, state ------------------------------------------------

  private async boot(): Promise<void> {
    const importFrom = this.deps.importFrom === undefined ? defaultImportDir() : this.deps.importFrom
    try {
      const loaded = loadFiles(this.home, importFrom)
      this.registry = loaded.registry
      this.state = loaded.state
    } catch (e) {
      this.note(`could not read ${this.home}: ${(e as Error).message}`)
    }
    // The service's own start never autostarts (DevWebUI's autoStartOnLaunch was off): only a load does.
    for (const file of this.registry) {
      try {
        this.addProject(readProjectFile(file))
      } catch (e) {
        this.note(`${file}: ${(e as Error).message}`)
      }
    }
    if (this.deps.watch ?? true) {
      this.watcher = createProjectWatch({
        files: () => [...this.projects.values()].map((p) => p.path),
        apply: (file) => this.reconcile(readProjectFile(file)),
        log: (line) => this.note(line),
      })
      this.watcher.sync()
    }
    // A restart wrote the servers it ran: start those again, then forget the file.
    const ids = readResume(this.home).filter((id) => this.entries.has(id))
    if (ids.length) this.startMany(ids)
    removeResume(this.home)
  }

  private note(line: string): void {
    console.error(`[devservers] ${line}`)
  }

  private persistRegistry(): void {
    try {
      writeRegistry(this.home, this.registry)
    } catch (e) {
      this.note(`could not write the registry: ${(e as Error).message}`)
    }
  }

  private persistState(): void {
    try {
      writeState(this.home, this.state)
    } catch (e) {
      this.note(`could not write the state: ${(e as Error).message}`)
    }
  }

  private processEnabled(def: ProcessDef): boolean {
    return this.state.enabled[def.id] ?? !!def.autostart
  }

  private projectEnabled(projectId: string): boolean {
    return this.state.projectEnabled[projectId] ?? true
  }

  /** Autostarts on a load only when the project switch AND the server's own toggle are on. */
  private willAutostart(def: ProcessDef): boolean {
    return this.projectEnabled(def.projectId) && this.processEnabled(def)
  }

  /** Forget the toggles of servers that left their file (a renamed id would leak in state.json forever). */
  private forgetToggles(ids: string[]): void {
    let changed = false
    for (const id of ids)
      if (id in this.state.enabled) {
        delete this.state.enabled[id]
        changed = true
      }
    if (changed) this.persistState()
  }

  // ---- projects -------------------------------------------------------------

  private newEntry(def: ProcessDef): Entry {
    return {
      def,
      status: 'stopped',
      child: null,
      pid: null,
      startedAt: null,
      restarts: 0,
      exitCode: null,
      outside: null,
      conflict: null,
      waitingOnPort: null,
      logs: [],
      configChanged: false,
      stopping: false,
      pendingStart: false,
      startOp: null,
      exitWaiters: [],
      generation: 0,
      readyTimer: null,
      stopTimer: null,
    }
  }

  private addProject(lp: LoadedProject): void {
    const prev = this.projects.get(lp.id)
    if (prev) {
      this.forgetToggles(prev.processIds.filter((id) => !lp.processes.some((p) => p.id === id)))
      this.purge(lp.id)
    }
    this.projects.set(lp.id, { id: lp.id, name: lp.name, color: lp.color, path: lp.path, processIds: lp.processes.map((p) => p.id) })
    for (const def of lp.processes) this.entries.set(def.id, this.newEntry(def))
  }

  private purge(id: string): void {
    const proj = this.projects.get(id)
    if (!proj) return
    for (const pid of proj.processIds) {
      const e = this.entries.get(pid)
      if (e) this.discard(e)
      this.entries.delete(pid)
    }
    this.projects.delete(id)
  }

  /** A server that left its file: its own child is ended (an outside one is not ours to end). */
  private discard(e: Entry): void {
    this.cancelQueued(e.def.id)
    e.generation++
    e.stopping = true
    e.pendingStart = false
    e.waitingOnPort = null
    const pid = e.child ? e.pid : null
    this.clearTimers(e)
    e.child = null
    e.pid = null
    e.startedAt = null
    this.resolveWaiters(e)
    if (pid) this.safeKill(pid)
  }

  /**
   * Applies a re-read of a project's file the way DevWebUI's watch reload did: removed servers are stopped and
   * dropped, new ones are added stopped, a changed running server keeps running and is marked `configChanged` (a
   * `git pull` or a branch switch can rewrite the file with no code run, so a changed command never relaunches by
   * itself).
   */
  private reconcile(lp: LoadedProject): void {
    const existing = this.projects.get(lp.id)
    if (!existing) {
      this.addProject(lp)
      return
    }
    const incoming = new Set(lp.processes.map((p) => p.id))
    for (const pid of existing.processIds) {
      if (incoming.has(pid)) continue
      const e = this.entries.get(pid)
      if (e) this.discard(e)
      this.entries.delete(pid)
      this.forgetToggles([pid])
    }
    for (const def of lp.processes) {
      const e = this.entries.get(def.id)
      if (!e) {
        this.entries.set(def.id, this.newEntry(def))
        continue
      }
      const execChanged = e.def.command !== def.command || e.def.cwd !== def.cwd || JSON.stringify(e.def.env ?? null) !== JSON.stringify(def.env ?? null)
      e.def = def
      if (execChanged && e.child) {
        e.configChanged = true
        this.addLog(e, 'stderr', "[devservers] this server's .devwebui entry changed on disk; restart it to apply the change.")
      }
    }
    existing.name = lp.name
    existing.color = lp.color
    existing.processIds = lp.processes.map((p) => p.id)
    this.watcher?.sync()
  }

  // ---- views ----------------------------------------------------------------

  private isUp(e: Entry): boolean {
    return (!!e.child && !e.stopping) || e.pendingStart || !!e.outside
  }

  private view(e: Entry): DevWebProcess {
    const d = e.def
    const own = !!e.child
    const status: DevWebProcessStatus = own ? e.status : e.outside ? 'running' : e.status
    return {
      id: d.id,
      localId: d.localId,
      name: d.name,
      command: d.command,
      cwd: d.cwd,
      ...(d.color ? { color: d.color } : {}),
      ...(d.autostart !== undefined ? { autostart: d.autostart } : {}),
      ...(d.starred !== undefined ? { starred: d.starred } : {}),
      enabled: this.processEnabled(d),
      ...(d.port !== undefined ? { port: d.port } : {}),
      ...(d.url ? { url: d.url } : {}),
      status,
      owner: own || e.pendingStart ? 'desk' : e.outside ? 'outside' : null,
      pid: own ? e.pid : (e.outside?.pid ?? null),
      startedAt: own ? e.startedAt : (e.outside?.since ?? null),
      restarts: e.restarts,
      exitCode: e.exitCode,
      conflict: e.conflict,
      ...(e.configChanged ? { configChanged: true } : {}),
      ...(status === 'waiting' ? { waitingOnPort: e.waitingOnPort } : {}),
      projectId: d.projectId,
      projectName: d.projectName,
    }
  }

  private projectView(p: Project): DevWebProject {
    return {
      id: p.id,
      name: p.name,
      ...(p.color ? { color: p.color } : {}),
      path: p.path,
      enabled: this.projectEnabled(p.id),
      processes: p.processIds.map((id) => this.view(this.entries.get(id)!)),
    }
  }

  private answer(e: Entry, reused: boolean, coStarted: string[]): DevWebStartAnswer {
    return { ok: true, process: this.view(e), reused, coStarted }
  }

  private must(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new DevServerError(`No server with id "${id}".`, 404)
    return e
  }

  private mustProject(id: string): Project {
    const p = this.projects.get(id)
    if (!p) throw new DevServerError(`No project with id "${id}".`, 404)
    return p
  }

  private defsList(): ProcessDef[] {
    return [...this.entries.values()].map((e) => e.def)
  }

  private defsById(): Map<string, ProcessDef> {
    return new Map(this.defsList().map((d) => [d.id, d]))
  }

  async listProjects(): Promise<DevWebProject[]> {
    await this.ready
    await this.refresh()
    return [...this.projects.values()].map((p) => this.projectView(p))
  }

  async process(id: string): Promise<DevWebProcess | null> {
    await this.ready
    await this.refresh()
    const e = this.entries.get(id)
    return e ? this.view(e) : null
  }

  async logs(id: string): Promise<DevWebLogLine[]> {
    await this.ready
    const e = this.must(id)
    await this.refresh()
    if (!e.child && e.outside) {
      return [{ stream: 'stdout', line: `[devservers] this server was started outside AgentHydra (pid ${e.outside.pid}); its output is not available here.`, ts: this.now() }]
    }
    return [...e.logs]
  }

  // ---- looking: is it already up? -------------------------------------------

  /** One look at a time; at most every ~1.5 s unless forced (a forced one, before a start, always runs). */
  private refresh(force = false): Promise<void> {
    if (force) {
      if (this.lookQueued) return this.lookQueued
      if (!this.looking) return this.runLook(true)
      // The look under way began before whatever the caller just changed: one more follows it.
      const queued: Promise<void> = this.looking.then(() => {
        this.lookQueued = null
        return this.runLook(true)
      })
      this.lookQueued = queued
      return queued
    }
    if (this.looking) return this.looking
    if (this.now() - this.lastLookAt < LOOK_MIN_MS) return Promise.resolve()
    return this.runLook(false)
  }

  private runLook(force: boolean): Promise<void> {
    const p: Promise<void> = this.doLook(force)
      .catch((e) => this.note(`status look failed: ${(e as Error).message}`))
      .finally(() => {
        this.lastLookAt = this.now()
        if (this.looking === p) this.looking = null
      })
    this.looking = p
    return p
  }

  private async getScan(maxAge: number): Promise<Scan> {
    const c = this.scanCache
    if (c && this.now() - c.at <= maxAge) return c.scan
    if (this.scanning) return this.scanning
    const p = (async (): Promise<Scan> => {
      try {
        return await this.scanFn()
      } catch (e) {
        return { listeners: [], procs: new Map(), error: (e as Error).message }
      }
    })()
    this.scanning = p
    try {
      const scan = await p
      this.scanCache = scan.error ? null : { scan, at: this.now() }
      return scan
    } finally {
      this.scanning = null
    }
  }

  private safeListening(port: number): Promise<boolean> {
    return this.portListening(port).catch(() => false)
  }

  private adoptContext(): AdoptContext {
    const deskPid = this.deps.deskPid ?? process.pid
    return {
      selfPids: [process.pid, deskPid],
      deskPid,
      deskPort: this.deps.deskPort ?? -1,
      ownPids: [...this.entries.values()].flatMap((e) => (e.child && e.pid ? [e.pid] : [])),
    }
  }

  private dropOutside(e: Entry): void {
    if (!e.outside) return
    e.outside = null
    e.status = 'stopped'
    e.startedAt = null
  }

  private adopt(e: Entry, pid: number, port: number | null, scan: Scan | null): void {
    const had = e.outside
    e.outside = { pid, port, since: had?.since ?? scan?.procs.get(pid)?.created ?? this.now() }
    e.conflict = null
    e.status = 'stopped'
    e.exitCode = null
  }

  /**
   * Looks at every server that is not this manager's own child. A port that accepts a connection is judged from one
   * scan (cached ~8 s): a dev runtime or app there is that server run by someone else; anything else is a conflict.
   * A server with no port is found by its folder, and only when the last scan is over 10 s old (a forced look takes
   * a scan from the last 1.5 s). An outside server whose port stops answering is down again.
   */
  private async doLook(force: boolean): Promise<void> {
    const cands = [...this.entries.values()].filter((e) => !e.child && !e.pendingStart && !e.stopping)
    const ports = new Set<number>()
    for (const e of cands) {
      const p = e.def.port ?? e.outside?.port
      if (p) ports.add(p)
    }
    const own = new Set<number>()
    for (const e of this.entries.values()) if (e.child && e.def.port) own.add(e.def.port)

    const answers = new Map<number, boolean>()
    await Promise.all([...ports].map(async (p) => answers.set(p, own.has(p) ? false : await this.safeListening(p))))

    const needVerdict = cands.filter((e) => e.def.port && answers.get(e.def.port) && e.outside?.port !== e.def.port)
    const portless = cands.filter((e) => !e.def.port && !e.outside)
    let scan: Scan | null = null
    if (needVerdict.length) {
      scan = await this.getScan(SCAN_TTL_MS)
      const s = scan
      if (needVerdict.some((e) => !s.listeners.some((l) => l.port === e.def.port))) scan = await this.getScan(LOOK_MIN_MS)
    } else if (portless.length) {
      scan = await this.getScan(force ? LOOK_MIN_MS : PORTLESS_SCAN_MS)
    }

    const ctx = this.adoptContext()
    const claimed = { ports: new Set<number>(), pids: new Set<number>() }
    for (const e of this.entries.values()) {
      if (e.def.port) claimed.ports.add(e.def.port)
      if (e.outside) {
        claimed.pids.add(e.outside.pid)
        if (e.outside.port) claimed.ports.add(e.outside.port)
      }
    }

    for (const e of cands) {
      // The state may have moved while the probes and the scan ran.
      if (e.child || e.pendingStart || e.stopping) continue
      const port = e.def.port
      if (port) {
        if (own.has(port)) continue
        if (!answers.get(port)) {
          this.dropOutside(e)
          e.conflict = null
          continue
        }
        if (e.outside?.port === port) {
          const pid = scan?.listeners.find((l) => l.port === port)?.pid
          if (pid) e.outside.pid = pid
          continue
        }
        if (!scan) continue
        const v = judgePort(port, scan, ctx)
        if (v.kind === 'outside') this.adopt(e, v.pid, port, scan)
        else {
          this.dropOutside(e)
          e.conflict = v.text
        }
      } else if (e.outside) {
        if (e.outside.port && !answers.get(e.outside.port)) this.dropOutside(e)
      } else if (scan) {
        const hit = findByFolder(e.def.cwd, scan, ctx, claimed)
        if (hit) {
          this.adopt(e, hit.pid, hit.port, scan)
          claimed.pids.add(hit.pid)
          claimed.ports.add(hit.port)
        }
      }
    }
  }

  // ---- starting -------------------------------------------------------------

  async start(id: string): Promise<DevWebStartAnswer> {
    await this.ready
    return this.startOne(this.must(id), true)
  }

  /** The pending-start guard: while one start of a server runs, another joins it and answers `reused`. */
  private startOne(e: Entry, expand: boolean): Promise<DevWebStartAnswer> {
    if (this.closed) return Promise.reject(new DevServerError('the dev-servers service is stopping', 409))
    if (e.startOp) return e.startOp.then(() => this.answer(e, true, []))
    const op: Promise<DevWebStartAnswer> = this.runStart(e, expand).finally(() => {
      if (e.startOp === op) e.startOp = null
    })
    e.startOp = op
    return op
  }

  private async runStart(e: Entry, expand: boolean): Promise<DevWebStartAnswer> {
    this.cancelQueued(e.def.id)
    const gen = ++e.generation
    await this.refresh(true)
    const overtaken = () => e.generation !== gen || this.entries.get(e.def.id) !== e || this.closed
    if (overtaken()) return this.answer(e, false, [])
    if (e.child && e.stopping) {
      await new Promise<void>((r) => e.exitWaiters.push(r))
      if (overtaken()) return this.answer(e, false, [])
    }
    if (this.isUp(e)) {
      if (e.outside) this.addLog(e, 'stdout', `[devservers] ${e.outside.port ? `port ${e.outside.port} already answers` : 'it already runs'}: using the server that runs there (pid ${e.outside.pid}).`)
      return this.answer(e, true, [])
    }
    if (e.conflict) throw new DevServerError(`${e.conflict}, so ${e.def.name} was not started (a program is never ended to free a port).`, 409)

    this.begin(e)

    let coStarted: string[] = []
    if (expand) {
      let extras = coStartIds(e.def, this.defsList())
      // A waitForPort cycle among the extras must not block the anchor's real group: name it and start the rest.
      for (;;) {
        try {
          orderByDependency(extras, this.defsById())
          break
        } catch (err) {
          if (!(err instanceof DependencyCycleError)) throw err
          for (const cid of err.cycle) {
            const ce = this.entries.get(cid)
            if (ce) this.addLog(ce, 'stderr', `[devservers] ${err.message}; not starting.`)
          }
          const cycle = new Set(err.cycle)
          extras = extras.filter((x) => !cycle.has(x))
        }
      }
      // What this action sets in motion: not what is up already, mid-start, queued, or refused.
      coStarted = extras.filter((x) => {
        const xe = this.entries.get(x)
        return !!xe && !this.isUp(xe) && !xe.startOp && !this.queued.has(x) && !xe.conflict
      })
      if (extras.length) this.startMany(extras)
    }
    return this.answer(e, false, coStarted)
  }

  /** The synchronous part of a start: the waitForPort wait, or the spawn. */
  private begin(e: Entry): void {
    e.exitCode = null
    e.configChanged = false
    e.conflict = null
    e.stopping = false
    this.clearTimers(e)
    if (e.def.unsupported) this.addLog(e, 'stderr', `[devservers] ${e.def.name}: compose/answers are not supported here`)
    const waitPort = resolveWaitPort(e.def, this.defsById())
    if (!waitPort) {
      e.status = 'starting'
      this.spawnEntry(e)
      return
    }
    const gen = e.generation
    e.pendingStart = true
    e.waitingOnPort = waitPort
    e.status = 'waiting'
    const cancelled = () => !e.pendingStart || e.generation !== gen || this.entries.get(e.def.id) !== e || this.closed
    void this.waitForPort(waitPort, cancelled).then((ok) => {
      if (cancelled()) return
      e.pendingStart = false
      e.waitingOnPort = null
      if (!ok) {
        this.addLog(e, 'stderr', `[devservers] gave up waiting for port ${waitPort} after ${WAIT_FOR_PORT_TIMEOUT_MS / 1000} s; not starting.`)
        e.status = 'stopped'
        this.resolveWaiters(e)
        return
      }
      e.status = 'starting'
      this.spawnEntry(e)
    })
  }

  private async waitForPort(port: number, cancelled: () => boolean): Promise<boolean> {
    const deadline = Date.now() + WAIT_FOR_PORT_TIMEOUT_MS
    for (;;) {
      if (cancelled()) return false
      if (await this.safeListening(port)) return true
      if (Date.now() >= deadline) return false
      await sleep(WAIT_FOR_PORT_POLL_MS)
    }
  }

  /** Runs the command: directly when it is a plain executable, else through the shell (see spawn-plan.ts). */
  private spawnEntry(e: Entry): void {
    if (e.child || this.entries.get(e.def.id) !== e) return
    const def = e.def
    // BUN_BE_BUN lets a bundled build run its own exe as the bun CLI; a project's server must not inherit it.
    const { BUN_BE_BUN: _beBun, ...inherited } = process.env
    const env = { ...inherited, ...def.env }
    const plan = planManagedSpawn(def.command, { cwd: def.cwd, env })
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
    let child: ChildProcess
    try {
      child = plan.shell === false ? spawn(plan.file, plan.args, { cwd: def.cwd, env, windowsHide: true, stdio }) : spawn(plan.command, { cwd: def.cwd, env, shell: true, windowsHide: true, stdio })
    } catch (err) {
      this.spawnFailed(e, null, err)
      return
    }
    e.child = child
    e.pid = child.pid ?? null
    e.startedAt = this.now()
    child.stdout?.on('data', (d: Buffer) => this.addLog(e, 'stdout', d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.addLog(e, 'stderr', d.toString()))
    child.on('error', (err) => this.spawnFailed(e, child, err))
    child.on('exit', (code) => this.handleExit(e, child, code))
    if (e.pid) this.watchReady(e, child)
  }

  /** `starting` until the port answers (poll ~500 ms; after 60 s it counts as running anyway); at once with no port. */
  private watchReady(e: Entry, child: ChildProcess): void {
    const port = e.def.port
    if (!port) {
      e.status = 'running'
      return
    }
    const began = Date.now()
    let busy = false
    e.readyTimer = setInterval(() => {
      if (e.child !== child || e.status !== 'starting') {
        this.clearTimers(e)
        return
      }
      if (busy) return
      busy = true
      void this.safeListening(port).then((up) => {
        busy = false
        if (e.child !== child || e.status !== 'starting') return
        if (up || Date.now() - began >= READY_GIVE_UP_MS) {
          e.status = 'running'
          this.clearTimers(e)
        }
      })
    }, READY_POLL_MS)
  }

  private spawnFailed(e: Entry, child: ChildProcess | null, err: unknown): void {
    if (child && e.child !== child) return
    const current = this.entries.get(e.def.id) === e
    this.clearTimers(e)
    e.child = null
    e.pid = null
    e.startedAt = null
    e.exitCode = null
    const wasStopping = e.stopping
    e.stopping = false
    if (current) {
      this.addLog(e, 'stderr', `[devservers] spawn error: ${err instanceof Error ? err.message : String(err)}`)
      e.status = wasStopping ? 'stopped' : 'crashed'
    }
    this.resolveWaiters(e)
  }

  private handleExit(e: Entry, child: ChildProcess, code: number | null): void {
    if (e.child !== child) return
    const current = this.entries.get(e.def.id) === e
    const crashed = current && !e.stopping && code !== 0 && code !== null
    if (current) this.addLog(e, crashed ? 'stderr' : 'stdout', `[devservers] exited${code === null ? '' : ` with code ${code}`}`)
    this.finish(e, child, crashed ? 'crashed' : 'stopped', code)
  }

  private finish(e: Entry, child: ChildProcess, status: DevWebProcessStatus, exitCode: number | null): void {
    if (e.child !== child) return
    this.clearTimers(e)
    e.child = null
    e.pid = null
    e.exitCode = exitCode
    e.startedAt = null
    e.stopping = false
    e.status = status
    this.resolveWaiters(e)
  }

  private addLog(e: Entry, stream: DevWebLogLine['stream'], text: string): void {
    const ts = this.now()
    for (const raw of stripAnsi(text).split(/\r?\n/)) if (raw) e.logs.push({ stream, line: raw, ts })
    // Trimmed once per chunk, not per line: a flood must not copy the ring for every line.
    if (e.logs.length > MAX_LOGS) e.logs.splice(0, e.logs.length - MAX_LOGS)
  }

  private clearTimers(e: Entry): void {
    if (e.readyTimer) clearInterval(e.readyTimer)
    if (e.stopTimer) clearTimeout(e.stopTimer)
    e.readyTimer = null
    e.stopTimer = null
  }

  private resolveWaiters(e: Entry): void {
    const waiters = e.exitWaiters
    e.exitWaiters = []
    for (const fn of waiters) fn()
  }

  private safeKill(pid: number): void {
    try {
      this.kill(pid)
    } catch {
      // already gone
    }
  }

  // ---- batches: the staggered, dependency-ordered queue ------------------------

  /** Starts a list through the queue: dependencies first, one every 1.2 s so a wall of Vite servers does not boot at once. */
  private startMany(ids: string[]): void {
    const unique = [...new Set(ids)].filter((id) => this.entries.has(id))
    let ordered: string[]
    try {
      ordered = orderByDependency(unique, this.defsById())
    } catch (err) {
      if (!(err instanceof DependencyCycleError)) throw err
      for (const id of err.cycle) {
        const e = this.entries.get(id)
        if (e) this.addLog(e, 'stderr', `[devservers] ${err.message}; not starting.`)
      }
      return
    }
    ordered.forEach((id, i) => this.queueStart(id, i * START_STAGGER_MS))
  }

  private queueStart(id: string, delayMs: number): void {
    const e = this.entries.get(id)
    if (!e || this.isUp(e) || e.startOp || this.queued.has(id)) return
    const run = () => {
      this.queued.delete(id)
      this.startOne(e, false).catch((err) => this.addLog(e, 'stderr', `[devservers] ${err instanceof Error ? err.message : String(err)}`))
    }
    if (delayMs <= 0) run()
    else this.queued.set(id, setTimeout(run, delayMs))
  }

  private cancelQueued(id: string): boolean {
    const t = this.queued.get(id)
    if (!t) return false
    clearTimeout(t)
    this.queued.delete(id)
    return true
  }

  async startProject(id: string): Promise<{ ok: true }> {
    await this.ready
    this.startMany(this.mustProject(id).processIds)
    return { ok: true }
  }

  // ---- stopping --------------------------------------------------------------

  async stop(id: string): Promise<{ ok: true; process: DevWebProcess; coStopped: string[] }> {
    await this.ready
    const e = this.must(id)
    await this.refresh(true)
    // A linked group is one unit: stopping any member brings it all down. Companions stay (a shared database must not
    // die because one consumer stopped).
    const group = linkedGroupIds(e.def, this.defsList())
    const coStopped = group.filter((gid) => {
      const ge = this.entries.get(gid)
      return !!ge && (!!ge.child || ge.pendingStart || this.queued.has(gid) || !!ge.outside)
    })
    await Promise.all([id, ...group].map((x) => this.stopEntry(this.entries.get(x)!)))
    return { ok: true, process: this.view(e), coStopped }
  }

  async stopProject(id: string): Promise<{ ok: true }> {
    await this.ready
    const p = this.mustProject(id)
    await this.refresh(true)
    await Promise.all(p.processIds.map((pid) => this.stopEntry(this.entries.get(pid)!)))
    return { ok: true }
  }

  async restart(id: string): Promise<{ ok: true; process: DevWebProcess }> {
    await this.ready
    const e = this.must(id)
    await this.refresh(true)
    await this.stopEntry(e)
    e.restarts += 1
    await this.startOne(e, false)
    return { ok: true, process: this.view(e) }
  }

  private stopEntry(e: Entry): Promise<void> {
    this.cancelQueued(e.def.id)
    e.generation++ // overtakes a start still looking or waiting
    if (e.pendingStart && !e.child) {
      e.pendingStart = false
      e.waitingOnPort = null
      e.status = 'stopped'
      return Promise.resolve()
    }
    if (e.child) {
      if (e.stopping) return new Promise((resolve) => e.exitWaiters.push(resolve))
      e.stopping = true
      e.status = 'stopping'
      const child = e.child
      const pid = e.pid
      return new Promise((resolve) => {
        e.exitWaiters.push(resolve)
        if (!pid) {
          this.finish(e, child, 'stopped', null)
          return
        }
        this.safeKill(pid)
        // The exit event ends the stop; if it never comes the grace timer forces the state.
        e.stopTimer = setTimeout(() => {
          if (e.child !== child) return
          this.safeKill(pid)
          this.finish(e, child, 'stopped', null)
        }, KILL_GRACE_MS)
      })
    }
    if (e.outside) return this.stopOutside(e)
    return Promise.resolve()
  }

  /** An outside server was asked to stop (a person or chat asked): its pid's tree is ended, then its port is waited for. */
  private async stopOutside(e: Entry): Promise<void> {
    const o = e.outside
    if (!o) return
    e.stopping = true // keeps the status look from taking it up again while it goes down
    try {
      this.dropOutside(e)
      if (!this.adoptContext().selfPids.includes(o.pid)) this.safeKill(o.pid)
      if (o.port) {
        const until = Date.now() + OUTSIDE_STOP_WAIT_MS
        while (Date.now() < until && (await this.safeListening(o.port))) await sleep(150)
      }
    } finally {
      e.stopping = false
    }
  }

  // ---- loading projects -------------------------------------------------------

  async load(input: string): Promise<LoadAnswer> {
    await this.ready
    const target = resolveLoadTarget(input)
    if (target.kind === 'none') throw new DevServerError(target.message, 400)
    if (target.kind === 'scaffold') return { needsScaffold: true, dir: target.dir, fileName: target.fileName, proposal: target.proposal }
    return this.loadFile(target.file, true)
  }

  /** A file already in the registry autostarts its servers on a load; a first load (and a scaffold) starts nothing. */
  private async loadFile(file: string, autostart: boolean): Promise<{ ok: true; project: DevWebProject; firstLoad: boolean }> {
    let lp: LoadedProject
    try {
      lp = readProjectFile(file)
    } catch (e) {
      throw new DevServerError((e as Error).message, 400)
    }
    const reg = withPath(this.registry, file)
    const firstLoad = reg.added
    if (reg.added) {
      this.registry = reg.list
      this.persistRegistry()
    }
    if (this.projects.has(lp.id)) this.reconcile(lp)
    else this.addProject(lp)
    this.watcher?.sync()
    if (!firstLoad && autostart) this.startMany(lp.processes.filter((d) => this.willAutostart(d)).map((d) => d.id))
    await this.refresh(true)
    return { ok: true, project: this.projectView(this.projects.get(lp.id)!), firstLoad }
  }

  async scaffold(dir: string, fileName: string, project: ScaffoldProposal): Promise<{ ok: true; project: DevWebProject; firstLoad: boolean; created: string }> {
    await this.ready
    let created: string
    try {
      created = writeScaffold(dir, fileName, project)
    } catch (e) {
      throw new DevServerError((e as Error).message, 400)
    }
    return { ...(await this.loadFile(created, false)), created }
  }

  folder(cwd: string) {
    return setUpFolder(this, cwd)
  }

  // ---- a chat's tool ---------------------------------------------------------

  async ensure(cwd: string, server?: string, wait = true): Promise<DevWebEnsure> {
    const f = await this.folder(cwd)
    if ('nothing' in f) return { ok: false, error: f.nothing }
    const project = f.project
    const procs = project.processes
    const picked = server
      ? procs.find((p) => [p.id, p.localId, p.name].some((n) => n.toLowerCase() === server.trim().toLowerCase()))
      : (procs.find((p) => p.starred) ?? procs.find((p) => p.autostart) ?? (procs.length === 1 ? procs[0] : undefined))
    if (!picked) {
      const choices = procs.map((p) => p.localId)
      return { ok: false, error: server ? `${project.name} has no server "${server}".` : `${project.name} has several servers: say which one to start.`, choices }
    }
    const e = this.must(picked.id)
    let reused: boolean
    try {
      reused = (await this.start(picked.id)).reused
    } catch (err) {
      if (err instanceof DevServerError) return { ok: false, error: err.message, process: this.view(e) }
      throw err
    }
    const tail = () => e.logs.slice(-20).map((l) => l.line)
    if (wait) {
      const deadline = Date.now() + ENSURE_WAIT_MS
      for (;;) {
        await this.refresh()
        const status = this.view(e).status
        if (status === 'running') break
        if (status === 'stopped' || status === 'crashed') {
          const code = e.exitCode === null ? '' : ` (exit code ${e.exitCode})`
          return { ok: false, error: `${e.def.name} stopped right after it started${code}.`, process: this.view(e), logTail: tail() }
        }
        if (Date.now() >= deadline) {
          const where = e.def.port ? ` on port ${e.def.port}` : ''
          return { ok: false, error: `${e.def.name} did not answer${where} within ${ENSURE_WAIT_MS / 1000} s.`, process: this.view(e), logTail: tail() }
        }
        await sleep(ENSURE_POLL_MS)
      }
    }
    const proc = this.view(e)
    return { ok: true, reused, process: proc, url: processAddress(proc), project: this.projectView(this.projects.get(e.def.projectId)!) }
  }

  // ---- what the service and the localhost list read -----------------------------

  async owned(): Promise<{ ports: number[]; pids: number[] }> {
    await this.ready
    await this.refresh()
    const ports = new Set<number>()
    const pids = new Set<number>()
    for (const e of this.entries.values()) {
      if (e.child) {
        if (e.pid) pids.add(e.pid)
        if (e.def.port) ports.add(e.def.port)
      } else if (e.outside) {
        pids.add(e.outside.pid)
        const port = e.outside.port ?? e.def.port
        if (port) ports.add(port)
      }
    }
    return { ports: [...ports], pids: [...pids] }
  }

  runningIds(): string[] {
    return [...this.entries.values()].filter((e) => e.child && !e.stopping).map((e) => e.def.id)
  }

  async stopAll(): Promise<void> {
    this.closed = true
    for (const t of this.queued.values()) clearTimeout(t)
    this.queued.clear()
    this.watcher?.stop()
    await Promise.all([...this.entries.values()].map((e) => (e.child || e.pendingStart ? this.stopEntry(e) : Promise.resolve())))
  }

  killAllSync(): void {
    this.closed = true
    for (const t of this.queued.values()) clearTimeout(t)
    this.queued.clear()
    this.watcher?.stop()
    for (const e of this.entries.values()) {
      this.clearTimers(e)
      if (e.child && e.pid) this.safeKill(e.pid)
    }
  }
}

export const createDevServers: CreateDevServers = (deps) => new Manager(deps)
