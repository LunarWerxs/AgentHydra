// Chrome's DevTools protocol, as far as the browser pane needs it: is a profile's Chrome running, its pages, starting
// one, and one live view of a page. The host is always 127.0.0.1 and the port only ever comes from a profile folder's
// DevToolsActivePort (written by a Chrome started with --remote-debugging-port=0); nothing a request says names one.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserLiveIn, BrowserLiveOut, BrowserTab } from '@shared/browser'
import type { TabScope } from './ownership'

const HOST = '127.0.0.1'
const FALLBACK_FRAME = { width: 1280, height: 800 }

interface PortFile {
  port: number
  wsPath: string | null
}

function readPortFile(dir: string): PortFile | null {
  try {
    const [first, second] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')
    const text = first?.trim() ?? ''
    if (!/^\d{1,5}$/.test(text)) return null
    return { port: Number(text), wsPath: second?.trim() || null }
  } catch {
    return null
  }
}

async function getJson(port: number, path: string, timeoutMs = 1500): Promise<unknown> {
  const res = await fetch(`http://${HOST}:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}

/** The Chrome answering for this profile folder right now, or null. A file can outlive its browser, and a port is
 *  reused by a later launch: the endpoint path on its second line is per launch, so a mismatch is not this Chrome. */
export async function liveBrowser(dir: string): Promise<{ port: number } | null> {
  const file = readPortFile(dir)
  if (!file) return null
  try {
    const version = (await getJson(file.port, '/json/version')) as { webSocketDebuggerUrl?: string }
    if (file.wsPath && !String(version.webSocketDebuggerUrl ?? '').endsWith(file.wsPath)) return null
    return { port: file.port }
  } catch {
    return null
  }
}

interface Target {
  id: string
  type: string
  url: string
  title: string
}

export async function pageTabs(port: number): Promise<BrowserTab[]> {
  const list = (await getJson(port, '/json/list')) as Target[]
  return list.filter((t) => t.type === 'page').map((t) => ({ id: String(t.id), url: String(t.url ?? ''), title: String(t.title ?? '') }))
}

/** A new page in the Chrome (never navigates an existing one); null when it did not answer with a page. */
export async function newPage(port: number, url: string): Promise<BrowserTab | null> {
  const res = await fetch(`http://${HOST}:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) })
  if (!res.ok) return null
  const t = (await res.json()) as Target
  return t?.type === 'page' ? { id: String(t.id), url: String(t.url ?? url), title: String(t.title ?? '') } : null
}

/** Closes one page of the Chrome (the Chrome itself closes only when this was its last page); false when no such page. */
export async function closePage(port: number, id: string): Promise<boolean> {
  if (!(await pageTabs(port)).some((t) => t.id === id)) return false
  const res = await fetch(`http://${HOST}:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(4000) })
  return res.ok
}

/** The installed Chrome: HYDRA_DESK_CHROME when set (and then only that), else the standard install paths. */
export function findChrome(): string | null {
  const forced = process.env.HYDRA_DESK_CHROME
  if (forced) return existsSync(forced) ? forced : null
  const e = process.env
  const candidates =
    process.platform === 'win32'
      ? [
          `${e.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${e['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${e.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((c) => existsSync(c)) ?? null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const starting = new Map<string, Promise<number | null>>()

export class LaunchError extends Error {}

/**
 * Starts a visible Chrome on the profile folder. With a debugging port (login false) it waits up to 15 s for the port
 * file and answers the port; login:true starts it with nothing attached and answers null. Callers have checked that no
 * Chrome answers on this folder; two launches at once on one folder share the one start.
 */
export function launchChrome(dir: string, url: string | undefined, login: boolean): Promise<number | null> {
  const running = starting.get(dir)
  if (running) return running
  const p = doLaunch(dir, url, login).finally(() => starting.delete(dir))
  starting.set(dir, p)
  return p
}

/** Without these a Chrome whose window is covered or off screen throttles its page and sends no screencast frames at all. */
export const LIVE_CHROME_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
]

async function doLaunch(dir: string, url: string | undefined, login: boolean): Promise<number | null> {
  const chrome = findChrome()
  if (!chrome) throw new LaunchError('Chrome is not installed (looked in its standard install folders)')
  rmSync(join(dir, 'DevToolsActivePort'), { force: true }) // a stale file must not point at a Chrome that is gone
  const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...LIVE_CHROME_FLAGS]
  if (!login) args.push('--remote-debugging-port=0')
  if (url) args.push(url)
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    // floor-ok: a failed spawn is seen below as a port file that never comes
  })
  child.unref()
  if (login) return null
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    const live = await liveBrowser(dir)
    if (live) return live.port
    await sleep(150)
  }
  throw new LaunchError('Chrome did not announce its debugging port within 15 seconds')
}

/** Closes the Chrome of this profile folder (CDP Browser.close on its browser endpoint, which the folder's own port file names); false when none answers. */
export async function closeBrowser(dir: string): Promise<boolean> {
  const live = await liveBrowser(dir)
  const file = readPortFile(dir)
  if (!live || !file?.wsPath) return false
  const ws = new WebSocket(`ws://${HOST}:${live.port}${file.wsPath}`)
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('the browser did not accept a connection'))
      setTimeout(() => rej(new Error('the browser did not answer in time')), 4000)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    // Chrome answers, then exits; wait until its port stops answering (at most 5 s).
    for (let i = 0; i < 25; i++) {
      await sleep(200)
      if (!(await liveBrowser(dir))) return true
    }
    return false
  } finally {
    try {
      ws.close()
    } catch {
      // floor-ok: already closed
    }
  }
}

