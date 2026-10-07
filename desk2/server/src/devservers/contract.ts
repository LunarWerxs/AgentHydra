// The dev-server manager's surface: what the dev-servers service (service.ts) serves, and what Desk's /dw/ plugin, the
// localhost list and the chats' tools rely on. manager.ts implements it; this file is the contract between them, so
// each side is written against it alone.
//
// What it is (owner, 2026-10-06): DevWebUI "isn't supposed to be separate ... fully integrated and entirely merged"
// into AgentHydra 2.0, yet "should probably spawn a separate instance ... I wanna be able to kill it without killing
// Agent Hydra ... But I don't want it to be a separate program". And servers are not to be doubled: "if something is
// spun up ..., another one should understand it exists and attempt to leverage that". So:
// - It is AgentHydra's own code (desk2/server/src/devservers), run as its own hidden process, the dev-servers
//   service: no window, tray, updater or data dir of its own. Desk starts it when something asks for a dev server,
//   outside Desk's process tree, so a Desk restart leaves it and its servers running; ending it (Settings, or Task
//   Manager) ends the servers it started, never AgentHydra.
// - One copy per server. Before starting, it looks: a server already listening on its port, or (with no port) a dev
//   server whose command line is in its folder, is that server, whoever started it (`owner: 'outside'`), and is used as
//   it is. It never kills a program to free a port: a port held by something that is not a dev server is a `conflict`.

import type {
  DevWebAddResult,
  DevWebAlertRule,
  DevWebAlertRuleInput,
  DevWebAlerts,
  DevWebEnsure,
  DevWebErrorEntry,
  DevWebFolder,
  DevWebFound,
  DevWebFreePort,
  DevWebLogLine,
  DevWebMetricsHistory,
  DevWebOpenInEditor,
  DevWebPreview,
  DevWebProcess,
  DevWebProcessSpec,
  DevWebProject,
  DevWebScanPreset,
  DevWebScanResult,
  DevWebSettings,
  DevWebStartAnswer,
  DevWebTakeover,
  DevWebTakeOverResult,
  DevWebTrigger
} from '@shared/devwebui'
import type { Scan } from '../localhost/ports'

/** <home>/devservers/service.json: written by the service once it listens, removed when it exits cleanly. */
export interface ServiceFile {
  pid: number
  /** 127.0.0.1 only. */
  port: number
  /** Every request to the service carries `authorization: Bearer <token>`; anything else gets 401. */
  token: string
  startedAt: number
  /** The hash of the service's own source files when it started: Desk restarts a stale service when it runs nothing. */
  stamp: string
}

export interface DevServersDeps {
  /** Desk's data home: everything goes in <home>/devservers/ (registry.json, state.json, logs/, service.json). */
  home: string
  /**
   * DevWebUI's old data dir, read once when <home>/devservers/registry.json does not exist yet, for its registry.json
   * projects and state.json overrides; never written. Default ~/.devwebui; null skips it (tests).
   */
  importFrom?: string | null
  /** Ends a process and its tree (default: taskkill /T /F, host/launch.ts killHostTree). */
  kill?: (pid: number) => void
  /** True when something accepts a TCP connection on 127.0.0.1 or ::1 at `port` (default: a 300 ms connect). */
  portListening?: (port: number) => Promise<boolean>
  /** Listening sockets and processes (default localhost/ports.ts scanPorts). */
  scan?: () => Promise<Scan>
  /** Walks the disk for projects (default scan.ts scanProjects; the first start's scan covers every drive). */
  findProjects?: (opts: { preset: DevWebScanPreset; roots?: string[]; exclude?: string[] }) => Promise<DevWebScanResult>
  now?: () => number
  /** Watch the .devwebui files and apply their changes (default true). */
  watch?: boolean
  /** Desk's own pid and port, and the service's: never taken for a dev server. */
  deskPid?: number
  deskPort?: number
}

export class DevServerError extends Error {
  constructor(
    message: string,
    /** 404 unknown id, 409 refused (a conflict), 400 bad input. */
    readonly status: 400 | 404 | 409
  ) {
    super(message)
  }
}

/** POST /projects/load answers (DevWebUI's shapes, so the folder set-up reads them as before). */
export type LoadAnswer =
  | { ok: true; project: DevWebProject; firstLoad: boolean; autostartTriggers?: DevWebTrigger[] }
  | { needsScaffold: true; dir: string; fileName: '.devwebui'; proposal: ScaffoldProposal; autostartTriggers?: DevWebTrigger[] }

/** A .devwebui body proposed from what a folder has (.claude/launch.json, package.json dev scripts). */
export interface ScaffoldProposal {
  name: string
  processes: { id: string; name: string; command: string; cwd?: string; port?: number; url?: string; autostart?: boolean }[]
}

