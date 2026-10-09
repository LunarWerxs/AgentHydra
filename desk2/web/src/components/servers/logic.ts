// The servers pane's decisions, pure so the tests and the component share them: what the pane shows for the
// dev-servers service's status and the project list, when it sets the chat's folder up, a server's dot, the address bar's
// input, and the pane's width.
import { BROWSER_LIVE, type BrowserLiveIn, type BrowserOpenRequest, type BrowserProfiles, type BrowserTab, isRealPage } from '@shared/browser'
import { DW_PROXY, type DevWebCompany, type DevWebFoundRow, type DevWebProcess, type DevWebProcessStatus, type DevWebProject, type DevWebStatus, type LocalServer, processAddress, projectForCwd } from '@shared/devwebui'
import { shortName } from './names'

/** What the pane draws. */
export type PaneView =
  | { kind: 'loading' }
  /** /dw/status answered 404: the live Desk 2 server was started before the route existed. */
  | { kind: 'restart-desk' }
  | { kind: 'starting' }
  | { kind: 'failed'; reason: string }
  /** Stopped on purpose (Settings): it starts again on the next request, and this view offers one. */
  | { kind: 'stopped' }
  /** The service runs but its project list could not be read. */
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

/** A local page (file://): a plain browser's frame cannot show one, so the tab says where it opens. */
export const isLocalPage = (url: string): boolean => /^file:/i.test(url.trim())

/** A server opened on a New tab (its row, or its Start): the address the tab goes to at once, null when it has none
 *  until it answers, and whether it is started first. DevWebUI's port is the server's own, so it is known before it runs. */
export function openPlan(p: Pick<DevWebProcess, 'status' | 'port' | 'url'>): { show: string | null; start: boolean } {
  return { show: processAddress(p), start: p.status === 'stopped' || p.status === 'crashed' }
}

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

/** Desk's own (same-origin) address for a server, for when the page refuses to be framed straight. */
export const proxyAddress = (proc: Pick<DevWebProcess, 'id'>): string => `${DW_PROXY}/${encodeURIComponent(proc.id)}/`

/** A quiet note under a server that someone else runs: AgentHydra uses that copy and never starts a second. */
export const OUTSIDE_NOTE = 'started outside AgentHydra'
export const OUTSIDE_TIP = 'Already running from a terminal, another chat or another tool. AgentHydra uses it rather than starting a second copy.'

/** The note a server's row wears, or null: only a server that is up and was started outside. */
export const outsideNote = (p: Pick<DevWebProcess, 'owner'>): string | null => (p.owner === 'outside' ? OUTSIDE_NOTE : null)

/** Why a server's Start is off (its port is held by a program that is not a dev server), or null. A server that is up has no conflict to show. */
export const startBlock = (p: Pick<DevWebProcess, 'conflict' | 'status'>): string | null => (p.conflict && !isUp(p.status) ? p.conflict : null)

/** The small notice after a Start that found the server already up. */
export const REUSED_NOTE = 'Already running: opened the running copy'
export const startReused = (answer: unknown): boolean => !!answer && typeof answer === 'object' && (answer as { reused?: unknown }).reused === true

export type ServiceTone = 'ok' | 'busy' | 'bad' | 'idle'