/** The first page of a Chrome that was just started (its page target can lag the port by a moment). */
export async function firstTab(port: number): Promise<BrowserTab | null> {
  for (let i = 0; i < 20; i++) {
    const tabs = await pageTabs(port).catch(() => [])
    if (tabs[0]) return tabs[0]
    await sleep(150)
  }
  return null
}

/** One small JPEG of a page, as base64: opens a CDP socket, captures once and closes it (no session outlives the call). */
export async function capturePreview(port: number, tabId: string, width = 640): Promise<Buffer> {
  // The URL is built from the id, as LiveSession does.
  const ws = new WebSocket(`ws://${HOST}:${port}/devtools/page/${encodeURIComponent(tabId)}`)
  const done = (): void => {
    try {
      ws.close()
    } catch {
      // floor-ok: already closed
    }
  }
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('the page did not accept a connection'))
      setTimeout(() => rej(new Error('the page did not answer in time')), 4000)
    })
    let next = 1
    const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: { message?: string } }) => void>()
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
        if (m.id !== undefined) pending.get(m.id)?.(m)
      } catch {
        // floor-ok: not a reply
      }
    }
    const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = next++
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 6000)
        pending.set(id, (m) => {
          clearTimeout(timer)
          pending.delete(id)
          if (m.error) reject(new Error(m.error.message ?? method))
          else resolve(m.result ?? {})
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const metrics = (await call('Page.getLayoutMetrics')) as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }
    const w = Math.max(1, Math.round(metrics.cssVisualViewport?.clientWidth ?? width))
    const h = Math.max(1, Math.round(metrics.cssVisualViewport?.clientHeight ?? width))
    const shot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: w, height: h, scale: Math.min(1, width / w) } })
    if (typeof shot.data !== 'string') throw new Error('no image')
    return Buffer.from(shot.data, 'base64')
  } finally {
    done()
  }
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

function virtualKeyCode(key: string): number {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key]
  if (key.length === 1) return key.toUpperCase().charCodeAt(0)
  return 0
}

/** Blink's editing commands for the shortcuts a synthesized key does not run by itself (CDP's `commands` on a key event). */
export function editCommands(key: string, modifiers: number): string[] | undefined {
  if (!(modifiers & 6) || modifiers & 1) return undefined
  const k = key.toLowerCase()
  if (k === 'a' && !(modifiers & 8)) return ['selectAll']
  if (k === 'z') return [modifiers & 8 ? 'redo' : 'undo']
  if (k === 'y' && !(modifiers & 8)) return ['redo']
  return undefined
}

