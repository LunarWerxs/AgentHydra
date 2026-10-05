import { EventEmitter } from "node:events";
import treeKill from "tree-kill";
import { AlertStore, type AlertEvent, type AlertRule, type AlertRuleInput } from "../alerts";
import { diagnose, type Diagnosis } from "../diagnose";
import { ErrorRecorder, type ErrorInfo, type ErrorEvent, isErrorActive } from "../errors";
import { BufferedLogWriter, tailLog } from "../log-vault";
import type { RuntimePref } from "../runtime";
import { buildRuntimeServicesInfo, type RuntimeServicesInfo } from "../runtime-services";
import { getEnabledOverride, getProjectOverride } from "../state";
import type { LogLine, ProcessDef, ProcessView, ProjectView, Status } from "../types";
import { toProcessView } from "../process-view";
import { TICK_INTERVAL, METRICS_INTERVAL, type Entry, type Project } from "./types";
import { LogBuffer } from "../log-buffer";

/** Error-log identity for the daemon's own unclean shutdowns (no managed process owns them). */
export const DAEMON_ERROR_INFO: ErrorInfo = {
  processId: "devwebui:daemon",
  localId: "daemon",
  processName: "DevWebUI daemon",
  projectId: "devwebui",
  projectName: "DevWebUI",
};

/**
 * Shared state + the small, self-contained primitives every other manager
 * concern (monitoring, lifecycle, projects) builds on: entry/project maps,
 * the error recorder, emit/status plumbing, and the enable/disable toggles.
 *
 * `tick`/`metricsTick` are declared abstract here (and wired up by the
 * constructor + `applyMonitorResources`) because their real implementation —
 * the port/metrics polling loop — lives in `ManagerWithMonitoring`.
 */
export abstract class ManagerBase extends EventEmitter {
  protected entries = new Map<string, Entry>();
  protected projects = new Map<string, Project>();
  protected errorsDirty = false;
  protected errors = new ErrorRecorder(() => (this.errorsDirty = true));
  // Threshold alerting over the same CPU/memory stream (server/src/alerts.ts): evaluated
  // once per metrics tick (see ManagerWithMonitoring.pollMetrics). Fired events push out
  // over SSE the same way a newly-current error does, via alertsDirty below.
  protected alertsDirty = false;
  protected alerts = new AlertStore(() => (this.alertsDirty = true));
  // Start of THIS daemon session. Any persisted error the recorder just loaded from
  // disk was seen before now, so it's filtered out of what the GUI sees (see
  // listErrors) — the log survives for diagnosis, but stale errors never resurface
  // as a live alert on launch. Initialized right after `errors` so it post-dates the load.
  protected readonly bootedAt = Date.now();
  // Declared here (rather than in ManagerWithMonitoring, which is all that reads them)
  // so they initialize before this base constructor's call to `applyMonitorResources()`
  // — a subclass's own field initializers only run *after* its `super()` call returns.
  protected tickRunning = false;
  protected metricsRunning = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  protected queuedStarts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Live-log backpressure: buffers child output, emits it in coalesced batches. */
  protected logBatcher = new LogBuffer((batch) => this.emit("log", batch));
  /** Disk-log backpressure: one append per process per short burst, flushed on reads/shutdown. */
  protected logVaultWriter = new BufferedLogWriter();
  /** Default runtime for processes that don't pin their own. */
  globalRuntime: RuntimePref = "auto";
  /** Free a process's declared port (kill whatever holds it) right before starting it. */
  freePortOnStart = false;
  /** Sample per-process CPU + memory. Off = no system queries spawned at all. */
  monitorResources = true;
  /**
   * Connected SSE clients, maintained by `registerRealtime` (http/core.ts).
   *
   * Port-conflict probing exists to tell a WATCHING user that something else holds a
   * port. With no process running and nobody watching, that probe is pure background
   * churn — a real TCP connect+teardown per configured port every 2s, forever, on a
   * tool designed to sit idle in the tray. Zero clients + nothing running = pause it;
   * the next connecting client resumes it within one tick, so the feature is intact.
   */
  sseClients = 0;

