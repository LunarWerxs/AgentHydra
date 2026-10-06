// Holds every CSS animation still while nobody can see the window: unfocused, hidden or minimized. An
// infinite animation (spinner, pulse, ping) otherwise keeps the compositor, and the GPU process, producing
// frames all day for nobody. The rule is in style.css under `html.motion-paused`; it resumes where it stopped.
// Same idea as Desk 2's own lib/pause-motion.ts.

/** The root class `style.css` pauses animations under. */
export const PAUSED_CLASS = 'motion-paused'

interface Win {
  addEventListener(type: 'focus' | 'blur', fn: () => void): void
  /** The top-level window; the same window when this page is not framed. */
  top?: Win | null
}
interface Doc {
  visibilityState: string
  hidden?: boolean
  hasFocus(): boolean
  documentElement: { classList: { toggle(name: string, on: boolean): unknown } }
  addEventListener(type: 'visibilitychange', fn: () => void): void
}

/** Whether the page should hold still. `hasFocus()` is true while focus sits in a frame of the page. In a
 *  frame, `top` is the page the user sees: its focus counts (the frame itself is rarely the focused one)
 *  and `hidden` already says whether the top-level page is hidden or minimized. */
export const motionPaused = (
  doc: Pick<Doc, 'visibilityState' | 'hidden' | 'hasFocus'>,
  topDoc: Pick<Doc, 'hasFocus'> = doc,
): boolean => doc.visibilityState === 'hidden' || doc.hidden === true || !topDoc.hasFocus()

/** The top page's document when it is reachable (same origin), else this one. */
function topDocument(win: Win, doc: Doc): Pick<Doc, 'hasFocus'> {
  try {
    const top = win.top as unknown as { document?: Pick<Doc, 'hasFocus'> } | null | undefined
    return top?.document ?? doc
  } catch {
    return doc
  }
}

/** Keeps the root class in step with focus and visibility; call once at startup. */
export function pauseMotionWhenAway(win: Win = window, doc: Doc = document): void {
  const sync = () =>
    void doc.documentElement.classList.toggle(
      PAUSED_CLASS,
      motionPaused(doc, topDocument(win, doc)),
    )
  win.addEventListener('focus', sync)
  win.addEventListener('blur', sync)
  try {
    if (win.top && win.top !== win) {
      win.top.addEventListener('focus', sync)
      win.top.addEventListener('blur', sync)
    }
  } catch {
    /* cross-origin top: only this frame's own focus and visibility count */
  }
  doc.addEventListener('visibilitychange', sync)
  sync()
}
