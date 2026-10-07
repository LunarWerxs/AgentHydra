// The live preview of a Browser card: a low-fps stream of the profile's page (server/src/browser/preview.ts), or, when
// that fails, one small JPEG fetched every few seconds; either way by the newest on-screen card of that profile only. The open/closed answer is one shared, briefly cached read of the saved browsers.
import { BROWSER_PREVIEW, BROWSER_PREVIEW_STREAM, BROWSER_PROFILES, type BrowserPreviewOut, type BrowserProfile, type BrowserProfiles } from '@shared/browser'

export const PREVIEW_EVERY_MS = 3000

const known = new Map<string, { at: number; list: Promise<BrowserProfile[] | null> }>()

/** The chat folder's saved browsers, or null when the read failed; shared by every card for a few seconds. */
export function savedProfiles(cwd: string, now = Date.now()): Promise<BrowserProfile[] | null> {
  const hit = known.get(cwd)
  if (hit && now - hit.at < PREVIEW_EVERY_MS - 500) return hit.list
  const list = fetch(`${BROWSER_PROFILES}?${new URLSearchParams({ cwd })}`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? (r.json() as Promise<BrowserProfiles>) : Promise.reject(new Error(String(r.status)))))
    .then((p) => p.profiles)
    .catch(() => null)
  known.set(cwd, { at: now, list })
  return list
}

/** The names of the chat folder's browsers that run now (own ones only), or null when the read failed (unknown, not closed). */
export async function openProfiles(cwd: string, now = Date.now()): Promise<Set<string> | null> {
  const list = await savedProfiles(cwd, now)
  return list && new Set(list.filter((x) => x.open && x.own).map((x) => x.name))
}

/** Forgets the cached read of a folder's browsers (the pane just closed one), so the next look sees the truth. */
export function forgetProfiles(cwd: string): void {
  known.delete(cwd)
}

/**
 * Whether a picture is one flat colour: a blank page (about:blank, which Chrome paints #121212 when Windows is in dark
 * mode: the "black" live card of 2026-10-06) or one not painted yet. Sampled on a small canvas; false where none exists.
 */
export async function isBlankPicture(src: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return false
    g.drawImage(img, 0, 0, 16, 16)
    return isBlankPixels(g.getImageData(0, 0, 16, 16).data)
  } catch {
    return false
  }
}

/** RGBA samples of one flat colour: no channel more than 6 from the first pixel's (a page with anything on it differs somewhere). */
export function isBlankPixels(rgba: ArrayLike<number>): boolean {
  if (rgba.length < 4) return false
  for (let i = 4; i + 2 < rgba.length; i += 4) for (let c = 0; c < 3; c++) if (Math.abs(rgba[i + c] - rgba[c]) > 6) return false
  return true
}

/** The next frame of the profile as an object URL, loaded and decoded so showing it never flashes blank; null when the browser is not open. */
export async function nextFrame(cwd: string, profile: string, chat?: string): Promise<string | null> {
  const res = await fetch(`${BROWSER_PREVIEW}?${new URLSearchParams({ cwd, profile, ...(chat ? { chat } : {}) })}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
  if (!res.ok) return null
  const url = URL.createObjectURL(await res.blob())
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  return url
}

/** BROWSER_PREVIEW_STREAM's address for a page at `loc`. */
export function previewStreamUrl(loc: { protocol: string; host: string }, cwd: string, profile: string, chat?: string): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${BROWSER_PREVIEW_STREAM}?${new URLSearchParams({ cwd, profile, ...(chat ? { chat } : {}) })}`
}

/** Whether a card should be fed: the newest card of an open, named profile that is on screen in a visible window. */
export function previewWanted(s: { named: boolean; newest: boolean; onScreen: boolean; visible: boolean; hasCwd: boolean }): boolean {
  return s.named && s.newest && s.onScreen && s.visible && s.hasCwd
}

/** Opens the card's stream; frames come as `data:` addresses, onEnd fires once when it closes, fails or says closed. Returns the closer. */
export function openPreviewStream(cwd: string, profile: string, onFrame: (src: string) => void, onEnd: () => void, chat?: string): () => void {
  let done = false
  const ws = new WebSocket(previewStreamUrl(location, cwd, profile, chat))
  const end = (): void => {
    if (done) return
    done = true
    onEnd()
  }
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as BrowserPreviewOut
      if (m.type === 'frame') onFrame(`data:image/jpeg;base64,${m.data}`)
      else end()
    } catch {
      // floor-ok: not a message of ours
    }
  }
  ws.onclose = end
  ws.onerror = end
  return () => {
    done = true
    ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close()
    } catch {
      // floor-ok: already closed
    }
  }
}

export interface PreviewFeedDeps {
  openStream(onFrame: (src: string) => void, onEnd: () => void): () => void
  /** One still, as the 3 s poll fetches it; resolves when it is shown. */
  poll(): Promise<void>
}

/**
 * What feeds a card that is wanted: its stream while that works; else the 3 s poll, with the stream tried again every
 * `retryMs`. The picture on screen is never cleared here, so a failed stream keeps the last frame until a poll replaces it.
 */
export class PreviewFeed {
  private on = false
  private close: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: PreviewFeedDeps,
    private readonly onFrame: (src: string) => void,
    private readonly opts: { pollMs?: number; retryMs?: number; firstFrameMs?: number } = {},
  ) {}

  /** True while a stream is open. */
  get streaming(): boolean {
    return this.close !== null
  }

  setWanted(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.teardown()
    if (on) this.connect()
  }

  private connect(): void {
    this.close = this.deps.openStream(
      (src) => {
        if (this.waitTimer) clearTimeout(this.waitTimer)
        this.waitTimer = null
        if (this.on) this.onFrame(src)
      },
      () => this.fallBack(),
    )
    this.waitTimer = setTimeout(() => this.fallBack(), this.opts.firstFrameMs ?? 4000)
  }

  private fallBack(): void {
    if (!this.on) return
    this.teardown()
    void this.deps.poll()
    this.pollTimer = setInterval(() => void this.deps.poll(), this.opts.pollMs ?? PREVIEW_EVERY_MS)
    this.retryTimer = setTimeout(() => {
      this.teardown()
      if (this.on) this.connect()
    }, this.opts.retryMs ?? 15_000)
  }

  private teardown(): void {
    this.close?.()
    this.close = null
    for (const t of [this.waitTimer, this.retryTimer]) if (t) clearTimeout(t)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.waitTimer = this.retryTimer = this.pollTimer = null
  }
}