/** The dev-servers service as Settings -> Connectors words it. */
export function serviceLine(s: DevWebStatus | null): { text: string; tone: ServiceTone } {
  if (!s) return { text: 'Checking…', tone: 'idle' }
  if (s.state === 'starting') return { text: 'Starting…', tone: 'busy' }
  if (s.state === 'failed') return { text: s.reason || 'It did not start', tone: 'bad' }
  if (s.state === 'stopped') return { text: 'Not running (starts when a chat or the servers pane needs it)', tone: 'idle' }
  if (s.stale) return { text: 'Restart to load new code', tone: 'busy' }
  const n = s.running
  return { text: n === undefined ? 'Running' : n === 0 ? 'Running, no servers' : `Running, ${n} ${n === 1 ? 'server' : 'servers'}`, tone: 'ok' }
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

/** The frame as drawn in a canvas of `w` by `h`: scaled to fit, centred across and flush with the top, aspect kept. */
export function fitFrame(w: number, h: number, frame: { width: number; height: number }): { x: number; y: number; width: number; height: number; scale: number } {
  if (frame.width <= 0 || frame.height <= 0 || w <= 0 || h <= 0) return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  const scale = Math.min(w / frame.width, h / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (w - width) / 2, y: 0, width, height, scale }
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

export type WheelDelta = Omit<Extract<BrowserLiveIn, { type: 'wheel' }>, 'type'>

/** Wheel ticks between two animation frames become one wheel message: the deltas add up, at the latest point. */
export function wheelCoalescer(send: (w: WheelDelta) => void, nextFrame: (run: () => void) => void) {
  let acc: WheelDelta | null = null
  let queued = false
  const flush = () => {
    queued = false
    const w = acc
    acc = null
    if (w) send(w)
  }
  return {
    add(w: WheelDelta) {
      acc = acc ? { x: w.x, y: w.y, deltaX: acc.deltaX + w.deltaX, deltaY: acc.deltaY + w.deltaY } : w
      if (!queued) {
        queued = true
        nextFrame(flush)
      }
    },
    flush,
  }
}

export interface KeyLike extends ModifierState {
  type: string
  key: string
  code: string
}

/** True for the paste shortcut: the page's own paste event carries the text, so the key is not sent as well. */
export const isPasteKey = (e: Pick<KeyLike, 'key' | 'ctrlKey' | 'metaKey'>): boolean => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v'

/** The clipboard shortcut a key press is, if any: Ctrl/Cmd+C, X, V and the old Ctrl+Insert, Shift+Delete, Shift+Insert. */
export function clipboardAction(e: Pick<KeyLike, 'key' | 'ctrlKey' | 'metaKey'> & { shiftKey: boolean; altKey: boolean }): 'copy' | 'cut' | 'paste' | null {
  if (e.altKey) return null
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (mod && !e.shiftKey) return k === 'c' ? 'copy' : k === 'x' ? 'cut' : k === 'v' ? 'paste' : k === 'insert' ? 'copy' : null
  if (e.shiftKey && !mod) return k === 'insert' ? 'paste' : k === 'delete' ? 'cut' : null
  return null
}

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
export function liveSocketUrl(loc: { protocol: string; host: string }, cwd: string, profile: string, tab?: string, chat?: string): string {
  const q = new URLSearchParams({ cwd, profile })
  if (tab) q.set('tab', tab)
  if (chat) q.set('chat', chat)
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
  /** The short name shown for it (`shortName`); `name` stays what a tool takes. */
  label?: string
  note: string | null
  /** Hosts the profile holds a session for. */
  hosts: string[]
  open: boolean
  lastUsed: string
}

export function profileRows(list: BrowserProfiles | null, now = Date.now()): ProfileRow[] {
  return (list?.profiles ?? []).map((p) => ({
    name: p.name,
    label: shortName(p),
    note: p.note?.trim() ? p.note.trim() : null,
    hosts: [...new Set(p.sessionHosts)],
    open: p.open,
    lastUsed: formatAgo(p.lastUsedAt, now)
  }))
}

/** What the transcript card asked to see: the profile when the list has it, else just the address. */
export type RequestTarget = { kind: 'profile'; profile: string } | { kind: 'missing'; profile: string | null; url: string | null }

export function resolveRequest(req: BrowserOpenRequest, list: BrowserProfiles | null): RequestTarget {
  const found = req.profile ? list?.profiles.find((p) => p.name === req.profile) : undefined
  return found ? { kind: 'profile', profile: found.name } : { kind: 'missing', profile: req.profile ?? null, url: req.url ?? null }
}

// ---- the pane's tabs, like a browser's: a New tab shows the servers, a page shows one, a saved tab a saved browser ----

export type TabKind = 'new' | 'page' | 'saved'

export interface PaneTab {
  id: string
  kind: TabKind
  /** page: the address; saved: the profile name; new: null. */
  target: string | null
  /** page: the dev server it shows, when it was opened from one. */
  proc: string | null
  /** saved: the address a transcript card asked to see, used when the browser is opened from here; a page tab's last known address. */
  url?: string
  /** saved: the one page (the Chrome's own id for it) this tab shows live. A saved tab without one stands for the profile itself, not open or not yet showing a page. */
  page?: string
}

export interface TabsState {
  tabs: PaneTab[]
  active: string
}

export type TabSpec = Omit<PaneTab, 'id'>

let tabCounter = 0
export const nextTabId = (): string => `tab${++tabCounter}`

export const NEW_TAB: TabSpec = { kind: 'new', target: null, proc: null }

export function freshTabs(id = nextTabId()): TabsState {
  return { tabs: [{ id, ...NEW_TAB }], active: id }
}

/** A new tab at the end, shown. */
export function openTab(s: TabsState, spec: TabSpec = NEW_TAB, id = nextTabId()): TabsState {
  return { tabs: [...s.tabs, { id, ...spec }], active: id }
}

export const activateTab = (s: TabsState, id: string): TabsState => (s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s)

/** What a tab shows is replaced (a server clicked on the New tab, an address typed): the tab keeps its place and id. */
export function retargetTab(s: TabsState, id: string, spec: TabSpec): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { id, ...spec } : t)) }
}

