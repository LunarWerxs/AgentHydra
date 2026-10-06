// The servers pane's decisions, pure so the tests and the component share them: what the pane shows for the
// daemon's status and the project list, when it sets the chat's folder up, a server's dot, the address bar's
// input, and the pane's width.
import { BROWSER_LIVE, type BrowserLiveIn, type BrowserOpenRequest, type BrowserProfiles } from '@shared/browser'
import { type DevWebProcess, type DevWebProcessStatus, type DevWebProject, type DevWebStatus, processAddress, projectForCwd } from '@shared/devwebui'

/** What the pane draws. */
export type PaneView =
  | { kind: 'loading' }
  /** /dw/status answered 404: the live Desk 2 server was started before the route existed. */
  | { kind: 'restart-desk' }
  | { kind: 'starting' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }
  /** The daemon runs but its project list could not be read. */
  | { kind: 'unreachable'; reason: string }
  /** The folder is not a project yet and POST /dw/folder is setting it up (or is about to). */
  | { kind: 'looking' }
  /** It answered that the folder has nothing to run. */
  | { kind: 'nothing'; reason: string }
  | { kind: 'project'; project: DevWebProject }

/** The folder POST /dw/folder was asked about; `nothing` is its answer when there was no project. */
export interface FolderSetup {
  cwd: string
  nothing: string | null
}

export interface PaneInput {
  /** null until the first answer. */
  status: DevWebStatus | null
  statusMissing: boolean
  /** null until a daemon answered the list; undefined = not asked yet. */
  projects: DevWebProject[] | null
  projectsError: string | null
  cwd: string
  setup?: FolderSetup | null
}

export function paneView(i: PaneInput): PaneView {
  if (i.statusMissing) return { kind: 'restart-desk' }
  if (!i.status) return { kind: 'loading' }
  if (i.status.state === 'starting') return { kind: 'starting' }
  if (i.status.state === 'failed') return { kind: 'failed', reason: i.status.reason ?? 'it did not start' }
  if (i.status.state === 'stopped') return { kind: 'stopped' }
  if (i.projectsError) return { kind: 'unreachable', reason: i.projectsError }
  if (!i.projects) return { kind: 'loading' }
  const project = projectForCwd(i.projects, i.cwd)
  if (project) return { kind: 'project', project }
  return i.setup?.cwd === i.cwd && i.setup.nothing !== null ? { kind: 'nothing', reason: i.setup.nothing } : { kind: 'looking' }
}

/** True when the pane should ask POST /dw/folder: the list is read, the folder is in no project, and it was not asked yet. */
export const needsSetup = (i: PaneInput): boolean => paneView(i).kind === 'looking' && i.setup?.cwd !== i.cwd

/** Servers of other projects that answer at an address, by name: the pane lists them under this folder's own. */
export function otherRunning(projects: DevWebProject[] | null, current: DevWebProject | null): { proc: DevWebProcess; project: DevWebProject }[] {
  return (projects ?? [])
    .filter((p) => p.id !== current?.id)
    .flatMap((project) => project.processes.filter((proc) => proc.status === 'running' && processAddress(proc)).map((proc) => ({ proc, project })))
    .sort((a, b) => a.proc.name.localeCompare(b.proc.name))
}

/** Servers the browser can show right now, for its empty page: this folder's that answer at an address, then the other folders'. */
export function openable(projects: DevWebProject[] | null, current: DevWebProject | null): DevWebProcess[] {
  const own = (current?.processes ?? []).filter((p) => p.status === 'running' && processAddress(p))
  return [...own, ...otherRunning(projects, current).map((r) => r.proc)]
}

export type Dot = 'run' | 'wait' | 'bad' | 'off'

export function statusDot(s: DevWebProcessStatus): Dot {
  if (s === 'running') return 'run'
  if (s === 'starting' || s === 'waiting' || s === 'stopping') return 'wait'
  if (s === 'crashed') return 'bad'
  return 'off'
}

export const statusWord = (p: Pick<DevWebProcess, 'status' | 'exitCode'>): string =>
  p.status === 'crashed' && p.exitCode !== null ? `crashed (exit ${p.exitCode})` : p.status

/** A server that is up or coming up is stopped by its button; one that is not is started by it. */
export const isUp = (s: DevWebProcessStatus): boolean => s === 'running' || s === 'starting' || s === 'waiting'

