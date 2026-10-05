import { defineAsyncComponent, type Component } from 'vue'
import { reloadIfStale } from './stale-bundle'

/** A panel loaded on first use. A window on an old build asks for a chunk the new build no longer has: that failed load takes the stale-bundle path (the window reloads onto the new build once it is quiet). Each panel keeps its own component type. */
export function lazyPanel<T extends Component>(loader: () => Promise<T | { default: T }>) {
  return defineAsyncComponent({
    loader,
    onError: (_err, _retry, fail) => {
      void reloadIfStale()
      fail()
    }
  })
}
