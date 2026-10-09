// The window draws its own title bar (owner, 2026-10-08, pointing at the empty strip left of Windows' minimize button:
// "move these icons, here"). AgentHydra's native host (launcher/host, `agentHydraHost.frame`) takes Windows' caption off
// once the page says it is ready, so the page's top row is the title bar: its empty parts drag the window (`title-drag`
// in style.css, WebView2's `app-region`), and WindowControls draws minimize, maximize and close at its right end. The
// host answers every `ready`, and every maximize or restore after it, with an `agenthydra:window` event. In a browser
// tab, or a host that kept its caption (a WebView2 runtime too old for drag regions), nothing here changes the page.
import { ref } from 'vue'

interface Host {
  agentHydraHost?: { frame?: number }
  ipc?: { postMessage(message: string): void }
}

/** Set on the root while the page draws the title bar: style.css's drag areas apply under it. */
export const OWN_FRAME_CLASS = 'own-frame'
/** The three window buttons' width (WindowControls: 46 each), which the title row keeps clear at its right end; the
 *  root's `--caption-w` while the page draws the title bar, 0 otherwise. */
export const CAPTION_W = 138

/** Windows' caption is off: the page draws the window's buttons. */
export const ownFrame = ref(false)
/** The window is maximized (Restore shows in place of Maximize, and the top edge does not resize). */
export const maximized = ref(false)

export type CaptionButton = 'minimize' | 'maximize' | 'close'
/** The window button under the pointer and the one held down, as the host says: over the buttons the pointer is the
 *  host's (its caption sink, which lets Windows 11 show snap layouts over Maximize), so the page's own hover never fires. */
export const captionHover = ref<CaptionButton | null>(null)
export const captionPressed = ref<CaptionButton | null>(null)

const host = (): Host => (typeof window === 'undefined' ? {} : (window as unknown as Host))
const send = (action: string, extra: Record<string, unknown> = {}) => host().ipc?.postMessage(JSON.stringify({ op: 'window', action, ...extra }))

export const minimizeWindow = () => send('minimize')
/** Maximize, or restore when maximized. */
export const toggleMaximize = () => send('maximize')
/** What Windows' X did: the host saves where the window was and closes it. */
export const closeWindow = () => send('close')
/** Starts the host's own resize drag from the top edge or a top corner; the button must still be down. */
export const resizeFrom = (edge: 'n' | 'ne' | 'nw') => send('resize', { edge })
/** Starts the window's move, as a press on Windows' caption does; the button must still be down. For a title bar the
 *  page's drag regions cannot cover (the AgentHydra pane's frame: WebView2 takes them from the top document only). */
export const dragWindow = () => send('drag')
/** Tells the host where the window's buttons are (`r`, the page's pixels; null while there are none), so its caption
 *  sink goes over exactly them and nowhere else. The host works in the screen's pixels. */
export function placeButtons(r: { left: number; top: number; width: number; height: number } | null): void {
  if (!r) {
    // No sink, so no word from it either: nothing stays drawn hovered or pressed.
    captionHover.value = captionPressed.value = null
    return void send('buttons')
  }
  const px = (v: number) => Math.round(v * window.devicePixelRatio)
  send('buttons', { rect: [px(r.left), px(r.top), px(r.width), px(r.height)] })
}

let started = false
/** Asks the host for its frame; call once the page can draw the title bar. */
export function startOwnFrame(): void {
  const h = host()
  if (started || !h.agentHydraHost?.frame || !h.ipc) return
  started = true
  window.addEventListener('agenthydra:window', (e) => {
    const d = (e as CustomEvent<{ frame?: boolean; maximized?: boolean }>).detail
    ownFrame.value = d?.frame === true
    maximized.value = d?.maximized === true
    document.documentElement.classList.toggle(OWN_FRAME_CLASS, ownFrame.value)
    document.documentElement.style.setProperty('--caption-w', `${ownFrame.value ? CAPTION_W : 0}px`)
  })
  window.addEventListener('agenthydra:caption', (e) => {
    const d = (e as CustomEvent<{ hover?: CaptionButton | null; pressed?: CaptionButton | null }>).detail
    captionHover.value = d?.hover ?? null
    captionPressed.value = d?.pressed ?? null
  })
  send('ready')
}
