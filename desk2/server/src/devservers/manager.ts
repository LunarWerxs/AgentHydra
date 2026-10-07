// The dev-server manager the dev-servers service runs: DevWebUI's manager (start/stop/restart with linked groups,
// companions and waitForPort ordering; the staggered batch queue; the per-server log ring; the live reload of
// `.devwebui` files), compose dependencies, prompt answers, metrics, alerts, the errors panel and the log vault, and
// with what it adds: one copy per server. A server already answering on its port, or running from its folder, is used
// as it is (`outside`) and never started twice; a port held by something that is not a dev server is a `conflict` and
// a start is refused. A process is ended to free a port only when asked (free port, confirmed) or when the
// freePortOnStart setting is on and the holder is a dev server or an app; AgentHydra's own and OS pids never are.
//
// Dev servers are this process's children (stdio piped, hidden), so ending the service ends them (stopAll on a clean
// exit, killAllSync on a crash). The service itself is started outside Desk's tree (service.ts), so a Desk restart
// leaves them running.

import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  type DevWebAddResult,
  type DevWebAlertRule,
  type DevWebAlertRuleInput,
  type DevWebAlerts,
  type DevWebErrorEntry,
  type DevWebFreePort,
  type DevWebOpenInEditor,
  type DevWebEnsure,
  type DevWebFound,
  type DevWebLogLine,
  type DevWebMetricPoint,
  type DevWebMetricsHistory,
  type DevWebPreview,
  type DevWebProcess,
  type DevWebProcessSpec,
  type DevWebProcessStatus,
  type DevWebProject,
  type DevWebScanPreset,
  type DevWebScanResult,
  type DevWebSettings,
  type DevWebStartAnswer,
  type DevWebTakeover,
  type DevWebTakeOverResult,
  folderContains,
  processAddress
} from '@shared/devwebui'
import { killHostTree } from '../host/launch'
import { type Scan, scanPorts } from '../localhost/ports'
import { type AdoptContext, findByFolder, judgePort } from './adopt'
import { stripAnsi } from './ansi'
import type { CreateDevServers, DevServers, DevServersDeps, LoadAnswer, ScaffoldProposal } from './contract'
import { DevServerError } from './contract'
import { setUpFolder } from './folder'
import { coStartIds, DependencyCycleError, linkedGroupIds, orderByDependency, resolveWaitPort } from './links'
import { fileUrlToLocalPath, resolveLoadTarget, writeScaffold } from './load'
import { type LoadedProject, type ProcessDef, parseJsonText, parseProjectSpec, readProjectFile, samePath } from './project-file'
import { dataDir, defaultImportDir, loadFiles, readResume, removeResume, type StateShape, withPath, writeRegistry, writeState } from './registry'
import { type AnswerRule, answerText, PromptAnswerer } from './answers'
import { AlertStore } from './alerts'
import { type ComposeSpec, composeActive, composeKey, prepareCompose, stopComposeServices } from './compose'
import { ErrorStore } from './errors'
import { asOwner, portHolders, refusal, treeRefusal } from './free-port'
import { LogVault } from './log-vault'
import { sampleMetrics } from './metrics'
import { openInEditor } from './open-in-editor'
import { cloneRepo, repoNameFromUrl, suggestCloneParent } from './clone'
import { addSpec, editProject, readSpec, removeSpec, replaceSpec, setStarredInFile } from './edit'
import { addIgnored, forgetFound, listFound, mergeScan, readFound, readIgnored, removeIgnored } from './found'
import { detectProjectRuntime, effectiveRuntime, withRuntime } from './runtime'
import { scanExcludes, scanProjects } from './scan'
import { defaultSettings, cleanSettingsPatch, readSettings, writeSettings } from './settings'
import { planManagedSpawn } from './spawn-plan'
import { detectAutostartTriggers, restoreAutostart, takeOverAutostart, takeoverBackups } from './takeover'
import { createProjectWatch, type ProjectWatch } from './watch'

const MAX_LOGS = 500
/** The least time between two status looks (a forced look, before a start, ignores it). */
const LOOK_MIN_MS = 1500
/** A port scan is reused this long when a probe found a listener we do not own. */
const SCAN_TTL_MS = 8000
/** A server with no port is found by scanning; at most this often while it is down. */
const PORTLESS_SCAN_MS = 10_000
/**
 * The longest a page read waits for a status look before answering with what is known; the look runs on and the next
 * poll shows it. A port scan took 1.8 to 5.3 s on a PC with 880 processes at full CPU (2026-10-07), and the page's poll
 * gives up at 2 s and calls the service down: with a 1 s wait, 5 reads in 60 still went over through Desk's hop.
 */