/** Closing the shown tab shows its right neighbour, else its left; closing the last one leaves one New tab. */
export function closeTab(s: TabsState, id: string, spare = nextTabId()): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return s
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (!tabs.length) return freshTabs(spare)
  return { tabs, active: s.active === id ? (tabs[Math.min(i, tabs.length - 1)] as PaneTab).id : s.active }
}

/** Each chat has tabs of its own, even beside another chat in the same folder; the saved browsers are the workspace's. */
export const tabsKey = (chatId: string): string => `hydra-desk.servers.tabs.chat:${chatId}`

/** The tab a Browser card's request shows: its saved browser, else its address. */
export function requestTab(r: BrowserOpenRequest): TabSpec | null {
  if (r.profile) return { kind: 'saved', target: r.profile, proc: null, ...(r.url ? { url: r.url } : {}) }
  return r.url ? { kind: 'page', target: r.url, proc: null } : null
}

export function serializeTabs(s: TabsState): string {
  return JSON.stringify({ tabs: s.tabs.map((t) => ({ kind: t.kind, target: t.target, proc: t.proc, ...(t.url ? { url: t.url } : {}), ...(t.page ? { page: t.page } : {}) })), active: Math.max(0, s.tabs.findIndex((t) => t.id === s.active)) })
}

/** One saved tab, or null when it has no kind or no target. */
function restoreTab(item: unknown): PaneTab | null {
  const t = (item ?? {}) as Partial<TabSpec>
  const kind = t.kind
  if (kind !== 'new' && kind !== 'page' && kind !== 'saved') return null
  if (kind !== 'new' && (typeof t.target !== 'string' || t.target === '')) return null
  const tab: PaneTab = { id: nextTabId(), kind, target: kind === 'new' ? null : (t.target as string), proc: kind === 'page' && typeof t.proc === 'string' ? t.proc : null }
  if (kind === 'saved' && typeof t.url === 'string' && t.url) tab.url = t.url
  if (kind === 'saved' && typeof t.page === 'string' && t.page) tab.page = t.page
  return tab
}

/** Reads what serializeTabs wrote; anything unreadable, or a tab without its target, is dropped, and nothing left is one New tab. */
export function restoreTabs(raw: string | null | undefined): TabsState {
  try {
    const data = JSON.parse(raw ?? '') as { tabs?: unknown; active?: unknown }
    const list = Array.isArray(data.tabs) ? data.tabs : []
    const tabs: PaneTab[] = []
    let active = ''
    list.forEach((item, i) => {
      const tab = restoreTab(item)
      if (!tab) return
      tabs.push(tab)
      if (i === data.active) active = tab.id
    })
    if (!tabs.length) return freshTabs()
    return { tabs, active: active || (tabs[0] as PaneTab).id }
  } catch {
    return freshTabs()
  }
}

