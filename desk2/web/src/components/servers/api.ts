// The calls the servers pane makes: Desk 2's /dw/status, /dw/service and /dw/folder, and the dev-servers service's API behind /dw/api.
import { BROWSER_CLOSE, BROWSER_OPEN, BROWSER_PROFILES, type BrowserOpened, type BrowserProfiles } from '@shared/browser'
import {
  DW_API,
  DW_FOLDER,
  DW_LOCALHOST,
  DW_NO_START,
  DW_ROUTES,
  DW_SERVICE,
  DW_STATUS,
  type DevWebAddResult,
  type DevWebAlertRule,
  type DevWebAlertRuleInput,
  type DevWebAlerts,
  type DevWebErrorEntry,
  type DevWebFolder,
  type DevWebFound,
  type DevWebFreePort,
  type DevWebLogLine,
  type DevWebOpenInEditor,
  type DevWebPreview,
  type DevWebProcess,
  type DevWebProcessSpec,
  type DevWebProject,
  type DevWebProposal,
  type DevWebScanPreset,
  type DevWebScanResult,
  type DevWebSettings,
  type DevWebStartAnswer,
  type DevWebStatus,
  type DevWebTakeover,
  type DevWebTakeOverResult,
  type LocalServers
} from '@shared/devwebui'

/** Thrown when /dw/status is not there: a Desk 2 server started before the route existed. */
export class RouteMissing extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || `${res.status} ${res.statusText}`)
  }
  return body as T
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export async function devwebStatus(): Promise<DevWebStatus> {
  const res = await fetch(DW_STATUS)
  // The server answers /api/* it does not know with JSON 404, and the built window for any other path:
  // either way a missing route reads as "restart".
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) throw new RouteMissing()
  return (await res.json()) as DevWebStatus
}

/** The service itself (Settings, and Try again): Stop ends the servers it started. */
export const devwebService = (action: 'start' | 'stop' | 'restart'): Promise<DevWebStatus> => call(DW_SERVICE, post({ action }))

/** `start: false` (a poll) is answered only while the service runs and never starts it. */
export const listProjects = (o: { start?: boolean } = {}): Promise<DevWebProject[]> => call(`${DW_API}/projects`, o.start === false ? { headers: { [DW_NO_START]: '1' } } : undefined)

/** A start answers `reused` when the server was already up (Desk's or one run outside) and nothing was started. */
export function processAction(id: string, action: 'start'): Promise<DevWebStartAnswer>
export function processAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<unknown>
export function processAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<unknown> {
  return call(`${DW_API}/processes/${encodeURIComponent(id)}/${action}`, post())
}

export function projectAction(id: string, action: 'start' | 'stop'): Promise<unknown> {
  return call(`${DW_API}/projects/${encodeURIComponent(id)}/${action}`, post())
}

export async function processLogs(id: string): Promise<DevWebLogLine[]> {
  return (await call<{ lines: DevWebLogLine[] }>(`${DW_API}/processes/${encodeURIComponent(id)}/logs`)).lines
}

/** The chat folder's project, set up in the dev-servers service when it is not yet (no Add step). */
export const setUpFolder = (cwd: string): Promise<DevWebFolder> => call(DW_FOLDER, post({ cwd }))

/** The localhost servers no project lists (Desk 2's own /dw/localhost); `all` adds the ports the dev-server filter hides. */
export const localhostServers = (all = false): Promise<LocalServers> => call(all ? `${DW_LOCALHOST}?all=1` : DW_LOCALHOST)