const READ_WAIT_MS = 250
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
const SAMPLE_MS = 3000
/** How far back each server's samples are kept for the info pane's charts: 10 minutes, 200 samples at SAMPLE_MS. */
const METRICS_WINDOW_MS = 10 * 60_000

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
  /** An outside server being ended, until its port goes quiet: a start waits for it rather than spawn on top of it. */
  outsideStop: Promise<void> | null
  exitWaiters: Array<() => void>
  /** Bumped by every start and stop: a start that finds it moved was overtaken (stopped meanwhile) and gives up. */
  generation: number
  readyTimer: ReturnType<typeof setInterval> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  /** Connection env from the compose stack this run depends on. */
  composeEnv: Record<string, string> | null
  /** The compose hold this run is a user of. */
  composeKey: string | null
}

/** A compose stack shared by the servers that name the same file; the services this service started are stopped with the last user. */
interface ComposeHold {
  spec: ComposeSpec
  cwd: string
  users: Set<string>
  started: Set<string>
  /** The compose mode of every server that has used this hold. */
  modes: Set<string>
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
  /** The live settings (settings.json): S2's sampler and the free-port start read it. */
  settingsNow: DevWebSettings = defaultSettings()
  private firstScanDone = false
  private readonly vault: LogVault
  private readonly errorStore: ErrorStore
  private readonly alertStore: AlertStore
  private sampler: ReturnType<typeof setInterval> | null = null
  private sampling = false
  private lastMetrics = new Map<string, { cpu: number | null; memory: number | null }>()
  /** Each server's samples of the last METRICS_WINDOW_MS, oldest first, for the info pane's charts (metricsHistory). */
  private metricsRing = new Map<string, DevWebMetricPoint[]>()
  private composeHolds = new Map<string, ComposeHold>()
  private composeStops = new Set<Promise<void>>()
  /** Compose bring-ups still running `up`; stopAll waits for them so a cancelled one queues its stop first. */
  private composeStarts = new Set<Promise<boolean>>()
  private scanRunning: { preset: DevWebScanPreset; startedAt: number } | null = null

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
    this.vault = new LogVault(path.join(dataDir(this.home), 'logs'))
    this.errorStore = new ErrorStore(path.join(dataDir(this.home), 'errors.ndjson'))
    this.alertStore = new AlertStore(dataDir(this.home))
    this.ready = this.boot().catch((e) => this.note(`start-up failed: ${(e as Error).message}`))
  }

  // ---- boot, registry, state ------------------------------------------------

  private async boot(): Promise<void> {
    const importFrom = this.importFrom()
    try {
      const s = readSettings(this.home, importFrom)
      this.settingsNow = s.settings
      this.firstScanDone = s.firstScanDone
    } catch (e) {
      this.note(`could not read the settings: ${(e as Error).message}`)
    }
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
    else if (this.settingsNow.autoStartOnLaunch) this.startMany(this.defsList().filter((d) => this.willAutostart(d)).map((d) => d.id))
    removeResume(this.home)
    // Never blocks `ready`: the first start always scans once, later ones only with autoScan on. A null importFrom is a
    // test home: it must not walk the real disk.
    if (importFrom !== null && (this.settingsNow.autoScan || !this.firstScanDone)) {
      void this.scan({ preset: 'startup' })
        .then(() => {
          this.firstScanDone = true
          this.persistSettings()
        })
        .catch((e) => this.note(`start-up scan failed: ${(e as Error).message}`))
    }
  }

  private importFrom(): string | null {
    return this.deps.importFrom === undefined ? defaultImportDir() : this.deps.importFrom
  }

  private persistSettings(): void {
    try {
      writeSettings(this.home, this.settingsNow, this.firstScanDone)
    } catch (e) {
      this.note(`could not write the settings: ${(e as Error).message}`)
    }
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
      outsideStop: null,
      exitWaiters: [],
      generation: 0,
      readyTimer: null,
      stopTimer: null,
      composeEnv: null,
      composeKey: null,
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
    this.releaseCompose(e)
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
      this.vault.delete(pid)
      this.errorStore.clear(pid)
      this.alertStore.removeForProcess(pid)
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
    const metrics = this.settingsNow.monitorResources && (own || e.outside) ? this.lastMetrics.get(d.id) : undefined
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
      ...(d.runtime ? { runtime: d.runtime } : {}),
      ...(d.waitForPort !== undefined ? { waitForPort: d.waitForPort } : {}),
      ...(d.links?.length ? { links: d.links } : {}),
      ...(d.companion !== undefined ? { companion: d.companion } : {}),
      cpu: metrics?.cpu ?? null,
      memory: metrics?.memory ?? null,
      errorCount: this.errorStore.count(d.id),
      alertsFiring: this.alertStore.firing(d.id),
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
    await this.readRefresh()
    this.syncSampler()
    return [...this.projects.values()].map((p) => this.projectView(p))
  }

  async process(id: string): Promise<DevWebProcess | null> {
    await this.ready
    await this.readRefresh()
    const e = this.entries.get(id)
    return e ? this.view(e) : null
  }

  async logs(id: string): Promise<DevWebLogLine[]> {
    await this.ready
    const e = this.must(id)
    await this.readRefresh()
    if (!e.child && e.outside) {
      return [{ stream: 'stdout', line: `[devservers] this server was started outside AgentHydra (pid ${e.outside.pid}); its output is not available here.`, ts: this.now() }]
    }
    return [...e.logs]
  }

  async logPage(id: string, opts: { before?: number; limit?: number }): Promise<{ lines: DevWebLogLine[]; more: boolean }> {
    await this.ready
    this.must(id)
    return this.vault.page(id, opts)
  }

  async errors(processId?: string): Promise<DevWebErrorEntry[]> {
    await this.ready
    return this.errorStore.list(processId)
  }

  async dismissError(fingerprint: string): Promise<{ ok: true }> {
    await this.ready
    if (!this.errorStore.dismiss(fingerprint)) throw new DevServerError('No such error.', 404)
    return { ok: true }
  }

  async clearErrors(processId?: string): Promise<{ ok: true }> {
    await this.ready
    this.errorStore.clear(processId)
    return { ok: true }
  }

  async openInEditor(req: { file: string; line?: number; column?: number; processId?: string }): Promise<DevWebOpenInEditor> {
    await this.ready
    return openInEditor(req, req.processId ? this.must(req.processId).def.cwd : undefined)
  }

  async alerts(): Promise<DevWebAlerts> {
    await this.ready
    return this.alertStore.list()
  }

  async addAlert(input: DevWebAlertRuleInput): Promise<DevWebAlertRule> {
    await this.ready
    if (typeof input?.processId === 'string') this.must(input.processId)
    return this.alertStore.add(input)
  }

  async updateAlert(id: string, patch: Partial<DevWebAlertRuleInput>): Promise<DevWebAlertRule> {
    await this.ready
    return this.alertStore.update(id, patch)
  }

  async removeAlert(id: string): Promise<{ ok: true }> {
    await this.ready
    this.alertStore.remove(id)
    return { ok: true }
  }

  async clearAlertEvents(): Promise<{ ok: true }> {
    await this.ready
    this.alertStore.clearEvents()
    return { ok: true }
  }

  /** A server's CPU and memory samples of the last METRICS_WINDOW_MS, oldest first (empty while monitoring is off or it never ran). */
  async metricsHistory(id: string): Promise<DevWebMetricsHistory> {
    await this.ready
    this.must(id)
    const since = this.now() - METRICS_WINDOW_MS
    const points = (this.metricsRing.get(id) ?? []).filter((p) => p.t >= since)
    return { id, sampleMs: SAMPLE_MS, windowMs: METRICS_WINDOW_MS, points }
  }

  /** Adds a sample to a server's ring and drops what fell out of the window (the ring never holds more than the window's worth). */
  private remember(id: string, point: DevWebMetricPoint, at: number): void {
    const ring = this.metricsRing.get(id) ?? []
    ring.push(point)
    const since = at - METRICS_WINDOW_MS
    let drop = 0
    while (drop < ring.length && ring[drop].t < since) drop++
    const cap = Math.ceil(METRICS_WINDOW_MS / SAMPLE_MS) + 1
    if (ring.length - drop > cap) drop = ring.length - cap
    if (drop) ring.splice(0, drop)
    this.metricsRing.set(id, ring)
  }

  // The sampler runs only while resource monitoring is on and something runs; a start and each list look re-check that.
  syncSampler(): void {
    const up = [...this.entries.values()].some((e) => e.child || e.outside)
    if (!this.closed && this.settingsNow.monitorResources && up) this.sampler ??= setInterval(() => void this.sample(), SAMPLE_MS)
    else this.stopSampler()
  }

  private stopSampler(): void {
    if (this.sampler) clearInterval(this.sampler)
    this.sampler = null
    this.lastMetrics.clear()
  }

  private async sample(): Promise<void> {
    if (this.sampling) return
    this.sampling = true
    try {
      const pidOf = (e: Entry) => (e.child && !e.stopping ? e.pid : (e.outside?.pid ?? null))
      const pids = [...this.entries.values()].flatMap((e) => pidOf(e) ?? [])
      if (!this.settingsNow.monitorResources || !pids.length) return this.syncSampler()
      const got = await sampleMetrics(pids)
      if (this.closed) return
      this.lastMetrics.clear()
      const at = this.now()
      const samples = [...this.entries.values()].map((e) => {
        const pid = pidOf(e)
        const m = pid ? got[pid] : undefined
        if (m) {
          this.lastMetrics.set(e.def.id, { cpu: m.cpu, memory: m.memory })
          this.remember(e.def.id, { t: at, cpu: m.cpu, memory: m.memory }, at)
        }
        const d = e.def
        return { processId: d.id, processName: d.name, projectId: d.projectId, projectName: d.projectName, cpu: m?.cpu ?? null, memory: m?.memory ?? null }
      })
      this.alertStore.evaluate(samples)
    } catch (err) {
      this.note(`resource sample failed: ${(err as Error).message}`)
    } finally {
      this.sampling = false
    }
  }

  private async quiet(port: number): Promise<void> {
    const until = Date.now() + OUTSIDE_STOP_WAIT_MS
    while (Date.now() < until && (await this.safeListening(port))) await sleep(150)
  }

  private holdersOf(port: number, scan: Scan) {
    const managed = [...this.entries.values()].flatMap((x) => (x.child && x.pid ? [{ id: x.def.id, pid: x.pid }] : []))
    return portHolders(port, scan, this.adoptContext(), managed, this.now())
  }

  async freePort(id: string, confirmPids?: number[]): Promise<DevWebFreePort> {
    await this.ready
    const port = this.must(id).def.port
    if (!port) return { ok: true }
    const scan = await this.getScan(0)
    const holders = this.holdersOf(port, scan)
    if (!holders.length) return { ok: true, owners: [] }
    const external = holders.filter((h) => !h.managedId)
    const refused = refusal(port, holders) ?? treeRefusal(external, scan, this.adoptContext())
    if (refused) return { refused }
    // Nothing is stopped or ended until every outside holder is one the person saw and confirmed by pid. The answer
    // lists them all, so confirming it again covers a holder that appeared after the first look.
    if (external.some((h) => !confirmPids?.includes(h.pid))) return { needsConfirm: true, owners: external.map(asOwner) }
    const stoppedManaged = [...new Set(holders.flatMap((h) => h.managedId ?? []))]
    await Promise.all(stoppedManaged.map((m) => this.stopEntry(this.entries.get(m)!)))
    for (const h of external) this.safeKill(h.pid)
    await this.quiet(port)
    await this.refresh(true)
    return { ok: true, stoppedManaged, owners: external.map(asOwner) }
  }

  /** The freePortOnStart setting: a conflict held by a dev server or an app is ended; anything else stays a refusal. */
  private async freeConflict(e: Entry): Promise<boolean> {
    const port = e.def.port
    if (!this.settingsNow.freePortOnStart || !port) return false
    const scan = await this.getScan(0)
    const holders = this.holdersOf(port, scan)
    const external = holders.filter((h) => !h.managedId)
    if (!holders.length || refusal(port, holders) || treeRefusal(external, scan, this.adoptContext()) || external.some((h) => h.kind !== 'app' && h.kind !== 'dev')) return false
    await Promise.all([...new Set(holders.flatMap((h) => h.managedId ?? []))].map((m) => this.stopEntry(this.entries.get(m)!)))
    for (const h of external) {
      this.addLog(e, 'stdout', `[devservers] freeing port ${port}: ending ${h.name} (pid ${h.pid})`)
      this.safeKill(h.pid)
    }
    await this.quiet(port)
    await this.refresh(true)
    return !e.conflict
  }

  /** Brings the compose stack up before the spawn; false when the start ended (failed or was overtaken). */
  private async bringUpCompose(e: Entry, spec: ComposeSpec, gen: number): Promise<boolean> {
    const key = composeKey(spec, e.def.cwd)
    const hold = this.composeHolds.get(key) ?? { spec, cwd: e.def.cwd, users: new Set<string>(), started: new Set<string>(), modes: new Set<string>() }
    this.composeHolds.set(key, hold)
    hold.users.add(e.def.id)
    hold.modes.add(spec.mode ?? 'start-only')
    e.composeKey = key
    this.addLog(e, 'stdout', '[devservers] bringing up compose dependencies...')
    const out = await prepareCompose(spec, e.def.cwd).catch((err) => ({ ok: false as const, reason: (err as Error).message, started: undefined }))
    for (const s of out.started ?? []) hold.started.add(s)
    const cancelled = !e.pendingStart || e.generation !== gen || this.entries.get(e.def.id) !== e || this.closed
    if (cancelled) {
      // A stop that overtook this start already let go of the hold; what `up` started still gets its release.
      this.composeHolds.set(key, hold)
      hold.users.add(e.def.id)
      e.composeKey = key
      this.releaseCompose(e)
      return false
    }
    if (!out.ok) {
      this.addLog(e, 'stderr', `[devservers] compose dependencies failed: ${out.reason}; not starting.`)
      e.pendingStart = false
      e.status = 'stopped'
      this.releaseCompose(e)
      this.resolveWaiters(e)
      return false
    }
    e.composeEnv = out.env
    const keys = Object.keys(out.env)
    this.addLog(e, 'stdout', `[devservers] compose dependencies are ready${keys.length ? `; injected ${keys.join(', ')}` : ''}`)
    return true
  }

  /** Lets go of the compose stack this run used; the last user stops what this service started (start-and-stop only). */
  private releaseCompose(e: Entry): void {
    const key = e.composeKey
    e.composeKey = null
    e.composeEnv = null
    const hold = key ? this.composeHolds.get(key) : undefined
    if (!key || !hold) return
    hold.users.delete(e.def.id)
    if (hold.users.size) return
    this.composeHolds.delete(key)
    if (!hold.started.size || !hold.modes.has('start-and-stop')) return
    // A server that asked to keep the stack up wins over one that asked to stop it.
    if (hold.modes.size > 1) {
      this.note(`compose stack ${key} is left running: the servers sharing it ask for different compose modes`)
      return
    }
    const stop: Promise<void> = stopComposeServices(hold.spec, hold.cwd, [...hold.started])
      .then((why) => {
        if (why) this.note(`could not stop the compose services: ${why}`)
      })
      .catch((err) => this.note(`could not stop the compose services: ${(err as Error).message}`))
      .finally(() => this.composeStops.delete(stop))
    this.composeStops.add(stop)
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

  /** A page read's refresh: the look runs on, the answer waits for it at most READ_WAIT_MS. */
  private async readRefresh(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.refresh(), new Promise<void>((resolve) => (timer = setTimeout(resolve, READ_WAIT_MS)))])
    clearTimeout(timer)
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
    const had = e.outside?.pid === pid ? e.outside : null
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
    // Before a start or stop acts on a server taken up as outside, the program on its port is looked at again.
    const recheck = force && cands.some((e) => e.def.port && answers.get(e.def.port) && e.outside?.port === e.def.port)
    const portless = cands.filter((e) => !e.def.port && !e.outside)
    let scan: Scan | null = null
    if (recheck) scan = await this.getScan(LOOK_MIN_MS)
    else if (needVerdict.length) {
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
          const pids = scan?.listeners.filter((l) => l.port === port).map((l) => l.pid) ?? []
          // The same program, or no scan to tell: still the server taken up. Another program there is judged afresh.
          if (!pids.length || pids.includes(e.outside.pid)) continue
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
    // A start already waiting for its dependency port is this start: a new generation would cancel that wait and
    // leave it waiting for good.
    if (e.pendingStart && !e.child) return this.answer(e, true, [])
    this.cancelQueued(e.def.id)
    const gen = ++e.generation
    await this.refresh(true)
    const overtaken = () => e.generation !== gen || this.entries.get(e.def.id) !== e || this.closed
    if (overtaken()) return this.answer(e, false, [])
    if (e.child && e.stopping) {
      await new Promise<void>((r) => e.exitWaiters.push(r))
      if (overtaken()) return this.answer(e, false, [])
    }
    // An outside server still going down holds its port: start once it has gone, or use it if it never goes.
    if (e.outsideStop) {
      await e.outsideStop
      if (overtaken()) return this.answer(e, false, [])
      await this.refresh(true)
      if (overtaken()) return this.answer(e, false, [])
    }
    if (this.isUp(e)) {
      if (e.outside) this.addLog(e, 'stdout', `[devservers] ${e.outside.port ? `port ${e.outside.port} already answers` : 'it already runs'}: using the server that runs there (pid ${e.outside.pid}).`)
      return this.answer(e, true, [])
    }
    if (e.conflict && !(await this.freeConflict(e))) throw new DevServerError(`${e.conflict}, so ${e.def.name} was not started (a program is never ended to free a port).`, 409)

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
    if (composeActive(e.def.compose)) {
      const gen = e.generation
      e.pendingStart = true
      e.waitingOnPort = null
      e.status = 'waiting'
      const up: Promise<boolean> = this.bringUpCompose(e, e.def.compose, gen).finally(() => this.composeStarts.delete(up))
      this.composeStarts.add(up)
      void up.then((ok) => {
        if (!ok) return
        e.pendingStart = false
        this.beginAfterCompose(e)
      })
      return
    }
    this.beginAfterCompose(e)
  }

  private beginAfterCompose(e: Entry): void {
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
    const env = { ...inherited, ...e.composeEnv, ...def.env }
    const runtime = effectiveRuntime(def.runtime, this.settingsNow.runtime, detectProjectRuntime(def.cwd))
    const plan = planManagedSpawn(withRuntime(def.command, runtime), { cwd: def.cwd, env })
    // stdin is a pipe only for a server with answers to type.
    const answering = !!def.answers?.length
    const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] = [answering ? 'pipe' : 'ignore', 'pipe', 'pipe']
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
    const answerer = answering ? new PromptAnswerer(def.answers) : null
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString()
      this.addLog(e, 'stdout', text)
      this.recordError(e, 'stdout', text)
      if (answerer) this.answerWith(e, child, answerer.feed(text))
    })
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      this.addLog(e, 'stderr', text)
      this.recordError(e, 'stderr', text)
      if (answerer) this.answerWith(e, child, answerer.feed(text))
    })
    child.on('error', (err) => this.spawnFailed(e, child, err))
    child.on('exit', (code) => this.handleExit(e, child, code))
    if (answerer) this.answerWith(e, child, answerer.start())
    if (e.pid) this.watchReady(e, child)
    this.syncSampler()
  }

  /** Types the reply of each rule that fired; the log says which rule, never the text (it may be a password). */
  private answerWith(e: Entry, child: ChildProcess, fired: AnswerRule[]): void {
    for (const rule of fired) {
      try {
        child.stdin?.write(answerText(rule))
      } catch {
        continue
      }
      this.addLog(e, 'stdout', `[devservers] typed the reply from answers rule #${(e.def.answers?.indexOf(rule) ?? -1) + 1}`)
    }
  }

  private recordError(e: Entry, source: 'stdout' | 'stderr' | 'crash', text: string): void {
    const d = e.def
    this.errorStore.record({ processId: d.id, localId: d.localId, processName: d.name, projectId: d.projectId, projectName: d.projectName, cwd: d.cwd }, source, text)
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
    this.releaseCompose(e)
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
    if (crashed) this.recordError(e, 'crash', `Process exited with code ${code}`)
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
    this.releaseCompose(e)
    this.resolveWaiters(e)
  }

  private addLog(e: Entry, stream: DevWebLogLine['stream'], text: string): void {
    const ts = this.now()
    for (const raw of stripAnsi(text).split(/\r?\n/)) if (raw) e.logs.push({ stream, line: raw, ts, seq: this.vault.add(e.def.id, stream, raw, ts) })
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
    // A start still looking when the stop came was overtaken by it: it ends first, and this one starts afresh.
    await e.startOp?.catch(() => undefined)
    e.restarts += 1
    const answer = await this.startOne(e, false)
    // Still served after the stop (a straggler of the old run's tree, taken up as outside): ended too, then started, once.
    if (answer.reused && e.outside) {
      await this.stopEntry(e)
      await this.startOne(e, false)
    }
    return { ok: true, process: this.view(e) }
  }

  private stopEntry(e: Entry): Promise<void> {
    this.cancelQueued(e.def.id)
    e.generation++ // overtakes a start still looking or waiting
    if (e.pendingStart && !e.child) {
      e.pendingStart = false
      e.waitingOnPort = null
      e.status = 'stopped'
      this.releaseCompose(e)
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
    if (e.outsideStop) return e.outsideStop
    if (e.outside) return this.stopOutside(e)
    return Promise.resolve()
  }

  /** An outside server was asked to stop (a person or chat asked): its pid's tree is ended, then its port is waited for. */
  private stopOutside(e: Entry): Promise<void> {
    const o = e.outside
    if (!o) return Promise.resolve()
    this.dropOutside(e)
    if (!this.adoptContext().selfPids.includes(o.pid)) this.safeKill(o.pid)
    const port = o.port
    if (!port) return Promise.resolve()
    e.stopping = true // keeps the status look from taking it up again while it goes down
    const quiet = async () => {
      const until = Date.now() + OUTSIDE_STOP_WAIT_MS
      while (Date.now() < until && (await this.safeListening(port))) await sleep(150)
    }
    const done: Promise<void> = quiet().finally(() => {
      if (e.outsideStop === done) e.outsideStop = null
      if (!e.child) e.stopping = false
    })
    e.outsideStop = done
    return done
  }

  // ---- loading projects -------------------------------------------------------

  async load(input: string): Promise<LoadAnswer> {
    await this.ready
    const target = resolveLoadTarget(input)
    if (target.kind === 'none') throw new DevServerError(target.message, 400)
    if (target.kind === 'scaffold') return { needsScaffold: true, dir: target.dir, fileName: target.fileName, proposal: target.proposal, ...this.triggersOf(target.dir) }
    return { ...(await this.loadFile(target.file, true)), ...this.triggersOf(path.dirname(target.file)) }
  }

  /** `{ autostartTriggers }` when the folder also starts its server from outside AgentHydra, else nothing. */
  private triggersOf(dir: string): { autostartTriggers?: ReturnType<typeof detectAutostartTriggers> } {
    const autostartTriggers = detectAutostartTriggers(dir)
    return autostartTriggers.length ? { autostartTriggers } : {}
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

  async scaffold(dir: string, fileName: string, project: ScaffoldProposal): Promise<{ ok: true; project: DevWebProject; firstLoad: boolean; created: string; autostartTriggers?: ReturnType<typeof detectAutostartTriggers> }> {
    await this.ready
    let created: string
    try {
      created = writeScaffold(dir, fileName, project)
    } catch (e) {
      throw new DevServerError((e as Error).message, 400)
    }
    return { ...(await this.loadFile(created, false)), created, ...this.triggersOf(path.dirname(created)) }
  }

  async found(): Promise<DevWebFound> {
    await this.ready
    return { items: listFound(this.home, this.registry, readIgnored(this.home, this.importFrom())), scanning: this.scanRunning, lastScan: readFound(this.home).lastScan }
  }

  async scan(opts: { preset: DevWebScanPreset; roots?: string[] }): Promise<DevWebScanResult> {
    if (opts.preset === 'scoped' && !opts.roots?.length) throw new DevServerError('A scoped scan needs at least one folder.', 400)
    const startedAt = this.now()
    this.scanRunning = { preset: opts.preset, startedAt }
    try {
      const res = await (this.deps.findProjects ?? scanProjects)({ preset: opts.preset, roots: opts.roots, exclude: scanExcludes(this.settingsNow) })
      mergeScan(this.home, res, opts.preset, this.now())
      return res
    } finally {
      // A second scan may have taken over the flag: only the one that set it clears it.
      if (this.scanRunning?.startedAt === startedAt) this.scanRunning = null
    }
  }

  async forgetFound(): Promise<{ ok: true }> {
    forgetFound(this.home)
    return { ok: true }
  }

  async preview(input: string): Promise<DevWebPreview> {
    const target = resolveLoadTarget(input)
    if (target.kind === 'none') return { kind: 'none', error: target.message }
    if (target.kind === 'scaffold') return { kind: 'detected', dir: target.dir, fileName: '.devwebui', proposal: target.proposal }
    try {
      const spec = parseProjectSpec(parseJsonText(readFileSync(target.file, 'utf8')))
      return {
        kind: 'file',
        path: target.file,
        name: spec.name,
        ...(spec.color ? { color: spec.color } : {}),
        processes: spec.processes.map((p) => ({ id: p.id, name: p.name, command: p.command, ...(p.port !== undefined ? { port: p.port } : {}) }))
      }
    } catch (e) {
      return { kind: 'file', path: target.file, name: path.basename(path.dirname(target.file)), processes: [], error: (e as Error).message }
    }
  }

  /** A .devwebui file (any name ending in it) stands for its folder: ignoring is by folder, and by full path only. */
  private ignoreDir(p: string): string {
    if (!path.isAbsolute(p)) throw new DevServerError('path must be a full path', 400)
    return p.toLowerCase().endsWith('.devwebui') ? path.dirname(p) : p
  }

  async ignored(): Promise<{ paths: string[] }> {
    return { paths: readIgnored(this.home, this.importFrom()) }
  }

  async ignore(p: string): Promise<{ paths: string[] }> {
    return { paths: addIgnored(this.home, this.importFrom(), this.ignoreDir(p)) }
  }

  async unignore(p: string): Promise<{ paths: string[] }> {
    return { paths: removeIgnored(this.home, this.importFrom(), this.ignoreDir(p)) }
  }

  async cloneDest(url: string): Promise<{ dest: string }> {
    await this.ready
    const last = this.registry[this.registry.length - 1]
    return { dest: path.join(suggestCloneParent(last ? path.dirname(last) : null), repoNameFromUrl(url)) }
  }

  async clone(url: string, dest: string): Promise<DevWebAddResult> {
    const cloned = await cloneRepo(url, dest)
    try {
      return { ...(await this.load(cloned)), cloned }
    } catch (e) {
      if (e instanceof DevServerError) return { ok: false, cloned, error: e.message }
      throw e
    }
  }

  /** Re-reads a project's file after an edit so the change shows at once (the watcher would too, a moment later). */
  private applyFile(file: string): LoadedProject {
    let lp: LoadedProject
    try {
      lp = readProjectFile(file)
    } catch (e) {
      throw new DevServerError((e as Error).message, 400)
    }
    this.reconcile(lp)
    return lp
  }

  private mustProcessProject(e: Entry): Project {
    return this.mustProject(e.def.projectId)
  }

  async updateProject(id: string, patch: { name?: string; color?: string | null }): Promise<DevWebProject> {
    await this.ready
    const p = this.mustProject(id)
    editProject(p.path, patch)
    this.applyFile(p.path)
    return this.projectView(p)
  }

  async removeProject(id: string): Promise<{ ok: true }> {
    await this.ready
    const p = this.mustProject(id)
    for (const pid of p.processIds) {
      this.vault.delete(pid)
      this.errorStore.clear(pid)
    }
    await Promise.all(
      p.processIds.map((pid) => {
        const e = this.entries.get(pid)
        return e && (e.child || e.pendingStart || this.queued.has(pid)) ? this.stopEntry(e) : Promise.resolve()
      })
    )
    this.forgetToggles(p.processIds)
    for (const pid of p.processIds) this.alertStore.removeForProcess(pid)
    this.purge(id)
    this.registry = this.registry.filter((f) => !samePath(f, p.path))
    this.persistRegistry()
    if (id in this.state.projectEnabled) {
      delete this.state.projectEnabled[id]
      this.persistState()
    }
    this.watcher?.sync()
    return { ok: true }
  }

  async setProjectEnabled(id: string, on: boolean): Promise<DevWebProject> {
    await this.ready
    const p = this.mustProject(id)
    this.state.projectEnabled[id] = on
    this.persistState()
    return this.projectView(p)
  }

  async addProcess(projectId: string, spec: DevWebProcessSpec): Promise<DevWebProject> {
    await this.ready
    const p = this.mustProject(projectId)
    addSpec(p.path, spec)
    this.applyFile(p.path)
    return this.projectView(p)
  }

  async processConfig(id: string): Promise<DevWebProcessSpec> {
    await this.ready
    const e = this.must(id)
    return readSpec(this.mustProcessProject(e).path, e.def.localId)
  }

  async updateProcess(id: string, spec: DevWebProcessSpec): Promise<DevWebProject> {
    await this.ready
    const e = this.must(id)
    const p = this.mustProcessProject(e)
    const next = replaceSpec(p.path, e.def.localId, spec)
    const newId = `${p.id}.${next}`
    if (newId !== id && id in this.state.enabled) {
      this.state.enabled[newId] = this.state.enabled[id]!
      delete this.state.enabled[id]
      this.persistState()
    }
    this.applyFile(p.path)
    return this.projectView(p)
  }

  async removeProcess(id: string): Promise<DevWebProject> {
    await this.ready
    const e = this.must(id)
    const p = this.mustProcessProject(e)
    removeSpec(p.path, e.def.localId)
    this.vault.delete(id)
    this.errorStore.clear(id)
    this.alertStore.removeForProcess(id)
    this.metricsRing.delete(id)
    // Reconcile ends the server's own child and drops its toggle.
    this.applyFile(p.path)
    return this.projectView(p)
  }

  async setStarred(id: string, on: boolean): Promise<DevWebProcess> {
    await this.ready
    const e = this.must(id)
    const p = this.mustProcessProject(e)
    setStarredInFile(p.path, e.def.localId, on)
    this.applyFile(p.path)
    return this.view(this.must(id))
  }

  async setProcessEnabled(id: string, on: boolean): Promise<DevWebProcess> {
    await this.ready
    const e = this.must(id)
    this.state.enabled[id] = on
    this.persistState()
    return this.view(e)
  }

  async takeover(projectId: string): Promise<DevWebTakeover> {
    await this.ready
    const dir = path.dirname(this.mustProject(projectId).path)
    return { triggers: detectAutostartTriggers(dir), backups: takeoverBackups(dir) }
  }

  async takeOver(projectId: string): Promise<DevWebTakeOverResult> {
    await this.ready
    return takeOverAutostart(path.dirname(this.mustProject(projectId).path))
  }

  async restoreTakeover(projectId: string): Promise<{ ok: true; restored: string[] }> {
    await this.ready
    return { ok: true, restored: restoreAutostart(path.dirname(this.mustProject(projectId).path)) }
  }

  async startAllServers(): Promise<{ ok: true; started: string[] }> {
    await this.ready
    await this.refresh(true)
    const started = this.defsList()
      .filter((d) => this.willAutostart(d) && !this.isUp(this.entries.get(d.id)!))
      .map((d) => d.id)
    this.startMany(started)
    return { ok: true, started }
  }

  async stopAllServers(): Promise<{ ok: true; stopped: string[] }> {
    await this.ready
    await this.refresh(true)
    const up = [...this.entries.values()].filter((e) => this.isUp(e) || this.queued.has(e.def.id))
    await Promise.all(up.map((e) => this.stopEntry(e)))
    return { ok: true, stopped: up.map((e) => e.def.id) }
  }

  async settings(): Promise<DevWebSettings> {
    return structuredClone(this.settingsNow)
  }

  async saveSettings(patch: Partial<DevWebSettings>): Promise<DevWebSettings> {
    this.settingsNow = { ...this.settingsNow, ...cleanSettingsPatch(patch, this.settingsNow) }
    this.persistSettings()
    // Resource monitoring switched on or off takes effect now, not at the next list look.
    this.syncSampler()
    return this.settings()
  }

  async restartRunning(): Promise<{ ok: true; restarted: string[] }> {
    await this.ready
    const ids = this.runningIds()
    for (const id of ids) await this.restart(id)
    return { ok: true, restarted: ids }
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
          return { ok: false, error: `${e.def.name} did not answer${where} within ${ENSURE_WAIT_MS / 1000} s. It is still starting: look at its logs, and do not start a second copy.`, process: this.view(e), logTail: tail() }
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
    this.stopSampler()
    const startOps = [...this.entries.values()].filter((e) => e.startOp).map((e) => e.startOp ?? Promise.resolve())
    await Promise.race([Promise.all(startOps), new Promise((r) => setTimeout(r, 15_000))])
    await Promise.all([...this.entries.values()].map((e) => (e.child || e.pendingStart ? this.stopEntry(e) : Promise.resolve())))
    // A cancelled compose start releases its hold, queueing the stack's stop, only once its `up` returns.
    await Promise.race([Promise.all([...this.composeStarts]), sleep(15_000)])
    await Promise.all([...this.composeStops])
    this.flushStores()
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
    this.stopSampler()
    this.flushStores()
  }

  private flushStores(): void {
    for (const flush of [() => this.vault.flush(), () => this.errorStore.flush(), () => this.alertStore.flush()]) {
      try {
        flush()
      } catch (err) {
        this.note(`could not save: ${(err as Error).message}`)
      }
    }
  }
}

export const createDevServers: CreateDevServers = (deps) => new Manager(deps)