/** Runs in the page: the selected text of the focused input/textarea, else of the document (an email or number input has no selection API, so its text comes from the document selection), looking into focused same-origin iframes; `cut` removes it from an editable one; a password field gives nothing. */
export const READ_SELECTION = (cut: boolean): string => `(() => {
  let doc = document
  for (let i = 0; i < 8; i++) {
    const a = doc.activeElement
    if (a && a.tagName === 'IFRAME') { try { if (a.contentDocument) { doc = a.contentDocument; continue } } catch {} }
    break
  }
  const a = doc.activeElement
  let text = ''
  let editable = false
  if (a && a.tagName === 'INPUT' && a.type === 'password') return ''
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && typeof a.selectionStart === 'number' && a.selectionStart !== null))) {
    try { text = a.value.slice(a.selectionStart, a.selectionEnd); editable = !a.readOnly && !a.disabled } catch {}
  } else {
    text = String(doc.getSelection ? doc.getSelection() : '')
    editable = !!(a && (a.isContentEditable || (a.tagName === 'INPUT' && !a.readOnly && !a.disabled)))
  }
  if (${cut} && text && editable) doc.execCommand('delete')
  return text
})()`

const MOUSE_TYPES = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' } as const

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

/** The live sessions by Chrome port, so a preview request can reuse the frames one is already receiving. */
const liveSessions = new Map<number, Set<LiveSession>>()

/** The live sessions of one chat on a port ('' is a viewer with no chat): chats never share frames. */
function sessionsOf(port: number, scope: string): LiveSession[] {
  return [...(liveSessions.get(port) ?? [])].filter((s) => s.scopeKey === scope)
}

/** The newest screencast frame (JPEG bytes) of a page of this chat being shown live on this port, or null when none is. */
export function liveFrame(port: number, scope = ''): Buffer | null {
  let newest: { at: number; data: string } | null = null
  for (const s of sessionsOf(port, scope)) if (s.frame && (!newest || s.frame.at > newest.at)) newest = s.frame
  return newest ? Buffer.from(newest.data, 'base64') : null
}

export interface TappedFrame {
  data: string
  width: number
  height: number
}

const frameTaps = new Map<string, Set<(f: TappedFrame) => void>>()
const tapKey = (port: number, scope: string): string => `${port}|${scope}`
const liveWatchers = new Set<(port: number) => void>()

/** Whether the pane is showing a page of this Chrome live (its screencast runs, so no second one is needed). */
export function hasLiveSession(port: number, scope = ''): boolean {
  return sessionsOf(port, scope).length > 0
}

/** The newest live frame with its size, for a viewer that joins between frames. */
export function liveFrameSized(port: number, scope = ''): TappedFrame | null {
  let newest: { at: number; f: TappedFrame } | null = null
  for (const s of sessionsOf(port, scope)) if (s.frame && (!newest || s.frame.at > newest.at)) newest = { at: s.frame.at, f: { data: s.frame.data, width: s.frame.width, height: s.frame.height } }
  return newest?.f ?? null
}

/** Calls fn with every frame a live session of this chat on this port receives; the returned function stops it. */
export function tapLiveFrames(port: number, fn: (f: TappedFrame) => void, scope = ''): () => void {
  const key = tapKey(port, scope)
  const set = frameTaps.get(key) ?? new Set()
  set.add(fn)
  frameTaps.set(key, set)
  return () => {
    set.delete(fn)
    if (set.size === 0 && frameTaps.get(key) === set) frameTaps.delete(key)
  }
}

/** Calls fn(port) when a live session starts or ends on that port. */
export function onLiveChange(fn: (port: number) => void): () => void {
  liveWatchers.add(fn)
  return () => void liveWatchers.delete(fn)
}

function liveChanged(port: number): void {
  for (const fn of [...liveWatchers]) fn(port)
}

/** One page of a profile's Chrome, shown live: frames and page changes out, input in. */
export class LiveSession {
  private cdp: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private tab: BrowserTab | null = null
  private lastTabs = ''
  private poll: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null
  private ended = false
  /** Bumped by every attach, so events of a socket that was replaced are dropped. */
  private epoch = 0
  /** The newest screencast frame (base64 JPEG), kept for liveFrame(). */
  frame: { at: number; data: string; width: number; height: number } | null = null
  /** The page size the viewer asked for, re-applied on every attach. */
  private size: { width: number; height: number } | null = null
  private dpr = 1

  constructor(
    private readonly port: number,
    private readonly out: (msg: BrowserLiveOut) => void,
    private readonly onEnd: () => void,
    /** Bound to the one page it was asked for: when that page closes the view ends, it does not move to another page. */
    private readonly bound = false,
    /** The chat this view is for: it shows and follows only that chat's pages and the unowned ones. Absent: every page. */
    private readonly scope: TabScope | null = null,
  ) {}

  /** The chat the frames belong to ('' for a view with no chat). */
  get scopeKey(): string {
    return this.scope?.key ?? ''
  }

