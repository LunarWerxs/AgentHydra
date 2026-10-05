// A poll that rests while nobody can see the page: the window minimized, or in Hydra Desk 2 the AgentHydra
// pane slid out of view (lib/desk-embed.ts makes document.hidden say so). A beat that falls while hidden is
// skipped, and the first moment the page is seen again runs it at once, so what shows is never a reading
// from before it was hidden.

/** Runs `run` every `ms` while the page is visible. Returns the stop. */
export function visibleInterval(run: () => void, ms: number): () => void {
  let missed = false
  const id = window.setInterval(() => {
    if (document.hidden) missed = true
    else run()
  }, ms)
  const onVisibility = () => {
    if (document.hidden || !missed) return
    missed = false
    run()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
