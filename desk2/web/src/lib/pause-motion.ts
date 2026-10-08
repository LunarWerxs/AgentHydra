// Holds every CSS animation still while nobody can see the window: unfocused, hidden or minimized (the
// launcher tells the page it is hidden when minimized). An infinite animation otherwise keeps the compositor,
// and WebView2's GPU process, producing frames all day. The rule is in style.css under `html.motion-paused`.

/** The root class `style.css` pauses animations under. */
export const PAUSED_CLASS = 'motion-paused'
/** Set beside it while the window is hidden or minimized: what keeps moving unfocused (the working mark) stops too. */
export const HIDDEN_CLASS = 'motion-hidden'

interface Win {
  addEventListener(type: 'focus' | 'blur', fn: () => void): void
}
interface Doc {
  visibilityState: string
  hasFocus(): boolean
  documentElement: { classList: { toggle(name: string, on: boolean): unknown } }
  addEventListener(type: 'visibilitychange', fn: () => void): void
}

/** Whether the page should hold still. `hasFocus()` is true while focus sits in a frame of the page. */
export const motionPaused = (doc: Pick<Doc, 'visibilityState' | 'hasFocus'>): boolean => doc.visibilityState === 'hidden' || !doc.hasFocus()

/** Keeps the root class in step with focus and visibility; call once at startup. */
export function pauseMotionWhenAway(win: Win = window, doc: Doc = document): void {
  const sync = () => {
    doc.documentElement.classList.toggle(PAUSED_CLASS, motionPaused(doc))
    doc.documentElement.classList.toggle(HIDDEN_CLASS, doc.visibilityState === 'hidden')
  }
  win.addEventListener('focus', sync)
  win.addEventListener('blur', sync)
  doc.addEventListener('visibilitychange', sync)
  sync()
}