// DevWebUI's features beyond start and stop (shared/devwebui.ts DW_ROUTES). `start: false` marks a poll's read, which
// never starts the service.
const dw = (route: string): string => `${DW_API}/${route}`
const send = (method: 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const quiet = (o: { start?: boolean }): RequestInit | undefined => (o.start === false ? { headers: { [DW_NO_START]: '1' } } : undefined)

export const foundList = (o: { start?: boolean } = {}): Promise<DevWebFound> => call(dw(DW_ROUTES.found), quiet(o))
export const scanProjects = (preset: DevWebScanPreset, roots?: string[]): Promise<DevWebScanResult> => call(dw(DW_ROUTES.scan), post({ preset, roots }))
export const forgetFound = (): Promise<{ ok: true }> => call(dw(DW_ROUTES.forgetFound), post())
export const previewFound = (path: string): Promise<DevWebPreview> => call(`${dw(DW_ROUTES.preview)}?${new URLSearchParams({ path })}`)
export const ignoredFolders = (): Promise<{ paths: string[] }> => call(dw(DW_ROUTES.ignored))
export const ignoreFolder = (path: string): Promise<{ paths: string[] }> => call(dw(DW_ROUTES.ignored), post({ path }))
export const unignoreFolder = (path: string): Promise<{ paths: string[] }> => call(`${dw(DW_ROUTES.ignored)}?${new URLSearchParams({ path })}`, send('DELETE'))

/** A folder or .devwebui file: added, or (a folder with none) a proposal to review and write with `scaffoldProject`. */
export const loadProject = (path: string): Promise<DevWebAddResult> => call(dw('projects/load'), post({ path }))
export const scaffoldProject = (dir: string, project: DevWebProposal): Promise<DevWebAddResult> => call(dw('projects/scaffold'), post({ dir, fileName: '.devwebui', project }))
export const cloneDest = (url: string): Promise<{ dest: string }> => call(`${dw(DW_ROUTES.cloneDest)}?${new URLSearchParams({ url })}`)
export const cloneProject = (url: string, dest: string): Promise<DevWebAddResult> => call(dw(DW_ROUTES.clone), post({ url, dest }))

export const updateProject = (id: string, patch: { name?: string; color?: string | null }): Promise<DevWebProject> => call(dw(DW_ROUTES.project(id)), send('PATCH', patch))
export const removeProject = (id: string): Promise<{ ok: true }> => call(dw(DW_ROUTES.project(id)), send('DELETE'))
export const setProjectEnabled = (id: string, on: boolean): Promise<DevWebProject> => call(dw(DW_ROUTES.projectEnabled(id)), post({ on }))
export const addProcess = (projectId: string, spec: DevWebProcessSpec): Promise<DevWebProject> => call(dw(DW_ROUTES.projectProcesses(projectId)), post({ spec }))
export const takeoverCheck = (projectId: string): Promise<DevWebTakeover> => call(dw(DW_ROUTES.takeover(projectId)))
export const takeOver = (projectId: string): Promise<DevWebTakeOverResult> => call(dw(DW_ROUTES.takeover(projectId)), post())
export const restoreTakeover = (projectId: string): Promise<{ ok: true; restored: string[] }> => call(dw(DW_ROUTES.takeoverRestore(projectId)), post())

export const processConfig = (id: string): Promise<DevWebProcessSpec> => call(dw(DW_ROUTES.processConfig(id)))
export const updateProcess = (id: string, spec: DevWebProcessSpec): Promise<DevWebProject> => call(dw(DW_ROUTES.process(id)), send('PUT', { spec }))
export const removeProcess = (id: string): Promise<DevWebProject> => call(dw(DW_ROUTES.process(id)), send('DELETE'))
export const setStarred = (id: string, on: boolean): Promise<DevWebProcess> => call(dw(DW_ROUTES.processStarred(id)), post({ on }))
export const setProcessEnabled = (id: string, on: boolean): Promise<DevWebProcess> => call(dw(DW_ROUTES.processEnabled(id)), post({ on }))
/** A page of a server's on-disk log: the newest `limit` lines before seq `before` (none: the newest), oldest first. */
export function logPage(id: string, opts: { before?: number; limit?: number; start?: boolean } = {}): Promise<{ id: string; lines: DevWebLogLine[]; more: boolean }> {
  const q = new URLSearchParams()
  if (opts.before !== undefined) q.set('before', String(opts.before))
  if (opts.limit !== undefined) q.set('limit', String(opts.limit))
  const qs = q.toString()
  return call(`${dw(DW_ROUTES.processLogs(id))}${qs ? `?${qs}` : ''}`, quiet(opts))
}
export const freePort = (id: string, confirm = false): Promise<DevWebFreePort> => call(dw(DW_ROUTES.freePort(id)), post({ confirm }))
export const startAllServers = (): Promise<{ ok: true; started: string[] }> => call(dw(DW_ROUTES.startAll), post())
export const stopAllServers = (): Promise<{ ok: true; stopped: string[] }> => call(dw(DW_ROUTES.stopAll), post())

export const errorList = (processId?: string, o: { start?: boolean } = {}): Promise<DevWebErrorEntry[]> =>
  call(processId ? `${dw(DW_ROUTES.errors)}?${new URLSearchParams({ process: processId })}` : dw(DW_ROUTES.errors), quiet(o))
export const dismissError = (fingerprint: string): Promise<{ ok: true }> => call(dw(DW_ROUTES.dismissError), post({ fingerprint }))
export const clearErrors = (processId?: string): Promise<{ ok: true }> => call(dw(DW_ROUTES.clearErrors), post(processId ? { process: processId } : {}))
export const openInEditor = (req: { file: string; line?: number; column?: number; processId?: string }): Promise<DevWebOpenInEditor> => call(dw(DW_ROUTES.openInEditor), post(req))

export const devSettings = (): Promise<DevWebSettings> => call(dw(DW_ROUTES.settings))
export const saveDevSettings = (patch: Partial<DevWebSettings>): Promise<DevWebSettings> => call(dw(DW_ROUTES.settings), send('PATCH', patch))
export const restartRunning = (): Promise<{ ok: true; restarted: string[] }> => call(dw(DW_ROUTES.restartRunning), post())

export const alertList = (o: { start?: boolean } = {}): Promise<DevWebAlerts> => call(dw(DW_ROUTES.alerts), quiet(o))
export const addAlert = (input: DevWebAlertRuleInput): Promise<DevWebAlertRule> => call(dw(DW_ROUTES.alerts), post(input))
export const updateAlert = (id: string, patch: Partial<DevWebAlertRuleInput>): Promise<DevWebAlertRule> => call(dw(DW_ROUTES.alert(id)), send('PATCH', patch))
export const removeAlert = (id: string): Promise<{ ok: true }> => call(dw(DW_ROUTES.alert(id)), send('DELETE'))
export const clearAlertEvents = (): Promise<{ ok: true }> => call(dw(DW_ROUTES.clearAlertEvents), post())

/** Desk's own native folder picker (the new-chat folder's), for Add project's Browse. */
export const pickFolder = async (current: string | null): Promise<string | null> => (await call<{ path: string | null }>('/api/folders/pick', post({ current }))).path

// ---- saved browsers (shared/browser.ts) ----
export const browserProfiles = (cwd: string): Promise<BrowserProfiles> => call(`${BROWSER_PROFILES}?${new URLSearchParams({ cwd })}`)

export const browserClose = (cwd: string, profile: string): Promise<{ closed: boolean }> => call(BROWSER_CLOSE, post({ cwd, profile }))

export const browserOpen = (cwd: string, profile: string, opts: { url?: string; login?: boolean } = {}): Promise<BrowserOpened> => call(BROWSER_OPEN, post({ cwd, profile, ...opts }))
