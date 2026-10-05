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

/** A view or drawer loaded on first use; a failed load takes the stale-pane path. */
export function lazyView<T extends Component>(loader: () => Promise<T | { default: T }>) {
  return defineAsyncComponent({
    loader,
    onError: (_err, _retry, fail) => {
      void reloadPaneIfStale()
      fail()
    },
  })
}
