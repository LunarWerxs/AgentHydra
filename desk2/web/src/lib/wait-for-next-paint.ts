/** Resolves once, on the next animation frame or after `fallbackMs`, whichever comes first. A hidden or occluded window pauses frames, so a bare requestAnimationFrame promise would hang there. */
export function waitForNextPaint(fallbackMs = 200): Promise<void> {
  return new Promise<void>((resolve) => {
    let frame = 0
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame)
      resolve()
    }, fallbackMs)
    frame = requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
