// The dev servers' contract between Desk 2's server and its page, and the shapes chats' tools read. The manager is
// AgentHydra's own code (server/src/devservers), run as its own hidden process, the dev-servers service, which Desk
// starts when something asks (owner 2026-10-06: DevWebUI "isn't supposed to be separate", yet "spawn a separate
// instance ... kill it without killing Agent Hydra"). Projects are still described by `.devwebui` files (one per
// folder, the format DevWebUI wrote), and /dw/api/* keeps the paths and shapes the servers pane was built on: Desk
// passes them on to the service, starting it first when it is not running.

export const DW_BASE = '/dw'
export const DW_API = `${DW_BASE}/api`
/** A header on a GET /dw/api read: answered only while the service runs, never starting it (the pane's polls). */
export const DW_NO_START = 'x-dw-no-start'
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
  /** Its .devwebui entry's own runtime pin; without one the Settings default applies (DevWebSettings.runtime). */
  runtime?: 'node' | 'bun'
  /** Start after this port (or this sibling server's port) answers. */
  waitForPort?: number | string
  /** Sibling local ids it runs with as one unit: starting or stopping one starts or stops them all. */
  links?: string[]
  /** Starts whenever another server of its project is started by hand (a shared database). */
  companion?: boolean
  /** CPU of its process tree, percent of one core; null while it is down or resource monitoring is off. */
  cpu?: number | null
  /** Memory of its process tree in bytes; null while it is down or resource monitoring is off. */
  memory?: number | null
  /** De-duplicated errors recorded for it and not yet dismissed (GET /errors?process=). */
  errorCount?: number
  /** Alert rules of it that are over their threshold now. */
  alertsFiring?: number
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
  /** Its place in the server's on-disk log (the log vault), counting up across runs: `before` pages back from it. */
  seq?: number
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

/**
 * The address a running server answers on, or null when it has no port or url. `host` is Settings' link host
 * (DevWebSettings.linkHost, e.g. a LAN name); blank or absent means localhost.
 */
