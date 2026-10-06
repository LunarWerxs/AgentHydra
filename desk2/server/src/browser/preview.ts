// The transcript Browser card's low-fps stream (contract: shared/browser.ts, BROWSER_PREVIEW_STREAM). One PreviewHub
// keeps, per Chrome port, the cards watching it and ONE source of frames: the pane's live session when it shows a page
// of that Chrome (its frames are tapped, no second screencast), else a small screencast of the hub's own that runs only
// while someone watches. Frames reach a card at most `minIntervalMs` apart (the newest wins) and are held back while
// its socket is backed up. Nothing is ever forwarded from a card to the page.

import { hasLiveSession, liveFrameSized, onLiveChange, pageTabs, tapLiveFrames, type TappedFrame } from './cdp'

const HOST = '127.0.0.1'

export interface PreviewSink {
  send(frame: TappedFrame): void
  closed(reason: string): void
  /** True while the card's socket has too much unsent data: frames wait (the newest only) instead of piling up. */
  backed(): boolean
}

export interface Cast {
  stop(): void
}
export type CastFactory = (port: number, onFrame: (f: TappedFrame) => void, onEnd: (reason: string) => void) => Cast

/** A small screencast of the first page of a Chrome, over its own CDP socket; follows the page when its tab goes. */
export class PreviewCast implements Cast {
  private ws: WebSocket | null = null
  private nextId = 1
  private tabId: string | null = null
  private epoch = 0
  private poll: ReturnType<typeof setInterval> | null = null
  private ended = false

  constructor(
    private readonly port: number,
    private readonly onFrame: (f: TappedFrame) => void,
    private readonly onEnd: (reason: string) => void,
  ) {
    void this.begin()
  }

  private async begin(): Promise<void> {
    try {
      const tab = (await pageTabs(this.port))[0]
      if (!tab) return this.end('the browser has no page')
      await this.attach(tab.id)
      if (this.ended) return
      this.poll = setInterval(() => void this.watch(), 2000)
    } catch {
      this.end('the page could not be shown')
    }
  }

  private async attach(tabId: string): Promise<void> {
    const epoch = ++this.epoch
    this.drop()
    this.tabId = tabId
    // The URL is built from the id, as LiveSession does; a target's own webSocketDebuggerUrl is never followed.
    const ws = new WebSocket(`ws://${HOST}:${this.port}/devtools/page/${encodeURIComponent(tabId)}`)
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('the page did not accept a connection'))
      setTimeout(() => rej(new Error('the page did not answer in time')), 8000)
    })
    if (this.ended || epoch !== this.epoch) {
      ws.close()
      return
    }
    this.ws = ws
    ws.onmessage = (ev) => {
      if (epoch !== this.epoch) return
      let m: { method?: string; params?: { sessionId?: number; data?: unknown; metadata?: { deviceWidth?: number; deviceHeight?: number } } }
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (m.method !== 'Page.screencastFrame' || !m.params) return
      this.send('Page.screencastFrameAck', { sessionId: m.params.sessionId })
      if (typeof m.params.data === 'string')
        this.onFrame({ data: m.params.data, width: Math.round(m.params.metadata?.deviceWidth ?? 0), height: Math.round(m.params.metadata?.deviceHeight ?? 0) })
    }
    ws.onclose = () => {
      if (epoch === this.epoch && !this.ended) void this.watch()
    }
    this.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 640, maxHeight: 640, everyNthFrame: 2 })
  }

  private send(method: string, params: Record<string, unknown> = {}): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id: this.nextId++, method, params }))
    } catch {
      // floor-ok: a socket going away is seen by the next watch
    }
  }

  private drop(): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onmessage = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // floor-ok: already closed
    }
  }

  /** Every 2 s: the browser gone ends the cast; the page gone moves it to the first page left. */
  private async watch(): Promise<void> {
    if (this.ended) return
    let tabs: { id: string }[]
    try {
      tabs = await pageTabs(this.port)
    } catch {
      return this.end('the browser was closed')
    }
    if (this.ended) return
    if (tabs.some((t) => t.id === this.tabId) && this.ws?.readyState === WebSocket.OPEN) return
    const next = tabs.find((t) => t.id === this.tabId) ?? tabs[0]
    if (!next) return this.end('the browser has no page left')
    try {
      await this.attach(next.id)
    } catch {
      this.end('the browser has no page left')
    }
  }

  private end(reason: string): void {
    if (this.ended) return
    this.stop()
    this.onEnd(reason)
  }

  stop(): void {
    this.ended = true
    this.epoch++
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.send('Page.stopScreencast')
    const ws = this.ws
    this.ws = null
    if (ws) {
      // Let the stop reach the page before the socket goes.
      setTimeout(() => {
        ws.onmessage = null
        ws.onclose = null
        try {
          ws.close()
        } catch {
          // floor-ok: already closed
        }
      }, 50)
    }
  }
}

