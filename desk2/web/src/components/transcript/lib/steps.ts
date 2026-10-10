// Where the previous and next message the person sent sit, for the transcript's step arrows. Pure: no Vue, no DOM.

/**
 * The scroll offset that puts the user message at `top` (its top in scroll-content px) on the line `lineOffset` px
 * below the top of the view, clamped at 0.
 */
export function stepTarget(top: number, lineOffset: number): number {
  return Math.max(0, top - lineOffset)
}

/**
 * The scroll offset of the message a step lands on, or null when there is none that moves the view.
 * `tops` are the user messages' tops in scroll-content px, in order; `scrollTop` is where the view is now;
 * `lineOffset` is how far below the view's top a message lands (the header's inset plus a margin).
 * "up" is the nearest message whose landing spot is above the view (scroll back past the one it lands on, so a
 * second step goes to the one before it); "down" is the nearest whose landing spot is below it. A message that
 * already sits on its landing spot is not a step: landing on one never repeats it.
 */
export function nextMessageStep(
  tops: readonly number[],
  scrollTop: number,
  dir: 'up' | 'down',
  lineOffset: number,
): number | null {
  if (dir === 'up') {
    for (let i = tops.length - 1; i >= 0; i--) {
      const target = stepTarget(tops[i], lineOffset)
      if (target < scrollTop - 1) return target
    }
    return null
  }
  for (const top of tops) {
    const target = stepTarget(top, lineOffset)
    if (target > scrollTop + 1) return target
  }
  return null
}
