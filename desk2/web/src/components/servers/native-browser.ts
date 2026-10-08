// A page tab's own browser. Inside AgentHydra's window (launcher/host, WebView2) a page tab shows its address in a
// browser view of the window's own, placed over the tab, not in an iframe: most sites with a sign-in refuse to be framed
// (X-Frame-Options, CSP frame-ancestors) and a frame of one shows only a no-entry picture. The host says it can with
// `window.agentHydraHost.browser`; launcher/host/src/main.rs (BrowserCmd, PageOut) is the other end of every message
// here. In a plain browser there is no host and the tab keeps its iframe.

/** A box in physical pixels of the window's client area: the page's CSS pixels times devicePixelRatio. */
export interface HostRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Page -> host (BrowserCmd). A view is made by its first open; `rect: null` keeps it hidden. */
export type HostBrowserIn =
  | { kind: 'browser'; op: 'open'; id: string; url: string; rect: HostRect | null }
  | { kind: 'browser'; op: 'place'; id: string; rect: HostRect | null }
  | { kind: 'browser'; op: 'back' | 'forward' | 'reload' | 'close'; id: string }
  | { kind: 'browser'; op: 'mute'; id: string; muted: boolean }

/** Host -> page (PageOut): the detail of an `agenthydra:browser` window event. */
export type HostBrowserOut =
  | { id: string; type: 'url'; url: string; loading: boolean }
  | { id: string; type: 'title'; title: string; url: string }
  | { id: string; type: 'audio'; playing: boolean; muted: boolean }

export const HOST_BROWSER_EVENT = 'agenthydra:browser'

type HostWindow = { agentHydraHost?: { browser?: number; audio?: number }; ipc?: { postMessage(text: string): void } }

/** True inside AgentHydra's own window, whose host can show a page tab in a view of its own. */
export function hasHostBrowser(w: unknown = globalThis): boolean {
  const h = w as HostWindow
  return h.agentHydraHost?.browser === 1 && typeof h.ipc?.postMessage === 'function'
}

/** True when the host also reports a view's sound and can mute it (`audio`); an older host cannot. */
export function hasHostAudio(w: unknown = globalThis): boolean {
  return hasHostBrowser(w) && (w as HostWindow).agentHydraHost?.audio === 1
}

/** The host's box for one the page measured, in whole pixels; null when it has no area (a hidden tab). */
export function hostRect(box: { left: number; top: number; width: number; height: number }, scale: number): HostRect | null {
  if (!(box.width >= 1 && box.height >= 1)) return null
  return {
    left: Math.round(box.left * scale),
    top: Math.round(box.top * scale),
    right: Math.round((box.left + box.width) * scale),
    bottom: Math.round((box.top + box.height) * scale),
  }
}

type Box = { left: number; top: number; right: number; bottom: number }

/** True when two boxes share some area. */
export const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const sameRect = (a: HostRect | null, b: HostRect | null): boolean =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom)

// Menus, popovers, dialogs and lists are drawn by the page, so under the host's view: one over the tab hides the view while
// it is open. A tooltip stays under it (hiding the page for a hover would make it blink).
const OVERLAYS = '[data-reka-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** True while the page draws something over `slot` (the tab's box, measured as `box`): an open menu, popover or dialog
 *  over it, or anything covering its middle, such as a full-window viewer. */
export function coveredByPage(slot: Element, box: Box & { width: number; height: number }, doc: Document = document): boolean {
  for (const el of doc.querySelectorAll(OVERLAYS)) {
    if (slot.contains(el) || el.contains(slot)) continue
    if (el.matches('[data-reka-popper-content-wrapper]') && el.querySelector('[role="tooltip"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && overlaps(r, box)) return true
  }
  const middle = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return !!middle && !slot.contains(middle)
}

const listeners = new Map<string, (e: HostBrowserOut) => void>()
let listening = false

/** Hands a host event to the view it names; the window listener's body. */
export function deliverHostEvent(detail: unknown) {
  const d = detail as HostBrowserOut | null
  if (d && typeof d.id === 'string') listeners.get(d.id)?.(d)
}

const onHostEvent = (e: Event) => deliverHostEvent((e as CustomEvent).detail)

function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener(HOST_BROWSER_EVENT, onHostEvent)
}

/** The window listener goes with the last view. */
function unlisten() {
  if (!listening || listeners.size > 0) return
  listening = false
  window.removeEventListener(HOST_BROWSER_EVENT, onHostEvent)
}

const post = (msg: HostBrowserIn) => (globalThis as HostWindow).ipc?.postMessage(JSON.stringify(msg))

let seq = 0

/** One page tab's view in the host: made by its first open, moved by place (sent only when its box changed), gone at close. */
export class HostView {
  readonly id = `page-${++seq}-${Date.now().toString(36)}`
  private rect: HostRect | null = null
  private opened = false
  private muted = false

  constructor(
    onEvent: (e: HostBrowserOut) => void,
    private readonly send: (msg: HostBrowserIn) => void = post,
    private readonly audio: boolean = hasHostAudio()
  ) {
    listeners.set(this.id, onEvent)
    listen()
  }

  /** A page tab takes the view over (it was kept in the background): its events go to the new handler. */
  listen(onEvent: (e: HostBrowserOut) => void) {
    listeners.set(this.id, onEvent)
    listen()
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(url: string, rect: HostRect | null) {
    this.opened = true
    this.rect = rect
    this.send({ kind: 'browser', op: 'open', id: this.id, url, rect })
    if (this.muted && this.audio) this.send({ kind: 'browser', op: 'mute', id: this.id, muted: true })
  }

  /** Mutes or unmutes the view's sound (kept for a view not open yet, muted as it opens); nothing is sent to a host without `audio`. */
  mute(muted: boolean) {
    this.muted = muted
    if (this.opened && this.audio) this.send({ kind: 'browser', op: 'mute', id: this.id, muted })
  }

  place(rect: HostRect | null) {
    if (!this.opened || sameRect(rect, this.rect)) return
    this.rect = rect
    this.send({ kind: 'browser', op: 'place', id: this.id, rect })
  }

  act(op: 'back' | 'forward' | 'reload') {
    if (this.opened) this.send({ kind: 'browser', op, id: this.id })
  }

  close() {
    listeners.delete(this.id)
    unlisten()
    if (this.opened) this.send({ kind: 'browser', op: 'close', id: this.id })
    this.opened = false
  }
}