/** A chat's remembered tabs. One with none yet starts on the browser its AI last used (`aiBrowser`), else one New tab. */
export function loadTabs(chatId: string, aiBrowser: BrowserOpenRequest | null = null, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): TabsState {
  const raw = storage?.getItem(tabsKey(chatId))
  if (raw != null) return restoreTabs(raw)
  const first = aiBrowser && requestTab(aiBrowser)
  return first ? openTab({ tabs: [], active: '' }, first) : freshTabs()
}

export function saveTabs(chatId: string, s: TabsState, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try {
    storage?.setItem(tabsKey(chatId), serializeTabs(s))
  } catch {
    // a full or blocked store: the tabs are just not remembered
  }
}

// ---- a saved browser's pages: one top tab per real page, kept in step with the Chrome ----

/** The address with its hash and a trailing slash dropped, for telling whether two are the same page. */
export function pageKey(url: string): string {
  const t = url.trim()
  try {
    const u = new URL(t)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  } catch {
    return t
  }
}
export const sameAddress = (a: string, b: string): boolean => pageKey(a) === pageKey(b)

/** What shows for an address: its host (a file's name). */
export function hostOf(url: string | null | undefined): string {
  try {
    const u = new URL(url ?? '')
    return u.host || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return ''
  }
}

/** A saved browser's page tab's name: the page's title, else its host; the profile's label when nothing is known. */
export function savedTabTitle(t: Pick<PaneTab, 'target' | 'page' | 'url'>, pages: BrowserTab[] | undefined, label: string | null): string {
  if (!t.page) return label ?? t.target ?? 'Saved browser'
  const p = pages?.find((x) => x.id === t.page)
  return p?.title.trim() || hostOf(p?.url ?? t.url) || label || t.target || 'Saved browser'
}

/**
 * The profile's tabs follow its Chrome's pages: a real page without a tab gets one at the end (a tab standing for the profile
 * itself, with no page yet, takes the first); a page that went loses its tab; a page that went blank loses it too unless it is
 * the shown one, which stays (the view says the page is blank). A blank page never gets a tab. `pages` is null when the Chrome
 * could not be asked: nothing changes then. The same state comes back when nothing changed.
 */
export function syncPages(s: TabsState, profile: string, pages: BrowserTab[] | null, mkId: () => string = nextTabId): TabsState {
  if (!pages) return s
  const byId = new Map(pages.map((p) => [p.id, p]))
  let next = s
  for (const t of s.tabs) {
    if (t.kind !== 'saved' || t.target !== profile || !t.page) continue
    const p = byId.get(t.page)
    if (!p || (!isRealPage(p.url) && t.id !== s.active)) next = closeTab(next, t.id, mkId())
  }
  const have = new Set(next.tabs.filter((t) => t.kind === 'saved' && t.target === profile && t.page).map((t) => t.page))
  let tabs = next.tabs.map((t) => {
    const p = t.kind === 'saved' && t.target === profile && t.page ? byId.get(t.page) : undefined
    return p && p.url !== t.url ? { ...t, url: p.url } : t
  })
  for (const p of pages) {
    if (have.has(p.id) || !isRealPage(p.url)) continue
    const holder = tabs.findIndex((t) => t.kind === 'saved' && t.target === profile && !t.page)
    if (holder >= 0) tabs = tabs.map((t, i) => (i === holder ? { ...t, page: p.id, url: p.url } : t))
    else tabs = [...tabs, { id: mkId(), kind: 'saved', target: profile, proc: null, page: p.id, url: p.url }]
  }
  const same = tabs.length === s.tabs.length && tabs.every((t, i) => t === s.tabs[i])
  if (same && next === s) return s
  return { ...next, tabs }
}

