import { type Component, defineAsyncComponent } from 'vue'

// The pane stays open across Desk updates, so it can ask for a lazy chunk the new build no longer has.
// A failed load checks whether the pane's own entry script (the one /ah/ serves now) differs from the one
// this document loaded; if so the pane reloads once per served entry (its own document, not the Desk
// window), otherwise the load fails as it always did.

const RELOADED_FOR = 'hydra-pane:reloaded-for'

/** The entry script's path in an index.html, or null. */
export function entryOf(html: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1] ?? null
}

/** Reloads this pane once when /ah/ now serves a different entry script than the one loaded. */
export async function reloadPaneIfStale(): Promise<boolean> {
  try {
    const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null
    const served = entryOf(await (await fetch('/ah/', { cache: 'no-store' })).text())
    if (!mine || !served || mine === served || sessionStorage.getItem(RELOADED_FOR) === served) return false
    sessionStorage.setItem(RELOADED_FOR, served)
    location.reload()
    return true
  } catch {
    return false // server unreachable: the next failed load looks again
  }
}

/** Every lazy view's loader, for prefetchViews. */
const loaders: Array<() => Promise<unknown>> = []

/** A view or drawer loaded on first use; a failed load takes the stale-pane path. */
export function lazyView<T extends Component>(loader: () => Promise<T | { default: T }>) {
  loaders.push(loader)
  return defineAsyncComponent({
    loader,
    onError: (_err, _retry, fail) => {
      void reloadPaneIfStale()
      fail()
    },
  })
}

const whenIdle = (fn: () => void): void => {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 5000 })
  else setTimeout(fn, 200)
}

let prefetched = false

/** Load every lazy view's chunk ahead of its first use, one at a time and only while the pane is idle, so
 *  switching to Analytics, HSwarm or the queue draws at once instead of waiting on its chunk (owner,
 *  2026-10-08: "preload them ... on an idle state ... so that pages load faster"). A view's own setup still
 *  runs only when it opens; a failed load is left to its first open, which takes the stale-pane path. */
export function prefetchViews(): void {
  if (prefetched) return
  prefetched = true
  const queue = [...loaders]
  const next = (): void => {
    const load = queue.shift()
    if (load) whenIdle(() => void load().catch(() => undefined).finally(next))
  }
  next()
}
