// A lazy chunk the open page asks for can be gone after a rebuild: reload once to get the new page. The guard keeps a
// chunk that is missing for good from reloading the window in a loop.

const KEY = 'desk2-chunk-reload-at'
const GUARD_MS = 60_000
const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/

export interface ReloadTarget extends EventTarget {
  location: { reload(): void }
}

export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function reloadOnChunkFailure(target: ReloadTarget, store: KeyValue, now: () => number = Date.now): void {
  const reload = () => {
    const last = Number(store.getItem(KEY) ?? 0)
    if (now() - last < GUARD_MS) return
    store.setItem(KEY, String(now()))
    target.location.reload()
  }
  target.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    reload()
  })
  target.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason as { message?: unknown } | undefined
    if (typeof reason?.message === 'string' && CHUNK_FAILURE.test(reason.message)) reload()
  })
}