/** What a Browser card's click on a saved browser does, given what the Chrome holds now ('closed': not open; null: could not be asked). */
export type CardPlan = { kind: 'pick'; tab: string } | { kind: 'add'; page: BrowserTab } | { kind: 'new'; url: string } | { kind: 'placeholder' }

export function cardPlan(s: TabsState, profile: string, url: string | undefined, pages: BrowserTab[] | 'closed' | null): CardPlan {
  const mine = s.tabs.filter((t) => t.kind === 'saved' && t.target === profile)
  const placeholder = (): CardPlan => {
    const holder = mine.find((t) => !t.page)
    return holder ? { kind: 'pick', tab: holder.id } : { kind: 'placeholder' }
  }
  if (pages === null || pages === 'closed') return placeholder()
  const wanted = url && isRealPage(url) ? url : null
  if (wanted) {
    const page = pages.find((p) => sameAddress(p.url, wanted))
    if (page) {
      const tab = mine.find((t) => t.page === page.id)
      return tab ? { kind: 'pick', tab: tab.id } : { kind: 'add', page }
    }
    // A page that exists is never navigated (the AI may be driving it): the address opens in a page of its own.
    if (/^https?:\/\//i.test(wanted)) return { kind: 'new', url: wanted }
  }
  const first = mine.find((t) => t.page) ?? mine[0]
  return first ? { kind: 'pick', tab: first.id } : placeholder()
}

/** Every word of the filter appears in the text, ignoring case. */
export function matchesFilter(text: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export const filterServers = <T extends Pick<DevWebProcess, 'name' | 'port' | 'status'>>(procs: T[], filter: string): T[] =>
  procs.filter((p) => matchesFilter(`${p.name} ${p.port ? `:${p.port} ${p.port}` : ''} ${p.status}`, filter))

export const filterLocal = <T extends Pick<LocalServer, 'port' | 'process' | 'title' | 'company' | 'dir'>>(rows: T[], filter: string): T[] =>
  rows.filter((r) => matchesFilter(`:${r.port} ${r.port} ${r.process ?? ''} ${r.title ?? ''} ${r.company?.name ?? ''} ${r.dir ?? ''}`, filter))

export const filterProfiles =(rows: ProfileRow[], filter: string): ProfileRow[] => rows.filter((r) => matchesFilter(`${r.name} ${r.label ?? ''} ${r.note ?? ''} ${r.hosts.join(' ')}`, filter))

/** True when the text is meant as an address, not as a search: a port, a scheme, localhost, a host with a dot, or host:port. */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (t === '' || /\s/.test(t)) return false
  if (/^\d{2,5}$/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true
  return /^localhost(?=[:/]|$)/i.test(t) || /^[^/:]+\.[^/:.]+(?=[:/]|$)/.test(t) || /^[^/:]+:\d{2,5}(?=\/|$)/.test(t)
}

export type EnterTarget = { kind: 'address'; url: string } | { kind: 'server'; id: string } | { kind: 'saved'; name: string }

/** A Google search for the text. `igu=1` is Google's own page that lets itself be shown in a frame, as a tab is. */
export const searchAddress = (text: string): string => `https://www.google.com/search?igu=1&q=${encodeURIComponent(text.trim())}`

/** What an address bar's text opens: an address or a port, else a search for it; null when it is empty. */
export function addressOrSearch(text: string): string | null {
  if (!text.trim()) return null
  return (looksLikeAddress(text) && parseAddress(text)) || searchAddress(text)
}

/** What Enter does in the New tab's address bar: an address or a port opens, otherwise the first match (servers first),
 *  otherwise a search for the text. */
export function enterTarget(text: string, servers: Pick<DevWebProcess, 'id'>[], saved: Pick<ProfileRow, 'name'>[]): EnterTarget | null {
  if (looksLikeAddress(text)) {
    const url = parseAddress(text)
    if (url) return { kind: 'address', url }
  }
  if (servers[0]) return { kind: 'server', id: servers[0].id }
  if (saved[0]) return { kind: 'saved', name: saved[0].name }
  const url = addressOrSearch(text)
  return url ? { kind: 'address', url } : null
}

/** A page tab's title: the server's name, else the address's host. */
export function pageTitle(url: string | null, proc: Pick<DevWebProcess, 'name'> | null): string {
  if (proc) return proc.name
  if (!url) return 'New tab'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// ---- the sidebar's Dev servers view: every project with its servers under it ----

/** What the sidebar draws for the service's status and the project list (the pane's states, without a folder). */
export type ListView =
  | { kind: 'loading' }
  | { kind: 'restart-desk' }
  | { kind: 'starting' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }
  | { kind: 'unreachable'; reason: string }
  /** The service runs and has no project yet. */
  | { kind: 'empty' }
  | { kind: 'list'; groups: ServerGroup[] }

/** One project and its servers, running ones first. */
export interface ServerGroup {
  project: DevWebProject
  servers: DevWebProcess[]
  /** How many of them answer (status running). */
  running: number
}

export type ListInput = Pick<PaneInput, 'status' | 'statusMissing' | 'projects' | 'projectsError'>

export function listView(i: ListInput): ListView {
  if (i.statusMissing) return { kind: 'restart-desk' }
  if (!i.status) return { kind: 'loading' }
  if (i.status.state === 'starting') return { kind: 'starting' }
  if (i.status.state === 'failed') return { kind: 'failed', reason: i.status.reason ?? 'it did not start' }
  if (i.status.state === 'stopped') return { kind: 'stopped' }
  if (i.projectsError) return { kind: 'unreachable', reason: i.projectsError }
  if (!i.projects) return { kind: 'loading' }
  if (!i.projects.length) return { kind: 'empty' }
  return { kind: 'list', groups: groupServers(i.projects) }
}

const RANK: Record<DevWebProcessStatus, number> = { running: 0, starting: 1, waiting: 1, stopping: 2, crashed: 3, stopped: 4 }

/** Running servers first, then the ones coming up, going down, crashed and stopped; by name inside each. */
export const sortServers = (procs: readonly DevWebProcess[]): DevWebProcess[] => [...procs].sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name))

/** A project per group, the ones with a server running first, then by name; a project's servers sorted by `sortServers`. */
export function groupServers(projects: readonly DevWebProject[]): ServerGroup[] {
  return projects
    .map((project) => ({ project, servers: sortServers(project.processes), running: project.processes.filter((p) => p.status === 'running').length }))
    .sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.project.name.localeCompare(b.project.name))
}