  /** The page target to show: the asked-for tab, else the first page. Null when the Chrome has no such page. */
  static async pick(port: number, tab: string | null): Promise<BrowserTab | null> {
    const tabs = await pageTabs(port)
    return (tab ? tabs.find((t) => t.id === tab) : tabs[0]) ?? null
  }

  async start(tab: BrowserTab): Promise<void> {
    const mine = liveSessions.get(this.port) ?? new Set<LiveSession>()
    mine.add(this)
    liveSessions.set(this.port, mine)
    liveChanged(this.port)
    // A page that is not the front one of its Chrome paints no frames: the one asked for is brought to the front.
    if (this.bound) await fetch(`http://${HOST}:${this.port}/json/activate/${encodeURIComponent(tab.id)}`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined)
    await this.attach(tab)
    // Target events report tab changes as they happen; the slow poll catches whatever they miss.
    this.poll = setInterval(() => void this.watch(), 5000)
  }

  private async attach(tab: BrowserTab): Promise<void> {
    const epoch = ++this.epoch
    this.detach()
    this.tab = tab
    // The URL is built here from the id: a target's own webSocketDebuggerUrl is never followed.
    const ws = new WebSocket(`ws://${HOST}:${this.port}/devtools/page/${encodeURIComponent(tab.id)}`)
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('the page did not accept a connection'))
      setTimeout(() => rej(new Error('the page did not answer in time')), 8000)
    })
    this.cdp = ws
    ws.onmessage = (ev) => {
      if (epoch === this.epoch) this.onCdp(String(ev.data), epoch)
    }
    ws.onclose = () => {
      if (epoch === this.epoch) void this.watch()
    }
    await this.call('Page.enable')
    if (this.size) await this.applySize(this.size)
    await this.startScreencast()
    // Tab changes arrive as Target events; a Chrome that refuses them is left to the poll.
    await this.call('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
    await this.sendPage()
  }

  private async applySize(size: { width: number; height: number }): Promise<void> {
    await this.call('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false })
  }

  private startScreencast(): Promise<unknown> {
    return this.call('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, ...screencastCap(this.size ?? FALLBACK_FRAME, this.dpr) })
  }

  private detach(): void {
    const ws = this.cdp
    this.cdp = null
    for (const p of this.pending.values()) p.reject(new Error('detached'))
    this.pending.clear()
    if (ws) {
      ws.onmessage = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // floor-ok: already closed
      }
    }
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.cdp
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not attached'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private onCdp(raw: string, epoch: number): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p?.reject(new Error(msg.error.message ?? 'error'))
      else p?.resolve(msg.result)
      return
    }
    if (msg.method === 'Page.screencastFrame' && msg.params) {
      const meta = (msg.params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
      this.call('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {
        // floor-ok: the socket went away; the next frame never comes
      })
      if (epoch === this.epoch && typeof msg.params.data === 'string') {
        const width = Math.round(meta.deviceWidth ?? 0)
        const height = Math.round(meta.deviceHeight ?? 0)
        this.frame = { at: Date.now(), data: msg.params.data, width, height }
        this.out({ type: 'frame', data: msg.params.data, width, height })
        for (const tap of [...(frameTaps.get(tapKey(this.port, this.scopeKey)) ?? [])]) tap({ data: msg.params.data, width, height })
      }
      return
    }
    if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetDestroyed' || msg.method === 'Target.targetInfoChanged') {
      this.watchSoon()
      return
    }
    if (msg.method === 'Page.frameNavigated') {
      const frame = (msg.params?.frame ?? {}) as { parentId?: string }
      if (!frame.parentId) void this.sendPage()
    } else if (msg.method === 'Page.navigatedWithinDocument') void this.sendPage()
  }

  private async sendPage(): Promise<void> {
    try {
      const h = (await this.call('Page.getNavigationHistory')) as { currentIndex: number; entries: { url: string; title: string }[] }
      const entry = h.entries[h.currentIndex]
      if (!entry || !this.tab) return
      this.tab = { id: this.tab.id, url: entry.url, title: entry.title }
      this.out({ type: 'page', tab: this.tab, canGoBack: h.currentIndex > 0, canGoForward: h.currentIndex < h.entries.length - 1 })
    } catch {
      // floor-ok: a page that is going away answers on the next poll
    }
  }

  /** A burst of target events (a new tab fires several) becomes one look at the tab list. */
  private watchSoon(): void {
    if (this.soon || this.ended) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.watch()
    }, 100)
  }

  /** On target events and every 5 s: tabs that appeared or went, a title that changed, or a browser that is gone. */
  private async watch(): Promise<void> {
    if (this.ended) return
    let tabs: BrowserTab[]
    try {
      tabs = await pageTabs(this.port)
    } catch {
      return this.end('the browser was closed')
    }
    if (this.scope) tabs = this.scope.visible(tabs)
    if (this.ended) return
    const snapshot = JSON.stringify(tabs)
    const mine = tabs.find((t) => t.id === this.tab?.id)
    if (!mine) {
      if (this.bound) return this.end('that page was closed')
      const next = this.scope ? this.scope.best(tabs) : tabs[0]
      if (!next) return this.end('the browser has no page left')
      try {
        await this.attach(next)
      } catch {
        return this.end('the browser has no page left')
      }
    } else if (this.tab && (mine.title !== this.tab.title || mine.url !== this.tab.url)) {
      void this.sendPage()
    }
    if (snapshot !== this.lastTabs) {
      this.lastTabs = snapshot
      this.out({ type: 'tabs', tabs })
    }
  }

  private end(reason: string): void {
    if (this.ended) return
    this.ended = true
    this.out({ type: 'closed', reason })
    this.close()
    this.onEnd()
  }

  close(): void {
    this.ended = true
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (this.soon) clearTimeout(this.soon)
    this.soon = null
    this.epoch++
    // Give the page its own size back before the socket goes (best effort, sent raw: call() needs the session alive).
    if (this.size && this.cdp?.readyState === WebSocket.OPEN) {
      try {
        this.cdp.send(JSON.stringify({ id: this.nextId++, method: 'Emulation.clearDeviceMetricsOverride', params: {} }))
      } catch {
        // floor-ok: the socket is already going
      }
      const ws = this.cdp
      this.cdp = null
      setTimeout(() => {
        ws.onmessage = null
        ws.onclose = null
        try {
          ws.close()
        } catch {
          // floor-ok: already closed
        }
      }, 100)
    }
    this.detach()
    this.frame = null
    const mine = liveSessions.get(this.port)
    mine?.delete(this)
    if (mine?.size === 0) liveSessions.delete(this.port)
    liveChanged(this.port)
  }

  /** One message from the page. Anything malformed is dropped. */
  async input(msg: BrowserLiveIn): Promise<void> {
    if (this.ended) return
    // Remembered even while attaching, so the first size is not lost to a page that is not connected yet.
    if (msg.type === 'viewport') {
      this.size = { width: msg.width, height: msg.height }
      this.dpr = msg.devicePixelRatio ?? 1
    }
    if (!this.cdp) return
    switch (msg.type) {
      case 'mouse':
        await this.call('Input.dispatchMouseEvent', {
          type: MOUSE_TYPES[msg.event],
          x: msg.x,
          y: msg.y,
          button: msg.button,
          clickCount: msg.clickCount,
          modifiers: msg.modifiers,
        })
        return
      case 'wheel':
        await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.deltaX, deltaY: msg.deltaY })
        return
      case 'key':
        return this.key(msg)
      case 'text':
        await this.call('Input.insertText', { text: msg.text })
        return
      case 'copy': {
        const r = (await this.call('Runtime.evaluate', { expression: READ_SELECTION(msg.cut), returnByValue: true })) as { result?: { value?: unknown } }
        const text = r.result?.value
        this.out({ type: 'clipboard', text: typeof text === 'string' ? text : '' })
        return
      }
      case 'navigate':
        return this.navigate(msg.url)
      case 'history':
        return this.history(msg.go)
      case 'viewport': {
        await this.applySize(this.size!)
        await this.call('Page.stopScreencast')
        await this.startScreencast()
        return
      }
      case 'tab':
        return this.switchTab(msg.id)
    }
  }

  private async key(msg: Extract<BrowserLiveIn, { type: 'key' }>): Promise<void> {
    const text = msg.text ?? (msg.key === 'Enter' ? '\r' : undefined)
    await this.call('Input.dispatchKeyEvent', {
      type: msg.event === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key: msg.key,
      code: msg.code,
      modifiers: msg.modifiers,
      windowsVirtualKeyCode: virtualKeyCode(msg.key),
      ...(msg.event === 'down' && editCommands(msg.key, msg.modifiers) ? { commands: editCommands(msg.key, msg.modifiers) } : {}),
      ...(msg.event === 'down' && text ? { text } : {}),
    })
  }

  private async navigate(raw: string): Promise<void> {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    await this.call('Page.navigate', { url: url.href })
  }

  private async history(go: 'back' | 'forward' | 'reload'): Promise<void> {
    if (go === 'reload') {
      await this.call('Page.reload')
      return
    }
    const h = (await this.call('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number }[] }
    const to = h.entries[h.currentIndex + (go === 'back' ? -1 : 1)]
    if (to) await this.call('Page.navigateToHistoryEntry', { entryId: to.id })
  }

  private async switchTab(id: string): Promise<void> {
    const all = await pageTabs(this.port)
    const target = (this.scope ? this.scope.visible(all) : all).find((t) => t.id === id)
    if (!target) return
    await fetch(`http://${HOST}:${this.port}/json/activate/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(1500) }).catch(() => {
      // floor-ok: a page that cannot be raised is still shown
    })
    await this.attach(target)
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

type Fields = Record<string, unknown>

function parseMouse(m: Fields): BrowserLiveIn | null {
  if (
    (m.event === 'down' || m.event === 'up' || m.event === 'move') &&
    isNum(m.x) &&
    isNum(m.y) &&
    (m.button === 'left' || m.button === 'middle' || m.button === 'right' || m.button === 'none') &&
    isNum(m.clickCount) &&
    isNum(m.modifiers)
  )
    return { type: 'mouse', event: m.event, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount, modifiers: m.modifiers }
  return null
}

function parseKey(m: Fields): BrowserLiveIn | null {
  if ((m.event === 'down' || m.event === 'up') && typeof m.key === 'string' && typeof m.code === 'string' && isNum(m.modifiers))
    return { type: 'key', event: m.event, key: m.key, code: m.code, modifiers: m.modifiers, ...(typeof m.text === 'string' ? { text: m.text } : {}) }
  return null
}

const clampSize = (n: number): number => Math.min(4000, Math.max(200, Math.round(n)))

/** The pane's device pixel ratio, kept to 1..3 so a page cannot ask for an oversized screencast. */
export const clampDpr = (n: number): number => Math.min(3, Math.max(1, n))

/** The screencast's size cap: the page's CSS size times the pane's ratio, which is the canvas's real pixel size. */
export function screencastCap(size: { width: number; height: number }, dpr: number): { maxWidth: number; maxHeight: number } {
  return { maxWidth: Math.round(size.width * dpr), maxHeight: Math.round(size.height * dpr) }
}

/** One checker per message type; a type not named here is dropped. */
const LIVE_IN: Record<string, (m: Fields) => BrowserLiveIn | null> = {
  mouse: parseMouse,
  wheel: (m) => (isNum(m.x) && isNum(m.y) && isNum(m.deltaX) && isNum(m.deltaY) ? { type: 'wheel', x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY } : null),
  key: parseKey,
  text: (m) => (typeof m.text === 'string' ? { type: 'text', text: m.text } : null),
  copy: (m) => ({ type: 'copy', cut: m.cut === true }),
  navigate: (m) => (typeof m.url === 'string' ? { type: 'navigate', url: m.url } : null),
  history: (m) => (m.go === 'back' || m.go === 'forward' || m.go === 'reload' ? { type: 'history', go: m.go } : null),
  tab: (m) => (typeof m.id === 'string' ? { type: 'tab', id: m.id } : null),
  viewport: (m) => {
    if (!isNum(m.width) || !isNum(m.height)) return null
    const ratio = isNum(m.devicePixelRatio) ? { devicePixelRatio: clampDpr(m.devicePixelRatio) } : {}
    return { type: 'viewport', width: clampSize(m.width), height: clampSize(m.height), ...ratio }
  },
}

/** A message from the page checked field by field (it is JSON from a socket, not trusted to be a BrowserLiveIn). */
export function parseLiveIn(raw: string): BrowserLiveIn | null {
  let m: Fields
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    m = parsed as Fields
  } catch {
    return null
  }
  const parse = typeof m.type === 'string' && Object.hasOwn(LIVE_IN, m.type) ? LIVE_IN[m.type] : undefined
  return parse ? parse(m) : null
}
