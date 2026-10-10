// A list row that goes away fades out, then folds shut, so the rows under it close up instead of jumping
// (owner, 2026-10-05: "instead of disappearing, it should, like, fade out and then slightly animate closed").
// The leave hook of a <TransitionGroup :css="false">. With reduced motion asked for, or the window hidden
// (its animations do not run, and the row would wait there to fade when it is shown again), it goes at once.

import { watch, type WatchSource } from 'vue'
import { reducedMotion } from '@/components/transcript/lib/motion'

const FADE_MS = 160
export const CLOSE_MS = 180

/** True when a leave goes at once: no Web Animations, the window hidden, or reduced motion asked for. */
export function leavesAtOnce(el: HTMLElement): boolean {
  return typeof el.animate !== 'function' || document.visibilityState === 'hidden' || reducedMotion()
}

export function rowLeave(el: Element, done: () => void): void {
  const row = el as HTMLElement
  if (leavesAtOnce(row)) return done()
  // The timer ends it anyway, should the animation never finish (a window hidden halfway).
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    done()
  }
  const timer = setTimeout(end, FADE_MS + CLOSE_MS + 200)
  row.style.overflow = 'hidden'
  row.style.pointerEvents = 'none'
  row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' })
  const close = row.animate([{ height: `${row.offsetHeight}px` }, { height: '0px' }], {
    duration: CLOSE_MS,
    delay: FADE_MS,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fill: 'forwards'
  })
  close.onfinish = close.oncancel = end
}

/**
 * rowLeave for a list a search or a filter narrows: the rows one hides go at once, so each keystroke's
 * answer shows straight away; a row that went away by itself still fades. `filters` are what the search
 * and the filters are made of. Call it in a component's setup.
 */
export function leaveUnlessFiltered(filters: WatchSource[]): (el: Element, done: () => void) => void {
  let hiding = false
  // Vue renders the change in a microtask; the timeout runs after that render.
  watch(filters, () => {
    hiding = true
    setTimeout(() => (hiding = false))
  }, { flush: 'sync' })
  return (el, done) => (hiding ? done() : rowLeave(el, done))
}
