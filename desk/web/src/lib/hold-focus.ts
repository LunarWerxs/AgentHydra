// Puts focus on an element and keeps it there for a moment. A closing menu hands focus back to its
// trigger only after its exit animation, frames after the click that closed it (and while it is still
// open its trap refuses the focus), so a one-shot focus is lost. While the hold lasts, focus landing
// anywhere else without the user pressing a key or a pointer is put back; any key or pointer press ends
// the hold, so a deliberate move is never undone.

interface Focusable extends EventTarget {
  focus(): void
  readonly isConnected: boolean
}

export function holdFocus(el: Focusable, doc: EventTarget, ms = 1000, later: (fn: () => void) => void = (fn) => requestAnimationFrame(fn)): () => void {
  let done = false
  const stop = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    doc.removeEventListener('focusin', onIn, true)
    doc.removeEventListener('pointerdown', stop, true)
    doc.removeEventListener('keydown', stop, true)
  }
  // The next frame: a closing menu's trap pulls focus straight back in it.
  const onIn = (e: Event) => e.target !== el && later(() => !done && el.isConnected && el.focus())
  const timer = setTimeout(stop, ms)
  doc.addEventListener('focusin', onIn, true)
  doc.addEventListener('pointerdown', stop, true)
  doc.addEventListener('keydown', stop, true)
  el.focus()
  return stop
}
