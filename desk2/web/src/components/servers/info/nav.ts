// How the info pane moves between its views (owner, 2026-10-07: "there's no back button on the top left"). The card
// view of a selection can open a sub-view (edit a server, add one, edit a project, take over); the pane's title strip
// then shows Back, which returns to the card view where it was scrolled. A card's own links (a server's project, a
// project's server) move the selection and Back returns there too. InfoPane provides this; a view injects it.
import { inject, ref, type InjectionKey } from 'vue'

export type SubView =
  | { kind: 'edit-server'; id: string }
  | { kind: 'add-server'; projectId: string }
  | { kind: 'edit-project'; id: string }
  | { kind: 'takeover'; projectId: string }

export interface PaneNav {
  /** Opens a sub-view over the card view. */
  open(sub: SubView): void
  /** Back: closes the sub-view, else returns to the selection before this one, else closes the pane. */
  back(): void
  /** Closes the pane. */
  close(): void
}

export const PANE_NAV: InjectionKey<PaneNav> = Symbol('pane-nav')

export function usePaneNav(): PaneNav {
  const nav = inject(PANE_NAV, null)
  if (!nav) throw new Error('usePaneNav is for the views inside the info pane')
  return nav
}

/** A server's tabs. The tab picked stays as another server is picked, so moving down the list keeps the logs (or errors) on screen. */
export type ServerTab = 'overview' | 'logs' | 'errors' | 'alerts'
export const serverTab = ref<ServerTab>('overview')

/**
 * What the pane last read for each server (its errors, its CPU and memory history, the alert rules), kept for the page's
 * life: a view picked again, or the next server's view as it mounts, shows what it had at once and replaces it when its
 * own read answers, instead of flashing empty.
 */
export function memo<T>(): { get(key: string): T | undefined; set(key: string, value: T): void } {
  const m = new Map<string, T>()
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.delete(k)
      m.set(k, v)
      if (m.size > 64) m.delete(m.keys().next().value as string)
    }
  }
}
