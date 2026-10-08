import { defineAsyncComponent, type Component } from 'vue'
import { reloadIfStale } from './stale-bundle'

/** Every lazy panel's loader, for prefetchPanels. */
const loaders: Array<() => Promise<unknown>> = []

/** A panel loaded on first use. A window on an old build asks for a chunk the new build no longer has: that failed load takes the stale-bundle path (the window reloads onto the new build once it is quiet). Each panel keeps its own component type. */
export function lazyPanel<T extends Component>(loader: () => Promise<T | { default: T }>) {
  loaders.push(loader)
  return defineAsyncComponent({
    loader,
    onError: (_err, _retry, fail) => {
      void reloadIfStale()
      fail()
    }
  })
}

const whenIdle = (fn: () => void): void => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 5000 })
  else setTimeout(fn, 200)
}

let prefetched = false

/** Load every lazy panel's chunk ahead of its first use, one at a time and only while the window is idle, so
 *  opening Settings, Changes, Servers or CliMayte later draws at once instead of waiting on its chunk (owner,
 *  2026-10-08: "preload them ... on an idle state ... so that pages load faster"). A panel's own setup still
 *  runs only when it opens. A failed load is left to the panel's first open, which takes the stale-bundle path. */
export function prefetchPanels(): void {
  if (prefetched) return
  prefetched = true
  const queue = [...loaders]
  const next = (): void => {
    const load = queue.shift()
    if (load) whenIdle(() => void load().catch(() => undefined).finally(next))
  }
  next()
}