/** The last `n` non-empty lines, for a server that failed. */
export function tailLines(lines: { line: string }[], n = 6): string[] {
  return lines
    .map((l) => l.line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
}

/** What the address bar's text means: a full address, a bare host[:port][/path], or a bare port; null when neither. */
export function parseAddress(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}/`
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** DevWebUI's own address for a server, for when the page refuses to be framed straight. */
export function proxyAddress(daemonUrl: string, proc: Pick<DevWebProcess, 'id'>): string {
  return `${daemonUrl.replace(/\/+$/, '')}/proxy/${proc.id}/`
}

export const PANE_MIN = 420
export const PANE_MAX = 900
export const PANE_DEFAULT = 520
export const PANE_KEY = 'hydra-desk.servers.width'

export const clampPane = (w: number, room = Number.POSITIVE_INFINITY): number => Math.round(Math.min(Math.max(w, PANE_MIN), Math.min(PANE_MAX, Math.max(PANE_MIN, room))))

export function loadPaneWidth(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): number {
  const n = Number(storage?.getItem(PANE_KEY))
  return n >= PANE_MIN && n <= PANE_MAX ? n : PANE_DEFAULT
}

// ---- saved browsers: the profile list, the live canvas and what the person's input becomes ----

/** CDP's modifier bit field. */
export const MOD_ALT = 1
export const MOD_CTRL = 2
export const MOD_META = 4
export const MOD_SHIFT = 8

export interface ModifierState {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export const modifiersOf = (e: ModifierState): number => (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0) | (e.shiftKey ? MOD_SHIFT : 0)

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The frame as drawn in a canvas of `w` by `h`: scaled to fit, centred, aspect kept. */
export function fitFrame(w: number, h: number, frame: { width: number; height: number }): { x: number; y: number; width: number; height: number; scale: number } {
  if (frame.width <= 0 || frame.height <= 0 || w <= 0 || h <= 0) return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  const scale = Math.min(w / frame.width, h / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (w - width) / 2, y: (h - height) / 2, width, height, scale }
}

/**
 * A pointer position (client pixels) on the canvas's box as page CSS pixels of the frame it shows, undoing the
 * letterboxing. Outside the drawn page it is null, or with `clamp` the nearest edge (a drag that left the page).
 */
export function mapPoint(box: Box, frame: { width: number; height: number }, clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
  const fit = fitFrame(box.width, box.height, frame)
  if (fit.scale === 0) return null
  const x = (clientX - box.left - fit.x) / fit.scale
  const y = (clientY - box.top - fit.y) / fit.scale
  if (x >= 0 && y >= 0 && x <= frame.width && y <= frame.height) return { x, y }
  if (!clamp) return null
  return { x: Math.min(Math.max(x, 0), frame.width), y: Math.min(Math.max(y, 0), frame.height) }
}

type Button = Extract<BrowserLiveIn, { type: 'mouse' }>['button']

/** `button` of a down/up (0 left, 1 middle, 2 right) or, for a move, the first of `buttons` held. */
export function mouseButton(e: { type: string; button: number; buttons: number }): Button {
  if (e.type === 'mousemove') return e.buttons & 1 ? 'left' : e.buttons & 4 ? 'middle' : e.buttons & 2 ? 'right' : 'none'
  return e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'none'
}

export interface KeyLike extends ModifierState {
  type: string
  key: string
  code: string
}

/** True for the paste shortcut: the page's own paste event carries the text, so the key is not sent as well. */
export const isPasteKey = (e: Pick<KeyLike, 'key' | 'ctrlKey' | 'metaKey'>): boolean => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v'

/** A keydown/keyup as the message the live socket takes; `text` is set on a printable key's down (Enter types a return). */
export function keyMessage(e: KeyLike): Extract<BrowserLiveIn, { type: 'key' }> {
  const down = e.type === 'keydown'
  const msg: Extract<BrowserLiveIn, { type: 'key' }> = { type: 'key', event: down ? 'down' : 'up', key: e.key, code: e.code, modifiers: modifiersOf(e) }
  if (down && !e.ctrlKey && !e.metaKey) {
    if ([...e.key].length === 1) msg.text = e.key
    else if (e.key === 'Enter') msg.text = '\r'
  }
  return msg
}

/** The address bar's text as a page address: kept when it has a scheme, else https:// goes in front; null when empty. */
export function normalizeAddress(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data|chrome|file|blob|view-source):/i.test(t)) return t
  return `https://${t}`
}

/** BROWSER_LIVE's address for a page at `loc`. */
export function liveSocketUrl(loc: { protocol: string; host: string }, cwd: string, profile: string, tab?: string): string {
  const q = new URLSearchParams({ cwd, profile })
  if (tab) q.set('tab', tab)
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${BROWSER_LIVE}?${q}`
}

export function formatAgo(iso: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(t)) return 'never used'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export interface ProfileRow {
  name: string
  note: string | null
  /** Hosts the profile holds a session for. */
  hosts: string[]
  open: boolean
  lastUsed: string
}

export function profileRows(list: BrowserProfiles | null, now = Date.now()): ProfileRow[] {
  return (list?.profiles ?? []).map((p) => ({ name: p.name, note: p.note?.trim() ? p.note.trim() : null, hosts: [...new Set(p.sessionHosts)], open: p.open, lastUsed: formatAgo(p.lastUsedAt, now) }))
}

/** What the transcript card asked to see: the profile when the list has it, else just the address. */
export type RequestTarget = { kind: 'profile'; profile: string } | { kind: 'missing'; profile: string | null; url: string | null }

export function resolveRequest(req: BrowserOpenRequest, list: BrowserProfiles | null): RequestTarget {
  const found = req.profile ? list?.profiles.find((p) => p.name === req.profile) : undefined
  return found ? { kind: 'profile', profile: found.name } : { kind: 'missing', profile: req.profile ?? null, url: req.url ?? null }
}
