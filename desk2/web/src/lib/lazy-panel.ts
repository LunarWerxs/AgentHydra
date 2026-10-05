import { defineAsyncComponent, type Component } from 'vue'
import { reloadIfStale } from './stale-bundle'

/** A panel loaded on first use. A window on an old build asks for a chunk the new build no longer has: that failed load takes the stale-bundle path (the window reloads onto the new build once it is quiet). */
export function lazyPanel(loader: () => Promise<Component>) {
  return defineAsyncComponent({
    loader,
    onError: (_err, _retry, fail) => {
      void reloadIfStale()
      fail()
    }
  })
}