export interface DevServers {
  /** Resolves once the registry is read (and a restart's servers are started again). */
  readonly ready: Promise<void>
  /** Every project with its servers' current state (looks again first, at most every ~1.5 s, one look at a time). */
  listProjects(): Promise<DevWebProject[]>
  process(id: string): Promise<DevWebProcess | null>
  /** Starts it with its linked group and companions, unless it is up already (`reused`). Never kills a port's owner. */
  start(id: string): Promise<DevWebStartAnswer>
  /** Stops it and its linked group, whoever started it (a person or chat asked). */
  stop(id: string): Promise<{ ok: true; process: DevWebProcess; coStopped: string[] }>
  restart(id: string): Promise<{ ok: true; process: DevWebProcess }>
  startProject(id: string): Promise<{ ok: true }>
  stopProject(id: string): Promise<{ ok: true }>
  /** The last 500 lines it printed (ANSI removed); for an outside server, one line saying its output is not here. */
  logs(id: string): Promise<DevWebLogLine[]>
  /** POST /projects/load {path}: a folder or .devwebui file. Unknown folder without a .devwebui: `needsScaffold`. */
  load(path: string): Promise<LoadAnswer>
  /** POST /projects/scaffold: writes <dir>/.devwebui (never over one) and loads it; `created` is its path. */
  scaffold(dir: string, fileName: string, project: ScaffoldProposal): Promise<{ ok: true; project: DevWebProject; firstLoad: boolean; created: string; autostartTriggers?: DevWebTrigger[] }>
  /** POST /dw/folder: the project of a chat's folder, set up from what the folder has when it has none. */
  folder(cwd: string): Promise<DevWebFolder>
  /**
   * For a chat's tool: the folder's project (set up when needed), one of its servers (`server`: id, local id or name,
   * any case; else the starred one, else an autostart one, else the only one), started unless up, and with `wait`
   * (default true) waited for until it answers on its port (at most ~45 s).
   */
  ensure(cwd: string, server?: string, wait?: boolean): Promise<DevWebEnsure>
  /** The ports and pids of every server it lists as up: the localhost list leaves them (and their trees) out. */
  owned(): Promise<{ ports: number[]; pids: number[] }>
  /** Ids of the servers it started that run now (a restart starts them again). */
  runningIds(): string[]

  /** The found list: scans' finds not added, not ignored and still on disk, plus the scan running now. */
  found(): Promise<DevWebFound>
  /** One scan at a time (a second waits for the first); its finds are merged into `found`. */
  scan(opts: { preset: DevWebScanPreset; roots?: string[] }): Promise<DevWebScanResult>
  forgetFound(): Promise<{ ok: true }>
  /** What adding a found .devwebui file or folder would add; writes nothing. */
  preview(path: string): Promise<DevWebPreview>
  ignored(): Promise<{ paths: string[] }>
  ignore(path: string): Promise<{ paths: string[] }>
  unignore(path: string): Promise<{ paths: string[] }>
  cloneDest(url: string): Promise<{ dest: string }>
  clone(url: string, dest: string): Promise<DevWebAddResult>

  updateProject(id: string, patch: { name?: string; color?: string | null }): Promise<DevWebProject>
  /** Stops the servers AgentHydra started of it (outside ones are left), forgets it; the file stays. */
  removeProject(id: string): Promise<{ ok: true }>
  setProjectEnabled(id: string, on: boolean): Promise<DevWebProject>
  addProcess(projectId: string, spec: DevWebProcessSpec): Promise<DevWebProject>
  processConfig(id: string): Promise<DevWebProcessSpec>
  /** Its CPU and memory samples of the last ~10 minutes, oldest first, for the info pane's charts. */
  metricsHistory(id: string): Promise<DevWebMetricsHistory>
  updateProcess(id: string, spec: DevWebProcessSpec): Promise<DevWebProject>
  removeProcess(id: string): Promise<DevWebProject>
  setStarred(id: string, on: boolean): Promise<DevWebProcess>
  setProcessEnabled(id: string, on: boolean): Promise<DevWebProcess>
  takeover(projectId: string): Promise<DevWebTakeover>
  takeOver(projectId: string): Promise<DevWebTakeOverResult>
  restoreTakeover(projectId: string): Promise<{ ok: true; restored: string[] }>

  startAllServers(): Promise<{ ok: true; started: string[] }>
  stopAllServers(): Promise<{ ok: true; stopped: string[] }>
  /** A page of its on-disk log: the newest `limit` lines before `before` (a seq), newest last. */
  logPage(id: string, opts: { before?: number; limit?: number }): Promise<{ lines: DevWebLogLine[]; more: boolean }>
  /** Ends an outside holder only when its pid is in confirmPids (the owners a needsConfirm answer showed). */
  freePort(id: string, confirmPids?: number[]): Promise<DevWebFreePort>
  errors(processId?: string): Promise<DevWebErrorEntry[]>
  dismissError(fingerprint: string): Promise<{ ok: true }>
  clearErrors(processId?: string): Promise<{ ok: true }>
  openInEditor(req: { file: string; line?: number; column?: number; processId?: string }): Promise<DevWebOpenInEditor>
  settings(): Promise<DevWebSettings>
  saveSettings(patch: Partial<DevWebSettings>): Promise<DevWebSettings>
  restartRunning(): Promise<{ ok: true; restarted: string[] }>
  alerts(): Promise<DevWebAlerts>
  addAlert(input: DevWebAlertRuleInput): Promise<DevWebAlertRule>
  updateAlert(id: string, patch: Partial<DevWebAlertRuleInput>): Promise<DevWebAlertRule>
  removeAlert(id: string): Promise<{ ok: true }>
  clearAlertEvents(): Promise<{ ok: true }>
  /** Stops every server it started (outside ones are left alone) and its timers and watchers. */
  stopAll(): Promise<void>
  /** Kills what it started at once, synchronously (a crash on the way out). */
  killAllSync(): void
}

/** What manager.ts exports as `createDevServers`: the one manager the service runs. */
export type CreateDevServers = (deps: DevServersDeps) => DevServers