interface Sub {
  sink: PreviewSink
  /** When a frame last went to this card. */
  at: number
  pending: TappedFrame | null
  timer: ReturnType<typeof setTimeout> | null
}

interface Entry {
  subs: Set<Sub>
  cast: Cast | null
  untap: () => void
  last: TappedFrame | null
}

export interface HubOptions {
  /** The least time between two frames to one card; 200 is 5 fps. */
  minIntervalMs?: number
  now?: () => number
  castFactory?: CastFactory
}

export class PreviewHub {
  private readonly entries = new Map<number, Entry>()
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly castFactory: CastFactory
  private unwatch: (() => void) | null = null

  constructor(opts: HubOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200
    this.now = opts.now ?? Date.now
    this.castFactory = opts.castFactory ?? ((port, onFrame, onEnd) => new PreviewCast(port, onFrame, onEnd))
  }

  /** How many cards watch this Chrome. */
  count(port: number): number {
    return this.entries.get(port)?.subs.size ?? 0
  }

  /** Whether the hub's own screencast runs on this Chrome. */
  casting(port: number): boolean {
    return !!this.entries.get(port)?.cast
  }

  subscribe(port: number, sink: PreviewSink): () => void {
    let entry = this.entries.get(port)
    if (!entry) {
      const e: Entry = { subs: new Set(), cast: null, untap: () => {}, last: null }
      e.untap = tapLiveFrames(port, (f) => this.deliver(e, f))
      this.entries.set(port, e)
      entry = e
    }
    if (!this.unwatch) this.unwatch = onLiveChange((p) => this.reconcile(p))
    const sub: Sub = { sink, at: 0, pending: null, timer: null }
    entry.subs.add(sub)
    // A card that joins between frames gets the newest one at once.
    const first = entry.last ?? liveFrameSized(port)
    if (first) this.offer(sub, first)
    this.reconcile(port)
    return () => this.leave(port, sub)
  }

  private leave(port: number, sub: Sub): void {
    if (sub.timer) clearTimeout(sub.timer)
    sub.timer = null
    sub.pending = null
    const entry = this.entries.get(port)
    if (!entry?.subs.delete(sub)) return
    this.reconcile(port)
  }

  /** One screencast per Chrome at most: the pane's when it runs, else the hub's while anyone watches, else none. */
  private reconcile(port: number): void {
    const entry = this.entries.get(port)
    if (!entry) return
    if (entry.subs.size === 0) {
      entry.cast?.stop()
      entry.untap()
      this.entries.delete(port)
      if (this.entries.size === 0) {
        this.unwatch?.()
        this.unwatch = null
      }
      return
    }
    if (hasLiveSession(port)) {
      entry.cast?.stop()
      entry.cast = null
    } else if (!entry.cast) {
      const cast = this.castFactory(
        port,
        (f) => this.deliver(entry, f),
        (reason) => {
          if (entry.cast !== cast) return
          entry.cast = null
          this.end(port, reason)
        },
      )
      entry.cast = cast
    }
  }

  /** The source is gone: every card hears it and is dropped (the cards fall back to polling). */
  private end(port: number, reason: string): void {
    const entry = this.entries.get(port)
    if (!entry) return
    for (const sub of [...entry.subs]) {
      this.leave(port, sub)
      try {
        sub.sink.closed(reason)
      } catch {
        // floor-ok: a socket closing mid-send
      }
    }
  }

  private deliver(entry: Entry, f: TappedFrame): void {
    entry.last = f
    for (const sub of entry.subs) this.offer(sub, f)
  }

  /** Sends now when the card is due a frame and not backed up; otherwise keeps the newest and tries again when due. */
  private offer(sub: Sub, f: TappedFrame): void {
    sub.pending = f
    if (sub.timer) return
    const wait = sub.at + this.minIntervalMs - this.now()
    if (wait <= 0 && !sub.sink.backed()) return this.flush(sub)
    sub.timer = setTimeout(
      () => {
        sub.timer = null
        if (!sub.pending) return
        if (sub.sink.backed()) return this.offer(sub, sub.pending)
        this.flush(sub)
      },
      Math.max(wait, this.minIntervalMs / 2),
    )
  }

  private flush(sub: Sub): void {
    const f = sub.pending
    sub.pending = null
    if (!f) return
    sub.at = this.now()
    try {
      sub.sink.send(f)
    } catch {
      // floor-ok: a socket closing mid-send is dropped by its close handler
    }
  }
}

/** The one hub of this process. */
export const previewHub = new PreviewHub()
