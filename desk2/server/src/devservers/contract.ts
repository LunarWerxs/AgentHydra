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

import type { DevWebEnsure, DevWebFolder, DevWebLogLine, DevWebProcess, DevWebProject, DevWebStartAnswer } from '@shared/devwebui'
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
  | { ok: true; project: DevWebProject; firstLoad: boolean }
  | { needsScaffold: true; dir: string; fileName: '.devwebui'; proposal: ScaffoldProposal }

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
  scaffold(dir: string, fileName: string, project: ScaffoldProposal): Promise<{ ok: true; project: DevWebProject; firstLoad: boolean; created: string }>
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
  /** Stops every server it started (outside ones are left alone) and its timers and watchers. */
  stopAll(): Promise<void>
  /** Kills what it started at once, synchronously (a crash on the way out). */
  killAllSync(): void
}

/** What manager.ts exports as `createDevServers`: the one manager the service runs. */
export type CreateDevServers = (deps: DevServersDeps) => DevServers
