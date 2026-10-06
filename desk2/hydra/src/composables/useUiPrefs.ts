// web/src/composables/useUiPrefs.ts — the remembered layout choices no other composable owns.
//
// These used to be declared inside the components that read them, which was fine while
// localStorage was the only place they lived. It stops being fine the moment they are mirrored
// through the daemon (composables/useSharedPrefs.ts): a registration is keyed, so only the FIRST
// mount's ref is ever the mirrored one, and a view behind a tab unmounts the moment you switch
// away — after which that ref is detached and every later change to the preference goes nowhere.
// Module scope is what makes "one ref per preference, for the life of the window" true, the same
// reasoning composables/useUsageMode.ts and useInstanceFilter.ts already carry.
//
// Why mirror them at all: the full daemon HOPS to 7788/7789/… whenever its preferred port is busy,
// and a browser scopes localStorage to scheme+host+PORT. Every hop is therefore a new origin with
// an empty cache, and a preference that lives only in the browser is a preference the app forgets
// on those launches — not a rare case on a machine that runs the daemon alongside other things.
//
// What is deliberately NOT here: the theme (owned by the shared kit under its own un-namespaced
// key, which the daemon's store does not accept and should not), and the locale (written by the
// kit's i18n factory with no ref to mirror, and English is the only catalog that ships today).

import { useStorage } from '@vueuse/core'
import {
  APP_VIEW_KEY,
  APP_VIEWS,
  type AppView,
  createTabView,
  createViewReady,
  parseAppView,
  tabStorage,
} from '@/lib/app-view'
import { registerSharedPref, sharedPrefsRequested, sharedPrefsSettled } from './useSharedPrefs'

export { APP_VIEWS, type AppView } from '@/lib/app-view'

// --- which tab you were on --------------------------------------------------------------------
// The app is a long-lived tray window that gets reloaded for all sorts of incidental reasons (an
// update, a restart, a stray F5), and landing back on Sessions every time undid whatever you were
// in the middle of looking at.
//
// Unlike everything else in this file it is NOT one value shared by every window — two windows on
// two different tabs is a normal way to use the app, and this used to be impossible. The rule, and
// why the two storages differ, is in lib/app-view.ts; here it is only wired up.

/** Where a BRAND-NEW window opens: localStorage, mirrored through the daemon. Written by every
 *  window, read by none after first paint. Validated on read, not trusted — a stale or hand-edited
 *  value must fall back rather than render a tab that no longer exists, and the same set is handed
 *  to the mirror, which has to make the same guarantee about what the daemon's store gives back. */
const storedView = useStorage<AppView>(APP_VIEW_KEY, 'hswarm', undefined, {
  // No cross-window listener. That listener IS the bug: same origin, so a click in one window was
  // pushed into the other one live. This key is a memory for next time, not a channel between
  // windows, and the daemon mirror below is how it reaches a window on a different port.
  listenToStorageChanges: false,
  serializer: {
    read: (raw) => parseAppView(raw) ?? 'hswarm',
    write: (v) => v,
  },
})

/** Where THIS window is, which is what the shell's tabs bind to. */
const view = createTabView(storedView, tabStorage())

/** False while a fresh window waits (up to 300 ms) for the daemon's answer on which tab to open. */
const viewReady = createViewReady(view, tabStorage(), sharedPrefsSettled, sharedPrefsRequested)

// --- Instances: how the desktop table is sorted ------------------------------------------------
// Which column, and which way. The table used to forget its sort on every reload, which on a
// long-lived tray window means every update, restart or stray F5 threw away the ordering someone
// had chosen. Strings, with '' for "unsorted", so the value round-trips through the daemon's
// flat string store untouched; useSortable turns a stale column name back into "unsorted".
const desktopSortKey = useStorage('agenthydra.instances.desktopSortKey', '')
const desktopSortDirection = useStorage('agenthydra.instances.desktopSortDirection', '')

/** Mask account e-mail addresses across the UI, for screenshots and screen-shares. */
const privacyMode = useStorage('agenthydra.privacyMode', false)

// Mirrored through the daemon, at module scope, for the reasons in the header.
registerSharedPref(APP_VIEW_KEY, storedView, APP_VIEWS)
registerSharedPref('agenthydra.instances.desktopSortKey', desktopSortKey)
registerSharedPref('agenthydra.instances.desktopSortDirection', desktopSortDirection, [
  '',
  'asc',
  'desc',
])
registerSharedPref('agenthydra.privacyMode', privacyMode)

/** The shared, persisted layout state. Singletons — every caller gets the same refs. */
export function useUiPrefs() {
  return {
    view,
    viewReady,
    desktopSortKey,
    desktopSortDirection,
    privacyMode,
  }
}

// usePrivacy.ts reads it at module scope, outside any setup.
export { privacyMode }