// ---- the list's grouping (owner, 2026-10-07: "sorted by ... their main parent company", groups "collapsible ... default
// collapsed if they have none running. If they do have any running, it should show the one running unless I expand",
// the found ones "by their company, project, name") ----

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
/** Companies by name, a leading "+" or "_" left out (a folder named "+Notes" sorts under N, not before A). */
const byCompany = (a: DevWebCompany | null, b: DevWebCompany | null): number => {
  const bare = (c: DevWebCompany | null) => c?.name.replace(/^[^\p{L}\p{N}]+/u, '') || c?.name || ''
  return byName(bare(a), bare(b))
}
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
/** Where `dir` is below `parent`, as a relative path; null when it is not below it (or is it). */
const below = (dir: string, parent: string): string | null => {
  const d = slashed(dir)
  const p = slashed(parent)
  return d.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? d.slice(p.length + 1) : null
}

/** A company's projects in the list, with how many of their servers are up and how many there are (whatever a filter shows). */
export interface CompanyGroup<G extends Pick<ServerGroup, 'project'> = ServerGroup> {
  company: DevWebCompany
  groups: G[]
  up: number
  total: number
}

/** The project groups by company: companies with a server up first, then by name; inside, the groups' own order. */
export function companyGroups<G extends Pick<ServerGroup, 'project'>>(groups: readonly G[]): CompanyGroup<G>[] {
  const by = new Map<string, CompanyGroup<G>>()
  for (const g of groups) {
    const k = g.project.company.dir.toLowerCase()
    let c = by.get(k)
    if (!c) by.set(k, (c = { company: g.project.company, groups: [], up: 0, total: 0 }))
    c.groups.push(g)
    c.up += g.project.processes.filter((p) => isUp(p.status)).length
    c.total += g.project.processes.length
  }
  return [...by.values()].sort((a, b) => Number(b.up > 0) - Number(a.up > 0) || byCompany(a.company, b.company))
}

