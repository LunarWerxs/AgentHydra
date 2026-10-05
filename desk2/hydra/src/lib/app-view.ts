// web/src/lib/app-view.ts — which tab THIS window is on, and the split from "which tab next time".
//
// One key used to serve both jobs, and that is the bug it exists to fix: `agenthydra.app.view` was
// a plain useStorage, and vueuse listens for the browser's `storage` event by default. Two windows
// of the app are the same origin, so clicking Instances in one pushed Instances into the other,
// live. Duplicating the tab to watch Sessions beside Instances — the obvious way to use a two-tab
// app on a wide monitor — was therefore impossible: the second window snapped to whatever the first
// one was showing.
//
// The two jobs are genuinely different and now have different homes:
//
//  * WHICH TAB THIS WINDOW IS ON is per browsing context, so it lives in sessionStorage. That is
//    the only web storage scoped the way the user thinks: it survives a reload (the point of
//    remembering at all — this is a long-lived tray window that gets restarted by updates and stray
//    F5s), it is COPIED into a duplicated tab (so the duplicate opens on what you were looking at),
//    and from that moment the two are independent. No listener, no event, nothing to leak between
//    windows, because sessionStorage has no cross-context event to begin with.
//  * WHICH TAB A BRAND-NEW WINDOW OPENS ON stays in localStorage and stays mirrored through the
//    daemon (composables/useSharedPrefs.ts), because a window opened tomorrow, or on a hopped port
//    with an empty localStorage, has no session of its own to remember. It is written by every
//    window and read by none of them after the first paint — last click wins, which is exactly
//    what "where I left off" means when several windows are open.
//
// Storages are taken by parameter, the same reasoning lib/storage-rebrand.ts carries: the rule
// above is worth a test, and a test of it should not need a DOM.

import { type InjectionKey, type Ref, ref, watch } from 'vue'

export type AppView =
  | 'instances-home'
  | 'cli'
  | 'desktop'
  | 'analytics'
  | 'hswarm'
export const APP_VIEWS: readonly AppView[] = [
  'instances-home',
  'cli',
  'desktop',
  'analytics',
  'hswarm',
]

/** The views under the Instances group: the landing page and its two sub-pages. */
export const INSTANCES_VIEWS: readonly AppView[] = ['instances-home', 'cli', 'desktop']

/** Tabs that were folded into another one, and where they went. The Corch tab (now CliMayte) became
 *  part of the CLI tab (2026-09-30); a window that last stood on it opens there rather than falling
 *  back to Sessions. `corch` is the value such a window stored. */
const RENAMED_VIEWS: Readonly<Record<string, AppView>> = {
  corch: 'cli',
  // `instances` was the desktop accounts page; the id now belongs to the group's landing page
  // (`instances-home`), so a stored `instances` keeps meaning the desktop page it always meant.
  instances: 'desktop',
  // Hydra Desk 2's copy has no Sessions tab (2026-10-04): Desk's cloud list is it.
  sessions: 'hswarm',
  // CliMayte moved into the HSwarm tab as its first page (2026-10-05).
  climayte: 'hswarm',
}

/** The one key, under both storages. Same name deliberately: they hold the same kind of value, for
 *  different lifetimes, and a reader looking at either one should not have to learn two names. */
export const APP_VIEW_KEY = 'agenthydra.app.view'

/** Validated on read, never trusted: a stale, hand-edited or downgrade-era value must fall back
 *  rather than render a tab that no longer exists. Null means "nothing usable here". */
export function parseAppView(raw: string | null | undefined): AppView | null {
  if (raw == null) return null
  if (Object.hasOwn(RENAMED_VIEWS, raw)) return RENAMED_VIEWS[raw] ?? null
  return APP_VIEWS.includes(raw as AppView) ? (raw as AppView) : null
}

/** Session storage, or null where it cannot be had. Private-browsing modes throw on the ACCESS,
 *  not just the call, so even naming it needs the guard. Losing it costs the reload memory in that
 *  one window; nothing else. */
export function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * The ref the shell binds its tabs to.
 *
 * `stored` is the durable, shared, daemon-mirrored preference; the returned ref is this window's
 * own. Changes flow one way — window to store — with exactly one exception, below.
 */
export function createTabView(stored: Ref<AppView>, session: Storage | null): Ref<AppView> {
  let own: AppView | null = null
  try {
    own = parseAppView(session?.getItem(APP_VIEW_KEY))
  } catch {
    own = null // storage blocked mid-flight; the durable value is a fine starting point
  }

  const view = ref<AppView>(own ?? stored.value) as Ref<AppView>

  /**
   * Whether the durable value may still move this window.
   *
   * True only for a window that has never been anywhere — a genuinely fresh tab, painting from a
   * localStorage that on a hopped port is empty. Its one job is to let the daemon's answer land a
   * beat after first paint (composables/useSharedPrefs.ts hydrates asynchronously, by design, so
   * nothing waits on a round trip). A duplicated tab carries sessionStorage across, so it starts
   * with this already false and is never dragged anywhere by its sibling.
   */
  let adoptsStored = own === null

  watch(
    view,
    (next) => {
      // This window has now been somewhere. Set FIRST, so a click that happens while hydrate is
      // still in flight cannot be undone by the correction it is racing.
      adoptsStored = false
      try {
        session?.setItem(APP_VIEW_KEY, next)
      } catch {
        // Quota or private mode: the tab still switches, it just will not survive a reload.
      }
      stored.value = next
    },
    // SYNC, deliberately, and for the same reason useSharedPrefs registers sync: the latch above
    // has to land before any continuation of an in-flight hydrate can run. A deferred flush cannot
    // promise that ordering.
    { flush: 'sync' },
  )

  watch(
    stored,
    (next) => {
      if (adoptsStored && next !== view.value) view.value = next
    },
    { flush: 'sync' },
  )

  return view
}

/** How long a fresh window holds its tab body waiting for the daemon's answer before it mounts the
 *  tab it has. */
export const VIEW_HOLD_MS = 300

/**
 * Whether the shell may mount the tab body yet.
 *
 * A window with a tab of its own (sessionStorage) is ready at once. A fresh window may still be moved
 * by the daemon's answer (see `adoptsStored` above), and mounting the localStorage tab first leaves
 * it built, fetched and kept alive (KeepAlive) after the switch. So it waits for the shared prefs to
 * settle, a click, or `holdMs`, whichever is first. The header and nav never wait on this.
 */
export function createViewReady(
  view: Ref<AppView>,
  session: Storage | null,
  settled: Ref<boolean>,
  holdMs: number = VIEW_HOLD_MS,
): Ref<boolean> {
  let own: AppView | null = null
  try {
    own = parseAppView(session?.getItem(APP_VIEW_KEY))
  } catch {
    own = null
  }
  // Read before createTabView's watcher could write it: callers build this first, or pass a session
  // whose value was already there. A window that has a tab of its own is ready now.
  const ready = ref(own !== null || settled.value)
  if (ready.value) return ready

  let timer: ReturnType<typeof setTimeout> | undefined
  const open = () => {
    ready.value = true
    if (timer !== undefined) clearTimeout(timer)
    stop1()
    stop2()
  }
  const stop1 = watch(settled, (done) => done && open(), { flush: 'sync' })
  // A click moves the view before any answer; mount what was clicked at once.
  const stop2 = watch(view, open, { flush: 'sync' })
  timer = setTimeout(open, holdMs)
  return ready
}

/** Provided by App.vue: lets a nested view switch the tab (e.g. a stats card's "open HSwarm"). */
export const OPEN_VIEW: InjectionKey<(view: AppView) => void> = Symbol('open-view')