  constructor() {
    super();
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL);
    this.applyMonitorResources();
  }

  /** Stop manager-owned timers. Primarily used by tests and short-lived embedders. */
  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    for (const timer of this.queuedStarts.values()) clearTimeout(timer);
    this.queuedStarts.clear();
    this.logVaultWriter.dispose();
  }

  /** Implemented by `ManagerWithMonitoring`: the port-probe + error-flush loop tick. */
  protected abstract tick(): Promise<void>;
  /** Implemented by `ManagerWithMonitoring`: the batched CPU/memory sampling loop tick. */
  protected abstract metricsTick(): Promise<void>;

  /**
   * Start or stop the resource-metrics loop to match `monitorResources`. Idempotent —
   * safe to call on startup and on every settings change. When turning off, we null out
   * the last-known CPU/memory and push that to the GUI so the columns go blank.
   */
  applyMonitorResources(): void {
    if (this.monitorResources) {
      if (this.metricsTimer) return;
      this.metricsTimer = setInterval(() => void this.metricsTick(), METRICS_INTERVAL);
      void this.metricsTick(); // sample once now so values appear without a 10s wait
    } else if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
      this.clearMetrics();
    }
  }

  /** Blank out CPU/memory everywhere (metrics turned off, or no longer sampling). */
  private clearMetrics(): void {
    for (const e of this.entries.values()) {
      if (e.cpu === null && e.memory === null) continue;
      e.cpu = null;
      e.memory = null;
      this.emitStatus(e);
    }
  }

  // ---- error log --------------------------------------------------------
  // The GUI only ever sees CURRENT errors — recorded this daemon session, and (for a
  // process that has since (re)started) only from its current run. Records from a
  // previous session or a previous run stay on disk for post-mortem diagnosis but
  // never resurface passively in the badge/drawer. This is the single choke point:
  // the SSE snapshot, the HTTP GET, and the live push (monitoring tick) all read it.
  listErrors(): ErrorEvent[] {
    return this.errors
      .list()
      .filter((e) =>
        isErrorActive(e, this.bootedAt, this.entries.get(e.processId)?.startedAt ?? null),
      );
  }

  clearErrors(processId?: string): void {
    this.errors.clear(processId);
  }

  dismissError(fingerprint: string): boolean {
    return this.errors.dismiss(fingerprint);
  }

  /**
   * Record that the DAEMON itself went down uncleanly (crash-sentinel.ts found a leftover run).
   * It goes through the same fingerprinting as a process crash, so a daemon that keeps dying for
   * one reason shows as one entry with a count, and safe mode's banner can link straight to it.
   */
  recordDaemonCrash(reason: string | null): string | null {
    const text = reason
      ? `DevWebUI did not shut down cleanly: ${reason}`
      : "DevWebUI did not shut down cleanly (no error was recorded before it stopped).";
    return this.errors.record(DAEMON_ERROR_INFO, "crash", text);
  }

  // ---- alert rules (threshold alerting on CPU/memory) --------------------
  listAlertRules(): AlertRule[] {
    return this.alerts.listRules();
  }

  addAlertRule(input: AlertRuleInput): AlertRule {
    return this.alerts.addRule(input);
  }

  updateAlertRule(id: string, input: Partial<AlertRuleInput>): AlertRule | null {
    return this.alerts.updateRule(id, input);
  }

  removeAlertRule(id: string): boolean {
    return this.alerts.removeRule(id);
  }

  listAlertEvents(): AlertEvent[] {
    return this.alerts.listEvents();
  }

  clearAlertEvents(processId?: string): void {
    this.alerts.clearEvents(processId);
  }

  /**
   * MCP-Native Incident Autopilot: correlate this process's live status/exit
   * code, its de-duped error records, and (via `diagnose()`) port ownership +
   * its own script/command definition into a root-cause guess + remediation
   * suggestion. Returns null for an unknown process id.
   */
  async diagnoseProcess(id: string): Promise<Diagnosis | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    const errors = this.errors.list().filter((err) => err.processId === id);
    // Feed the Log Vault's file tail in as a fallback evidence source (used only when
    // the de-duped error log above is empty — see diagnose()'s heuristic 2).
    this.logVaultWriter.flush();
    const logTail = tailLog(id, 20);
    return diagnose({ def: e.def, status: e.status, exitCode: e.exitCode, errors, logTail });
  }

  protected errorInfo(e: Entry): ErrorInfo {
    const d = e.def;
    return {
      processId: d.id,
      localId: d.localId,
      processName: d.name,
      projectId: d.projectId,
      projectName: d.projectName,
    };
  }

  // ---- processes: reads ---------------------------------------------------
  list(): ProcessView[] {
    return [...this.entries.keys()].map((id) => this.view(id)!);
  }

  view(id: string): ProcessView | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return toProcessView(e.def, e, this.processEnabled(e.def));
  }

  /**
   * The agent-POV <RUNTIME_SERVICES> summary. Lives here because only the manager holds each
   * process's `.devwebui` env; the builder keeps its credential-looking NAMES and drops values.
   */
  runtimeServices(daemonOrigin: string, includeStopped = false): RuntimeServicesInfo {
    return buildRuntimeServicesInfo(
      this.list(),
      (id) => this.entries.get(id)?.def.env,
      daemonOrigin,
      includeStopped,
    );
  }

  getLogs(id: string): LogLine[] {
    return this.entries.get(id)?.logs ?? [];
  }

  /**
   * Tail the on-disk rotating log file for a process (survives daemon restarts and the
   * in-memory 500-line cap) — the Time-Travel Log Vault. Returns [] for an unknown id
   * or a process that hasn't logged anything yet.
   */
  getLogFileTail(id: string, lines: number): string[] {
    if (!this.entries.has(id)) return [];
    this.logVaultWriter.flush();
    return tailLog(id, lines);
  }

  // ---- enable/disable: PERSISTED PREFERENCE ONLY ---------------------------
  // Toggling never starts or stops a live process (use start/stop for that). It
  // only records what should auto-start next time the project loads.
  /** A process's own toggle: explicit override, else its `autostart` default. */
  private processEnabled(def: ProcessDef): boolean {
    return getEnabledOverride(def.id) ?? !!def.autostart;
  }

  /** A project's master switch: explicit override, else ON. */
  private projectEnabled(projectId: string): boolean {
    return getProjectOverride(projectId) ?? true;
  }

  /** Auto-start on load only when BOTH the project switch and the process toggle are on. */
  protected willAutostart(def: ProcessDef): boolean {
    return this.projectEnabled(def.projectId) && this.processEnabled(def);
  }

  // ---- projects: reads ----------------------------------------------------
  getProjectPath(id: string): string | null {
    return this.projects.get(id)?.path ?? null;
  }

  listProjects(): ProjectView[] {
    return [...this.projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      path: p.path,
      enabled: this.projectEnabled(p.id),
      processes: p.processIds.map((pid) => this.view(pid)!).filter(Boolean),
    }));
  }

  /** Find a managed entry currently running as `pid` (so we can stop it cleanly vs killing it). */
  protected entryByPid(pid: number): Entry | undefined {
    for (const e of this.entries.values()) if (e.pid === pid) return e;
    return undefined;
  }

  // ---- internals --------------------------------------------------------
  protected newEntry(def: ProcessDef): Entry {
    return {
      def,
      status: "stopped",
      child: null,
      pid: null,
      startedAt: null,
      restarts: 0,
      exitCode: null,
      cpu: null,
      memory: null,
      portInUse: false,
      waitingOnPort: null,
      logs: [],
      configChanged: false,
      stopping: false,
      pendingStart: false,
      exitWaiters: [],
      stopTimer: null,
      generation: 0,
    };
  }

  protected discardEntry(e: Entry): void {
    const pid = e.pid;
    this.cancelQueuedStart(e.def.id);
    e.stopping = true;
    e.pendingStart = false; // a pending free-port/wait-for-port callback will bail (entry no longer current)
    e.waitingOnPort = null;
    this.clearStopTimer(e);
    e.child = null;
    e.pid = null;
    e.cpu = null;
    e.memory = null;
    e.startedAt = null;
    this.resolveExitWaiters(e);
    if (pid) {
      try {
        treeKill(pid, "SIGKILL", () => {});
      } catch {
        /* ignore */
      }
    }
  }

  protected emitProjects(): void {
    this.emit("projects", this.listProjects());
  }

  protected setStatus(e: Entry, status: Status): void {
    e.status = status;
    this.emitStatus(e);
  }

  protected emitStatus(e: Entry): void {
    if (this.entries.get(e.def.id) !== e) return;
    const view = this.view(e.def.id);
    if (view) this.emit("status", view);
  }

  protected clearStopTimer(e: Entry): void {
    if (!e.stopTimer) return;
    clearTimeout(e.stopTimer);
    e.stopTimer = null;
  }

  protected resolveExitWaiters(e: Entry): void {
    const waiters = e.exitWaiters;
    e.exitWaiters = [];
    for (const fn of waiters) fn();
  }

  protected cancelQueuedStart(id: string): boolean {
    const timer = this.queuedStarts.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    this.queuedStarts.delete(id);
    return true;
  }
}