/**
 * A project group's rows: open, every server; closed, the ones that are up or still stopping and the one selected, so
 * nothing running hides (and a Stop from a closed group keeps its row until the server is down).
 */
export function shownServers<T extends Pick<DevWebProcess, 'id' | 'status'>>(servers: readonly T[], open: boolean, selectedId: string | null): T[] {
  return open ? [...servers] : servers.filter((p) => isUp(p.status) || p.status === 'stopping' || p.id === selectedId)
}

/** A project folder in the found list: the folder below its company that the items are in. */
export interface FoundProject<T> {
  dir: string
  name: string
  items: T[]
  /** Where an item is below this folder, for the items whose name another item here shares (four "Web"s say which). */
  where: Map<string, string>
}

export interface FoundCompany<T> {
  company: DevWebCompany
  projects: FoundProject<T>[]
  count: number
}

type FoundItem = Pick<DevWebFoundRow, 'kind' | 'path' | 'name' | 'company'>

/** The folder a found item is: a file's folder, else its own path. */
function foundDir(i: Pick<DevWebFoundRow, 'kind' | 'path'>): string {
  const own = slashed(i.path)
  return i.kind === 'file' ? own.slice(0, Math.max(own.lastIndexOf('/'), 0)) : own
}

/** Sorts a found project's items and says where each one that shares its name with another is below the project. */
function settleFoundProject<T extends FoundItem>(pr: FoundProject<T>): void {
  pr.items.sort((a, b) => byName(a.name, b.name) || byName(a.path, b.path))
  const named = new Map<string, number>()
  for (const i of pr.items) named.set(i.name.toLowerCase(), (named.get(i.name.toLowerCase()) ?? 0) + 1)
  for (const i of pr.items) {
    if ((named.get(i.name.toLowerCase()) ?? 0) < 2) continue
    const at = below(foundDir(i), pr.dir)
    if (at) pr.where.set(i.path, at)
  }
}

function foundCompany<T extends FoundItem>(company: DevWebCompany, projects: Map<string, FoundProject<T>>): FoundCompany<T> {
  const list = [...projects.values()].sort((a, b) => Number(b.dir === slashed(company.dir)) - Number(a.dir === slashed(company.dir)) || byName(a.name, b.name))
  for (const pr of list) settleFoundProject(pr)
  return { company, projects: list, count: list.reduce((n, pr) => n + pr.items.length, 0) }
}

/**
 * The found list by company, then by the folder just below the company's (each copy or app of it; the company's own
 * folder is a project too, named for the company, and comes first), then by name; companies by name.
 */
export function foundTree<T extends FoundItem>(items: readonly T[]): FoundCompany<T>[] {
  const companies = new Map<string, { company: DevWebCompany; projects: Map<string, FoundProject<T>> }>()
  for (const i of items) {
    const dir = foundDir(i)
    const cdir = slashed(i.company.dir)
    const top = below(dir, cdir)?.split('/')[0] ?? ''
    const ck = cdir.toLowerCase()
    let c = companies.get(ck)
    if (!c) companies.set(ck, (c = { company: i.company, projects: new Map() }))
    const pdir = top ? `${cdir}/${top}` : cdir
    let pr = c.projects.get(pdir.toLowerCase())
    if (!pr) c.projects.set(pdir.toLowerCase(), (pr = { dir: pdir, name: top || i.company.name, items: [], where: new Map() }))
    pr.items.push(i)
  }
  return [...companies.values()].map(({ company, projects }) => foundCompany(company, projects)).sort((a, b) => byCompany(a.company, b.company))
}