export function processAddress(proc: Pick<DevWebProcess, 'port' | 'url'>, host?: string): string | null {
  if (proc.url && /^https?:\/\//i.test(proc.url)) return proc.url
  const h = host?.trim() || 'localhost'
  if (proc.port) return `http://${h}:${proc.port}${proc.url?.startsWith('/') ? proc.url : ''}`
  return null
}

/**
 * The service's routes for what DevWebUI had beyond starting and stopping (owner, 2026-10-07: "use all the
 * functionality that originally existed in dev web UI for scanning and stuff like that"). Each is the service's
 * /api/<route> and the page's /dw/api/<route> (Desk passes /dw/api/* on one to one); `:id` is a project or server id.
 */
export const DW_ROUTES = {
  /** GET -> DevWebFound: what scans found that is not added and not ignored. */
  found: 'found',
  /** POST {preset, roots?} -> DevWebScanResult, also merged into `found`; one scan at a time. */
  scan: 'scan',
  /** POST -> {ok}: empties the found list (the next scan fills it again). */
  forgetFound: 'found/forget',
  /** GET ?path= -> DevWebPreview of a found .devwebui file or folder; writes nothing. */
  preview: 'preview',
  /** GET -> {paths}; POST {path}; DELETE ?path=: folders a scan no longer offers. */
  ignored: 'ignored',
  /** GET ?url= -> {dest}: a suggested folder for a clone. */
  cloneDest: 'projects/clone-dest',
  /** POST {url, dest} -> DevWebAddResult. */
  clone: 'projects/clone',
  /** PATCH {name?, color?} -> DevWebProject (rewrites its .devwebui); DELETE -> {ok}: stops what AgentHydra runs of it, forgets it, keeps the file. */
  project: (id: string) => `projects/${encodeURIComponent(id)}`,
  /** POST {on} -> DevWebProject: the master switch (autostart only). */
  projectEnabled: (id: string) => `projects/${encodeURIComponent(id)}/enabled`,
  /** POST {spec: DevWebProcessSpec} -> DevWebProject: adds a server to its .devwebui. */
  projectProcesses: (id: string) => `projects/${encodeURIComponent(id)}/processes`,
  /** GET -> DevWebTakeover; POST -> DevWebTakeOverResult (turns the triggers off, backups kept). */
  takeover: (id: string) => `projects/${encodeURIComponent(id)}/takeover`,
  /** POST -> {ok, restored}: puts a take-over's backups back. */
  takeoverRestore: (id: string) => `projects/${encodeURIComponent(id)}/takeover/restore`,
  /** PUT {spec} -> DevWebProject (a changed id renames it); DELETE -> DevWebProject (stopped first if AgentHydra runs it). */
  process: (id: string) => `processes/${encodeURIComponent(id)}`,
  /** GET -> DevWebProcessSpec: its entry as written in the file. */
  processConfig: (id: string) => `processes/${encodeURIComponent(id)}/config`,
  /** POST {on} -> DevWebProcess. */
  processStarred: (id: string) => `processes/${encodeURIComponent(id)}/starred`,
  /** POST {on} -> DevWebProcess: its own autostart toggle. */
  processEnabled: (id: string) => `processes/${encodeURIComponent(id)}/enabled`,
  /** GET ?before=<seq>&limit= -> {id, lines, more}: the newest `limit` lines before `before` (none: the newest). */
  processLogs: (id: string) => `processes/${encodeURIComponent(id)}/logs`,
  /** GET -> DevWebMetricsHistory: its CPU and memory samples of the last ~10 minutes, oldest first. */
  processMetrics: (id: string) => `processes/${encodeURIComponent(id)}/metrics`,
  /**
   * POST {pids?: number[]} -> DevWebFreePort. No pids: when programs AgentHydra did not start hold the port, answers
   * needsConfirm with them and changes nothing. With pids: stops this app's own holders and ends only the listed
   * outside ones; an outside holder not listed is answered needsConfirm again, with nothing ended.
   */
  freePort: (id: string) => `processes/${encodeURIComponent(id)}/free-port`,
  /** POST -> {ok, started}: every enabled server of every enabled project. */
  startAll: 'start-all',
  /** POST -> {ok, stopped}: every server that is up, whoever started it. */
  stopAll: 'stop-all',
  /** GET ?process= -> DevWebErrorEntry[], newest first. */
  errors: 'errors',
  /** POST {fingerprint} -> {ok}. */
  dismissError: 'errors/dismiss',
  /** POST {process?} -> {ok}. */
  clearErrors: 'errors/clear',
  /** POST {file, line?, column?, processId?} -> DevWebOpenInEditor. */
  openInEditor: 'open-in-editor',
  /** GET -> DevWebSettings; PATCH Partial<DevWebSettings> -> DevWebSettings. */
  settings: 'settings',
  /** POST -> {ok, restarted}: restarts what AgentHydra runs so a changed runtime applies. */
  restartRunning: 'settings/restart-running',
  /** GET -> DevWebAlerts; POST DevWebAlertRuleInput -> DevWebAlertRule. */
  alerts: 'alerts',
  /** PATCH Partial<DevWebAlertRuleInput> -> DevWebAlertRule; DELETE -> {ok}. */
  alert: (id: string) => `alerts/${encodeURIComponent(id)}`,
  /** POST -> {ok}. */
  clearAlertEvents: 'alerts/events/clear'
} as const

export type DevWebRuntimePref = 'auto' | 'node' | 'bun'
export type DevWebSkipOs = 'windows' | 'mac' | 'linux'

/** The dev servers' settings: <home>/devservers/settings.json, imported once from DevWebUI's ~/.devwebui/settings.json. */
export interface DevWebSettings {
  /** How a `bun …` / `node …` / package-script command is run when its entry has no runtime pin: auto follows the lockfile. */
  runtime: DevWebRuntimePref
  /** A start whose port is held by a program that is not a dev server ends that program first (never AgentHydra's own, an OS service or a tool daemon). */
  freePortOnStart: boolean
  /** When the dev-servers service starts (and, with this on, Desk starts it with itself), it starts every enabled server. */
  autoStartOnLaunch: boolean
  /** Sample CPU and memory of every running server (shown in the list and the info pane, and what alerts watch). */
  monitorResources: boolean
  /** The host a server's link opens on (a LAN name or IP); blank is localhost. */
  linkHost: string
  /** Scan for projects each time the dev-servers service starts (the first start always scans once). */
  autoScan: boolean
  /** Folder names (matched anywhere) or absolute paths a scan skips. */
  scanExclude: string[]
  skipWindows: boolean
  skipMac: boolean
  skipLinux: boolean
  /** The system folder names each skip switch adds. */
  osSkip: Record<DevWebSkipOs, string[]>
}

export type DevWebScanPreset = 'startup' | 'quick' | 'deep' | 'scoped'

/** A .devwebui file a scan found. */
export interface DevWebFoundFile {
  path: string
  name: string
  processes: number
  /** It parses as a project with at least one server. */
  valid: boolean
}

/** A folder whose package scripts (or .claude/launch.json) could make a .devwebui. */
export interface DevWebDetectedProject {
  path: string
  name: string
  framework?: string
  processes: number
}

export interface DevWebScanResult {
  files: DevWebFoundFile[]
  detected: DevWebDetectedProject[]
  scannedDirs: number
  /** Stopped at the result limit. */
  truncated: boolean
  /** Stopped at the time budget. */
  timedOut: boolean
  ms: number
  roots: string[]
}

/** One entry of the found list: a .devwebui file (`file`, path is the file) or a folder (`detected`, path is the folder). */
export interface DevWebFoundItem {
  kind: 'file' | 'detected'
  path: string
  name: string
  processes: number
  framework?: string
  /** For `file`: it parses as a project. */
  valid?: boolean
  /** When a scan first found it (ms epoch). */
  foundAt: number
}

export interface DevWebFound {
  /** Not added, not ignored, still on disk; files first, then most servers. */
  items: DevWebFoundItem[]
  /** A scan running now. */
  scanning: { preset: DevWebScanPreset; startedAt: number } | null
  lastScan: { at: number; preset: DevWebScanPreset; ms: number; scannedDirs: number; truncated: boolean; timedOut: boolean } | null
}

/** What adding a found item would add, read without writing anything. */
export type DevWebPreview =
  | { kind: 'file'; path: string; name: string; color?: string; processes: { id: string; name: string; command: string; port?: number }[]; error?: string }
  | { kind: 'detected'; dir: string; fileName: '.devwebui'; proposal: DevWebProposal }
  | { kind: 'none'; error: string }

/** A .devwebui body proposed from a folder's dev scripts, editable before it is written (POST projects/scaffold). */
export interface DevWebProposal {
  name: string
  framework?: string
  processes: { id: string; name: string; command: string; cwd?: string; port?: number; url?: string; color?: string; runtime?: 'node' | 'bun'; env?: Record<string, string>; autostart?: boolean }[]
  /** Dev scripts left out to keep the list short. */
  truncated?: number
}

/** A server's entry as its .devwebui writes it (cwd relative to the file's folder, as written). */
export interface DevWebProcessSpec {
  id: string
  name: string
  command: string
  cwd?: string
  color?: string
  env?: Record<string, string>
  autostart?: boolean
  starred?: boolean
  port?: number
  url?: string
  runtime?: 'node' | 'bun'
  waitForPort?: number | string
  links?: string[]
  companion?: boolean
  /** docker compose services brought up before it starts; kept as written. */
  compose?: unknown
  /** expect/send rules typed into its stdin at a prompt; kept as written. */
  answers?: { expect: string; send: string; once?: boolean }[]
}

export type DevWebAutostartKind = 'vscode-task' | 'vite-extension'

/** Something that starts a project's dev server outside AgentHydra (VS Code tasks.json on folder open, the Vite extension). */
export interface DevWebTrigger {
  kind: DevWebAutostartKind
  /** The config file holding it. */
  file: string
  label: string
  detail: string
}

export interface DevWebTakeover {
  triggers: DevWebTrigger[]
  /** Backups a take-over wrote that can be put back. */
  backups: string[]
}

export interface DevWebTakeOverResult {
  ok: boolean
  disabled: DevWebTrigger[]
  backups: string[]
  skipped: { file: string; reason: string }[]
}

/** Every "add a project" path answers this. */
export interface DevWebAddResult {
  ok?: boolean
  error?: string
  /** The folder a clone made. */
  cloned?: string
  project?: DevWebProject
  /** The .devwebui written for it. */
  created?: string
  /** Added for the first time: nothing was started, `autostart` servers included. */
  firstLoad?: boolean
  /** No .devwebui there: this proposal can be reviewed and written (POST projects/scaffold). */
  needsScaffold?: boolean
  dir?: string
  fileName?: '.devwebui'
  proposal?: DevWebProposal
  /** The folder also starts its server outside AgentHydra (offer the take-over). */
  autostartTriggers?: DevWebTrigger[]
}

/** A program holding a port. */
export interface DevWebPortOwner {
  pid: number
  name: string
  cmdline?: string
  uptime?: string
}

export interface DevWebFreePort {
  ok?: boolean
  /** Programs AgentHydra did not start hold it (owners) and nothing was changed: send their pids to end them. */
  needsConfirm?: boolean
  owners?: DevWebPortOwner[]
  /** Servers AgentHydra runs that held it and were stopped cleanly. */
  stoppedManaged?: string[]
  /** Why it will not be freed (AgentHydra's own port, an OS service, a tool daemon). */
  refused?: string
}

export type DevWebErrorSource = 'stderr' | 'stdout' | 'crash'

/** A `file:line[:column]` an error names, for jumping to it in the editor. */
export interface DevWebSourceFrame {
  file: string
  line: number
  column?: number
}

/** A de-duplicated error a server printed (or its crash), kept across restarts in <home>/devservers/errors.ndjson. */
export interface DevWebErrorEntry {
  fingerprint: string
  processId: string
  localId: string
  processName: string
  projectId: string
  projectName: string
  source: DevWebErrorSource
  /** The text as printed (ANSI removed), cut to a few KB. */
  sample: string
  frames: DevWebSourceFrame[]
  count: number
  firstSeen: number
  lastSeen: number
}

export type DevWebOpenInEditor =
  | { ok: true; editor: string; file: string; line: number; column: number }
  | { ok: false; reason: 'bad-input' | 'not-found' | 'no-editor' | 'unsupported-editor' | 'launch-failed'; detail?: string }

export type DevWebAlertMetric = 'cpu' | 'memory'

/** "Alert if this server stays over <threshold> for <forMs>": cpu in percent of one core, memory in bytes. */
export interface DevWebAlertRule {
  id: string
  processId: string
  metric: DevWebAlertMetric
  threshold: number
  forMs: number
  enabled: boolean
  createdAt: number
}

export interface DevWebAlertRuleInput {
  processId: string
  metric: DevWebAlertMetric
  threshold: number
  forMs: number
  enabled?: boolean
}

export interface DevWebAlertEvent {
  id: string
  ruleId: string
  processId: string
  processName: string
  projectId: string
  projectName: string
  metric: DevWebAlertMetric
  threshold: number
  /** The sample that tripped it. */
  value: number
  firedAt: number
}

export interface DevWebAlerts {
  rules: DevWebAlertRule[]
  /** Newest first. */
  events: DevWebAlertEvent[]
}

/** One resource sample of a server's process tree: CPU in percent of one core, memory in resident bytes. */
export interface DevWebMetricPoint {
  t: number
  cpu: number | null
  memory: number | null
}

/**
 * GET /dw/api/processes/:id/metrics: the service's last ~10 minutes of samples of a server, oldest first, so the info
 * pane's CPU and memory charts have data the moment they open. Empty while resource monitoring is off or it never ran.
 */
export interface DevWebMetricsHistory {
  id: string
  /** How often the service samples, ms. */
  sampleMs: number
  /** How far back it keeps samples, ms. */
  windowMs: number
  points: DevWebMetricPoint[]
}
