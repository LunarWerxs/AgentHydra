// Chrome's DevTools protocol, as far as the browser pane needs it: is a profile's Chrome running, its pages, starting
// one, and one live view of a page. The host is always 127.0.0.1 and the port only ever comes from a profile folder's
// DevToolsActivePort (written by a Chrome started with --remote-debugging-port=0); nothing a request says names one.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserLiveIn, BrowserLiveOut, BrowserTab } from '@shared/browser'

const HOST = '127.0.0.1'

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

async function doLaunch(dir: string, url: string | undefined, login: boolean): Promise<number | null> {
  const chrome = findChrome()
  if (!chrome) throw new LaunchError('Chrome is not installed (looked in its standard install folders)')
  rmSync(join(dir, 'DevToolsActivePort'), { force: true }) // a stale file must not point at a Chrome that is gone
  const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check']
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

const MOUSE_TYPES = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' } as const

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

/** One page of a profile's Chrome, shown live: frames and page changes out, input in. */
export class LiveSession {
  private cdp: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private tab: BrowserTab | null = null
  private lastTabs = ''
  private poll: ReturnType<typeof setInterval> | null = null
  private ended = false
  /** Bumped by every attach, so events of a socket that was replaced are dropped. */
  private epoch = 0

  constructor(
    private readonly port: number,
    private readonly out: (msg: BrowserLiveOut) => void,
    private readonly onEnd: () => void,
  ) {}

  /** The page target to show: the asked-for tab, else the first page. Null when the Chrome has no such page. */
  static async pick(port: number, tab: string | null): Promise<BrowserTab | null> {
    const tabs = await pageTabs(port)
    return (tab ? tabs.find((t) => t.id === tab) : tabs[0]) ?? null
  }

  async start(tab: BrowserTab): Promise<void> {
    await this.attach(tab)
    this.poll = setInterval(() => void this.watch(), 1000)
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
    await this.call('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
    await this.sendPage()
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
        this.out({ type: 'frame', data: msg.params.data, width: Math.round(meta.deviceWidth ?? 0), height: Math.round(meta.deviceHeight ?? 0) })
      }
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

  /** Every second: tabs that appeared or went, a title that changed, or a browser that is gone. */
  private async watch(): Promise<void> {
    if (this.ended) return
    let tabs: BrowserTab[]
    try {
      tabs = await pageTabs(this.port)
    } catch {
      return this.end('the browser was closed')
    }
    if (this.ended) return
    const snapshot = JSON.stringify(tabs)
    const mine = tabs.find((t) => t.id === this.tab?.id)
    if (!mine) {
      const next = tabs[0]
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
    this.epoch++
    this.detach()
  }

  /** One message from the page. Anything malformed is dropped. */
  async input(msg: BrowserLiveIn): Promise<void> {
    if (this.ended || !this.cdp) return
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
      case 'key': {
        const text = msg.text ?? (msg.key === 'Enter' ? '\r' : undefined)
        await this.call('Input.dispatchKeyEvent', {
          type: msg.event === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
          key: msg.key,
          code: msg.code,
          modifiers: msg.modifiers,
          windowsVirtualKeyCode: virtualKeyCode(msg.key),
          ...(msg.event === 'down' && text ? { text } : {}),
        })
        return
      }
      case 'text':
        await this.call('Input.insertText', { text: msg.text })
        return
      case 'navigate': {
        let url: URL
        try {
          url = new URL(msg.url)
        } catch {
          return
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return
        await this.call('Page.navigate', { url: url.href })
        return
      }
      case 'history': {
        if (msg.go === 'reload') {
          await this.call('Page.reload')
          return
        }
        const h = (await this.call('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number }[] }
        const to = h.entries[h.currentIndex + (msg.go === 'back' ? -1 : 1)]
        if (to) await this.call('Page.navigateToHistoryEntry', { entryId: to.id })
        return
      }
      case 'tab': {
        const target = await LiveSession.pick(this.port, msg.id)
        if (!target) return
        await fetch(`http://${HOST}:${this.port}/json/activate/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(1500) }).catch(() => {
          // floor-ok: a page that cannot be raised is still shown
        })
        await this.attach(target)
        return
      }
    }
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A message from the page checked field by field (it is JSON from a socket, not trusted to be a BrowserLiveIn). */
export function parseLiveIn(raw: string): BrowserLiveIn | null {
  let m: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    m = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (m.type) {
    case 'mouse':
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
    case 'wheel':
      return isNum(m.x) && isNum(m.y) && isNum(m.deltaX) && isNum(m.deltaY) ? { type: 'wheel', x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY } : null
    case 'key':
      if ((m.event === 'down' || m.event === 'up') && typeof m.key === 'string' && typeof m.code === 'string' && isNum(m.modifiers))
        return { type: 'key', event: m.event, key: m.key, code: m.code, modifiers: m.modifiers, ...(typeof m.text === 'string' ? { text: m.text } : {}) }
      return null
    case 'text':
      return typeof m.text === 'string' ? { type: 'text', text: m.text } : null
    case 'navigate':
      return typeof m.url === 'string' ? { type: 'navigate', url: m.url } : null
    case 'history':
      return m.go === 'back' || m.go === 'forward' || m.go === 'reload' ? { type: 'history', go: m.go } : null
    case 'tab':
      return typeof m.id === 'string' ? { type: 'tab', id: m.id } : null
    default:
      return null
  }
}