/** Other servers by the company of the folder they run from, companies by name and the ones with no folder last; by port inside. */
export function otherGroups<T extends Pick<LocalServer, 'company' | 'port'>>(rows: readonly T[]): { company: DevWebCompany | null; servers: T[] }[] {
  const by = new Map<string, { company: DevWebCompany | null; servers: T[] }>()
  for (const r of rows) {
    const k = r.company ? r.company.dir.toLowerCase() : ''
    let g = by.get(k)
    if (!g) by.set(k, (g = { company: r.company, servers: [] }))
    g.servers.push(r)
  }
  for (const g of by.values()) g.servers.sort((a, b) => a.port - b.port)
  return [...by.values()].sort((a, b) => Number(!a.company) - Number(!b.company) || byCompany(a.company, b.company))
}

/**
 * An other server's row: its page title, else its program's name with the folder it runs from below its company (a bare
 * "node" or "bun" says nothing; "bun  app/desk2/server" does), else "Server".
 */
export function otherLabel(o: Pick<LocalServer, 'title' | 'process' | 'dir' | 'company'>): { name: string; where: string | null } {
  if (o.title) return { name: o.title, where: null }
  return { name: o.process || 'Server', where: o.dir && o.company ? below(o.dir, o.company.dir) : null }
}

/** The key the shared state's `busy` holds while a project's Start all / Stop all runs. */
export const allKey = (project: Pick<DevWebProject, 'id'>): string => `all:${project.id}`

export type ServerAction = 'start' | 'stop' | 'restart'

/** The buttons a server's row offers on hover: a server that is up is stopped or restarted, one that is not is started (a crashed one restarted too); none while it stops. */
export function serverActions(status: DevWebProcessStatus): ServerAction[] {
  if (status === 'stopping') return []
  if (isUp(status)) return ['stop', 'restart']
  return status === 'crashed' ? ['start', 'restart'] : ['start']
}

/** Whether an action's button is off for a server: a start (or restart) its port conflict refuses, or one already in flight. */
export const actionDisabled = (p: Pick<DevWebProcess, 'conflict' | 'status'>, action: ServerAction, busy: boolean): boolean => busy || (action !== 'stop' && startBlock(p) !== null)

/** A project header's Start all / Stop all, as the pane offers them: only for a project with more than one server, each only while some server it would act on is there. */
export function groupActions(servers: readonly Pick<DevWebProcess, 'status'>[]): { start: boolean; stop: boolean } {
  if (servers.length < 2) return { start: false, stop: false }
  return { start: servers.some((s) => s.status === 'stopped' || s.status === 'crashed'), stop: servers.some((s) => isUp(s.status)) }
}

/** The name and port a row shows: `web` and `:5173`; no port, no second part. */
export const serverPort = (p: Pick<DevWebProcess, 'port'>): string => (p.port ? `:${p.port}` : '')

/** The server and its project for an id, from the list the sidebar and the pane share. */
export function findServer(projects: readonly DevWebProject[] | null, id: string): { project: DevWebProject; proc: DevWebProcess } | null {
  for (const project of projects ?? []) {
    const proc = project.processes.find((p) => p.id === id)
    if (proc) return { project, proc }
  }
  return null
}

/** What the pane does when the sidebar asks it to show a server: bring its tab forward, open the page of one that answers, else start it in a new tab (which opens it once it answers). */
export type FocusPlan = { kind: 'pick'; tab: string } | { kind: 'open'; url: string } | { kind: 'start' }

export function focusPlan(proc: DevWebProcess, tabs: readonly PaneTab[]): FocusPlan {
  const have = tabs.find((t) => t.kind === 'page' && t.proc === proc.id)
  if (have) return { kind: 'pick', tab: have.id }
  const url = proc.status === 'running' ? processAddress(proc) : null
  return url ? { kind: 'open', url } : { kind: 'start' }
}
