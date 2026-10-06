// The dev servers' contract between Desk 2's server and its page, and the shapes chats' tools read. The manager is
// AgentHydra's own code (server/src/devservers), run as its own hidden process, the dev-servers service, which Desk
// starts when something asks (owner 2026-10-06: DevWebUI "isn't supposed to be separate", yet "spawn a separate
// instance ... kill it without killing Agent Hydra"). Projects are still described by `.devwebui` files (one per
// folder, the format DevWebUI wrote), and /dw/api/* keeps the paths and shapes the servers pane was built on: Desk
// passes them on to the service, starting it first when it is not running.

export const DW_BASE = '/dw'
export const DW_API = `${DW_BASE}/api`
/** GET: where the service stands; a 404 means a Desk 2 server started before these routes. */
export const DW_STATUS = `${DW_BASE}/status`
/** POST {action: 'start' | 'stop' | 'restart'}: the service itself (Settings). Stop ends the servers it started. */
export const DW_SERVICE = `${DW_BASE}/service`
/** POST {cwd}: the chat folder's project, set up when it is not yet (server/src/devservers/folder.ts). */
export const DW_FOLDER = `${DW_BASE}/folder`
/** /dw/proxy/<process id>/...: a running server shown through Desk (its frame-blocking headers removed). */
export const DW_PROXY = `${DW_BASE}/proxy`

/** running: the service answers. starting: Desk is bringing it up. stopped: not running (it starts on the next ask). */
export type DevWebState = 'running' | 'starting' | 'stopped' | 'failed'

export interface DevWebStatus {
  state: DevWebState
  /** The service's pid while it runs. */
  pid: number | null
  /** Why it failed: the last line it printed, or what went wrong before it could print. */
  reason?: string
  /** It runs older code than Desk's folder; Desk restarts it by itself once it runs no server. */
  stale?: boolean
  /** How many servers it started run now. */
  running?: number
}

/** GET (?all=1 for every port): the localhost servers no project lists (server/src/localhost). */
export const DW_LOCALHOST = `${DW_BASE}/localhost`

/** What a listening port is: this window or a chat's host, AgentHydra's daemon, an OS service, a tool daemon, a dev runtime, or any other program. */
export type LocalServerKind = 'desk' | 'agenthydra' | 'system' | 'service' | 'dev' | 'app'

export interface LocalServer {
  port: number
  address: string
  pid: number
  /** The owning process's name, without .exe; null when it could not be read. */
  process: string | null
  kind: LocalServerKind
  /** Where a click opens it. */
  url: string
  /** The page's <title> when it answers HTTP with HTML. */
  title: string | null
  /** The HTTP status it answered with; null when it did not answer (or was not asked). */
  http: number | null
}

export interface LocalServers {
  /** Dev servers only, or every port with all=1. */
  servers: LocalServer[]
  /** Ports left out of `servers` (the projects' own are not counted). */
  hidden: number
  /** Why the ports could not be read. */
  error: string | null
  scannedAt: number
}

export type DevWebProcessStatus = 'stopped' | 'starting' | 'waiting' | 'running' | 'stopping' | 'crashed'

/**
 * Who runs a server that is up: `desk` started it (it survives a Desk restart and is picked up again), `outside` is
 * a server someone else started (a chat's shell, a terminal, another tool) found listening on the server's port or
 * from its folder. Desk uses an outside one as it is and never starts a second copy beside it. null while it is down.
 */
export type DevWebOwner = 'desk' | 'outside'

export interface DevWebProcess {
  /** `<project id>.<local id>`: unique across projects. */
  id: string
  /** The id inside its .devwebui file. */
  localId: string
  name: string
  command: string
  /** Absolute. */
  cwd: string
  color?: string
  autostart?: boolean
  starred?: boolean
  /** Its own on/off preference (state.json): only decides autostart, never starts or stops it. */
  enabled: boolean
  port?: number
  url?: string
  status: DevWebProcessStatus
  owner: DevWebOwner | null
  /** The running process's id (for `outside`, the one listening); the localhost list leaves out whatever it owns. */
  pid: number | null
  /** ms epoch of the current run, null while down. */
  startedAt: number | null
  restarts: number
  exitCode: number | null
  /** Why it is not started though it was asked: its port is taken by a program that is not a dev server. */
  conflict: string | null
  /** Its .devwebui entry changed while it ran: the change applies at its next start. */
  configChanged?: boolean
  /** The port it waits for before it starts (`waitForPort`), while status is `waiting`. */
  waitingOnPort?: number | null
  projectId: string
  projectName: string
}

export interface DevWebProject {
  id: string
  name: string
  color?: string
  /** The .devwebui file, absolute. */
  path: string
  /** The project's master switch (state.json): off leaves every server out of autostart. */
  enabled: boolean
  processes: DevWebProcess[]
}

/** What POST /dw/folder answers: the folder's project (`created`: the .devwebui it wrote), or why there is none. */
export type DevWebFolder = { project: DevWebProject; created?: string } | { nothing: string }

export interface DevWebLogLine {
  stream: 'stdout' | 'stderr'
  line: string
  ts: number
}

/** POST /dw/api/processes/:id/start: `reused` when it was already up (Desk's or outside) and nothing was started. */
export interface DevWebStartAnswer {
  ok: true
  process: DevWebProcess
  reused: boolean
  /** The other servers this start set in motion (its linked group and the project's companions). */
  coStarted: string[]
}

/** POST /dw/api/ensure {cwd, server?, wait?}: what a chat's tool answers (server/src/devservers/mcp.ts). */
export type DevWebEnsure =
  | { ok: true; reused: boolean; process: DevWebProcess; url: string | null; project: DevWebProject }
  | { ok: false; error: string; process?: DevWebProcess; logTail?: string[]; choices?: string[] }

/** GET /dw/api/servers?cwd=&all=1: the folder's project (all=1: every project) and the dev servers no project lists. */
export interface DevWebServers {
  project: DevWebProject | null
  projects: DevWebProject[]
  others: LocalServer[]
}

const sepNormalised = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()

/** Folder of a project: where its .devwebui file lives. */
export function projectDir(project: Pick<DevWebProject, 'path'>): string {
  const p = project.path.replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return cut > 0 ? p.slice(0, cut) : p
}

/** True when `inner` is `outer` or inside it. Windows paths: case-insensitive, either slash. */
export function folderContains(outer: string, inner: string): boolean {
  const o = sepNormalised(outer)
  const i = sepNormalised(inner)
  if (o === '') return false
  return i === o || i.startsWith(`${o}/`)
}

/** The project a chat in `cwd` belongs to: the one whose folder is the cwd, else the deepest one containing it. */
export function projectForCwd(projects: DevWebProject[], cwd: string): DevWebProject | null {
  let best: DevWebProject | null = null
  let bestLen = -1
  for (const p of projects) {
    const dir = projectDir(p)
    if (!folderContains(dir, cwd)) continue
    const len = sepNormalised(dir).length
    if (len > bestLen) {
      best = p
      bestLen = len
    }
  }
  return best
}

/** The address a running server answers on, or null when it has no port or url. */
export function processAddress(proc: Pick<DevWebProcess, 'port' | 'url'>): string | null {
  if (proc.url && /^https?:\/\//i.test(proc.url)) return proc.url
  if (proc.port) return `http://localhost:${proc.port}${proc.url?.startsWith('/') ? proc.url : ''}`
  return null
}
