// web/src/composables/useSharedPrefs.ts — the few UI preferences that must agree across WINDOWS.
//
// The problem this exists for: the quick-instances window usually opens on the running daemon's own
// port and shares the full manager's localStorage, but when no daemon is running the quick launcher
// starts its own server on a DIFFERENT port (server/src/instance-mode.ts). A browser scopes
// localStorage to scheme+host+PORT, so that window lands on a blank slate — same machine, same
// user, same app, no usage filter. Mirroring the handful of keys through the daemon
// (server/src/core/ui-prefs.ts) is what makes "it remembered how I had it set" true either way.
//
// A port is not only a quick-mode concern, either: the full daemon HOPS to 7788/7789/… whenever its
// preferred port is busy, which on this developer's machine is most launches. Every hop is a new
// browser origin with an empty localStorage, so the store below is not a fallback for an edge case
// — on a hopped port it is the ONLY thing that remembers anything.
//
// The ownership rule is the important part, and it is: THE SERVER WINS ON HYDRATE, localStorage is
// a synchronous first-paint cache. Anything else re-introduces the bug. If localStorage won, the
// window that happens to have a stale local copy would silently overwrite the newer shared value
// the moment you touched anything; and since useStorage WRITES ITS DEFAULT the first time a key is
// read, "is there a local value?" cannot distinguish a deliberate choice from a default that was
// materialized microseconds ago. So local reads paint instantly, the server correction arrives a
// beat later, and every change is pushed back.
//
// The other half of that rule: NOTHING IS PUSHED BEFORE THE FIRST HYDRATE RESOLVES. Registering a
// ref installs a watcher, and those refs get their defaults written during app setup — pushing
// those would have every freshly-opened window clobber the shared state with defaults before it
// ever learned what was stored.
//
// "The server wins" is about a value the user did NOT just choose, though, and three ways of losing
// a value they DID choose are what this file has to hold shut. Each one shows up as the same thing:
// the app forgot whether the usage filter was on.
//
//  * A CHOICE MADE WHILE THE FIRST READ IS STILL IN FLIGHT. The window paints from localStorage
//    (defaults, on a port the browser has never seen), so the filter reads as off; clicking it on
//    right then used to be dropped by the watcher AND then overwritten by the value hydrate brought
//    back. Such a change is now recorded as PENDING the instant it happens, hydrate leaves a pending
//    key alone, and the flush at the end of hydrate is what sends it. The no-push-before-hydrate
//    rule is intact — the change is held, not pushed early — it just is no longer thrown away.
//  * A READ THAT FAILED ONCE. The window is opened by a daemon that is still finishing its own
//    startup, so the first ask can arrive before the socket answers. One failure used to be
//    permanent: no retry, no second hydrate, and the window ran on its cache for the rest of its
//    life. It is retried now.
//  * A PUSH THE CLOSING WINDOW CANCELLED. Toggling something and immediately closing the window
//    killed the request with the document, and since the store is authoritative the next launch
//    handed the old value straight back. Whatever is still pending goes out on `pagehide` as a
//    beacon, which outlives the page.

import type { Ref } from 'vue'
import { watch } from 'vue'
import * as api from '@/lib/api'

/** A ref this file knows how to move through the store: a switch, a number, or a short enum. */
export type SharedPrefRef = Ref<boolean> | Ref<number> | Ref<string>

/** A registered preference: the storage key it mirrors, and the live ref behind it. */
interface SharedPref {
  key: string
  ref: SharedPrefRef
  /** For a string ref whose value is one of a fixed set — the store is a plain file on disk, and a
   *  hand-edited or downgrade-era value must not reach a `<select>` that has no such option. */
  allowed?: readonly string[]
}

const registry: SharedPref[] = []
let hydrated = false
let hydrating: Promise<void> | null = null
/**
 * The last value each key is known to hold ON THE SERVER — what we read during hydrate, or what we
 * last pushed. It exists to kill an echo: Vue watchers can flush on a later tick than the assignment
 * that triggered them, so by the time hydrate's own corrections reach their watchers the `hydrated`
 * latch below is already true, and every value the server had just sent us was being POSTed
 * straight back. On this machine that was three redundant writes on every single page load, each a
 * full round trip during first paint. Comparing against what the server already has skips them
 * without weakening the ownership rule — a genuine user change still differs, and still pushes.
 */
const synced = new Map<string, string>()
/**
 * Choices THIS window has made that the store has not confirmed: key → value.
 *
 * It is the difference between "the store disagrees with me because I am stale" (it wins) and
 * "the store disagrees with me because it has not heard from me yet" (I win). Entries leave only
 * when a write comes back OK, so a failed or cancelled push stays queued for the next flush and for
 * the beacon on the way out, rather than being silently reverted on the next launch.
 */
const pending = new Map<string, string>()
/**
 * The snapshot the last hydrate read, kept so a preference registered AFTERWARDS still gets it.
 *
 * Hydrate runs once per window and can only apply what is registered at that moment; today every
 * mirrored key is registered by a module the app entry has already imported, but one lazily-loaded
 * view would silently opt itself out of the store forever. Keeping the snapshot makes registration
 * order stop mattering.
 */
let stored: Record<string, string> | null = null
let unloadFlushInstalled = false

/** How hard to try before accepting that this window will run on its local cache. Three attempts
 *  over ~750 ms covers a daemon that is still coming up without delaying anything the user can see
 *  (nothing awaits this; the UI is already painted from localStorage). */
const HYDRATE_ATTEMPTS = 3
const HYDRATE_RETRY_MS = 250

/**
 * Parse a stored string back into the ref's own type.
 *
 * vueuse serializes booleans, numbers and strings alike with String(), and the server stores that
 * verbatim, so the ref's CURRENT value is the only type information available — which is enough,
 * because these keys never change type. A value that doesn't parse is ignored rather than coerced:
 * NaN or a surprise `false` written into a threshold is worse than keeping what is already on
 * screen, and an enum outside its own set is worse still (it renders as a control with nothing
 * chosen). A string ref with no declared set takes the value as written.
 */
function parseLike(entry: SharedPref, raw: string): boolean | number | string | undefined {
  const current = entry.ref.value
  if (typeof current === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  if (typeof current === 'string') {
    if (entry.allowed && !entry.allowed.includes(raw)) return undefined
    return raw
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Apply one stored value to its ref.
 *
 * `synced` is recorded BEFORE the assignment, so the watcher that assignment triggers recognises
 * its own echo and stays quiet. A key this window has already chosen and not yet pushed is left
 * alone — that is the one case where local is newer than the store, not staler.
 */
function applyFromStore(entry: SharedPref, raw: string): void {
  if (pending.has(entry.key)) return
  synced.set(entry.key, raw)
  const next = parseLike(entry, raw)
  if (next === undefined || next === entry.ref.value) return
  ;(entry.ref as Ref<boolean | number | string>).value = next
}

/** Write a patch to the store, and only forget it once the store says it has it. */
function push(patch: Record<string, string>): void {
  for (const [key, value] of Object.entries(patch)) synced.set(key, value)
  void api.updateUiPrefs(patch).then(
    () => {
      for (const [key, value] of Object.entries(patch)) {
        // Only if it is still the value we sent — a newer choice made mid-flight stays pending.
        if (pending.get(key) === value) pending.delete(key)
      }
    },
    () => {
      // The push failed, so the store does NOT hold these values; forget them or the next attempt
      // at the same value would be skipped as already-synced. They stay in `pending`, which is what
      // the next change re-sends and what the beacon carries if the window closes first. Never
      // surface this — it is not the user's problem.
      for (const key of Object.keys(patch)) synced.delete(key)
    },
  )
}

/** Send everything this window has chosen and not had confirmed, in ONE write. */
function flushPending(): void {
  if (!hydrated || pending.size === 0) return
  push(Object.fromEntries(pending))
}

/**
 * Hand any unconfirmed choice to the network stack on the way out.
 *
 * `pagehide` rather than `beforeunload`: it fires for a window being closed as well as for a
 * navigation, and it is the last moment a request can still be handed off. `sendBeacon` rather than
 * fetch, because a normal request from a closing document is cancelled along with it — which is
 * precisely how "I turned the filter off and closed the window" ended up not being remembered. The
 * request is same-origin, so the daemon's cross-site guard sees `Sec-Fetch-Site: same-origin` and
 * lets it through (server/src/loopback-guard.mjs).
 */
function installUnloadFlush(): void {
  if (unloadFlushInstalled || typeof window === 'undefined') return
  unloadFlushInstalled = true
  window.addEventListener('pagehide', () => {
    if (pending.size === 0 || typeof navigator === 'undefined') return
    const body = JSON.stringify(Object.fromEntries(pending))
    navigator.sendBeacon?.(
      `${api.API_BASE}/api/ui-prefs`,
      new Blob([body], { type: 'application/json' }),
    )
  })
}

/**
 * Mirror a persisted ref through the daemon so every window agrees on it.
 *
 * Call at MODULE scope, beside the useStorage that owns the key. Not merely a style rule: a
 * registration inside a component's setup would install one watcher per mount, and worse, only the
 * FIRST mount's ref is kept (registration is keyed) — so the mirror would quietly die the moment
 * that component unmounted, which for a view behind a tab is the common case.
 *
 * `allowed` declares the value set of a string ref, for the same reason numbers are range-checked
 * by their own setters: nothing the store hands back should be able to put the UI in a state the
 * UI cannot produce.
 */
export function registerSharedPref(
  key: string,
  ref: SharedPrefRef,
  allowed?: readonly string[],
): void {
  if (registry.some((entry) => entry.key === key)) return
  const entry: SharedPref = { key, ref, allowed }
  registry.push(entry)
  installUnloadFlush()
  // Registered after the store was already read (a lazily-loaded view): apply it now, since hydrate
  // will not run again for this window.
  const late = stored?.[key]
  if (hydrated && late !== undefined) applyFromStore(entry, late)

  watch(
    ref,
    (value) => {
      const next = String(value)
      // Already what the store holds — this is hydrate's own correction arriving on a later tick.
      if (synced.get(key) === next) return
      // Recorded FIRST and unconditionally, including before hydrate has resolved. Registration
      // happens at module scope immediately after the useStorage that owns the key, so the default
      // has already been materialized by the time this watcher exists: anything it sees is a real
      // change (a click, or another tab's `storage` event), never setup noise.
      pending.set(key, next)
      if (!hydrated) return
      flushPending()
    },
    // SYNC, deliberately. The record above has to land before any continuation of an in-flight
    // hydrate can run, or hydrate applies the stored value over a click that has not been noted
    // yet and the click is lost. A deferred flush cannot promise that ordering; this can.
    { flush: 'sync' },
  )
}

/** Read the store, retrying a daemon that has not finished coming up. Null means "could not". */
async function readStoredPrefs(): Promise<Record<string, string> | null> {
  for (let attempt = 0; attempt < HYDRATE_ATTEMPTS; attempt++) {
    try {
      const { prefs } = await api.getUiPrefs()
      return prefs
    } catch {
      if (attempt === HYDRATE_ATTEMPTS - 1) return null
      await new Promise((resolve) => setTimeout(resolve, HYDRATE_RETRY_MS * 2 ** attempt))
    }
  }
  return null
}

/**
 * Pull the shared preferences and apply them over the local cache. Called once per window, from
 * the app entry, and safe to call again (later calls await/replay the same fetch).
 *
 * Applying a value assigns the ref, which useStorage persists locally on its own — so the cache
 * self-heals and the next launch paints the right thing before this request even goes out.
 */
export function hydrateSharedPrefs(): Promise<void> {
  if (hydrating) return hydrating
  hydrating = (async () => {
    try {
      const prefs = await readStoredPrefs()
      // No daemon route (an older server), or it failed every attempt: local values stand. This is
      // an enhancement to where preferences live, never a requirement for the UI to work.
      if (!prefs) return
      stored = prefs

      for (const entry of registry) {
        const raw = prefs[entry.key]
        if (raw !== undefined) {
          applyFromStore(entry, raw)
          continue
        }
        // A key the store has never heard of: a first run after this feature shipped, or a
        // preference added to the mirror in a later version. This browser may have years of it in
        // localStorage, so queue what it has and let the flush below seed the store in one write.
        // The very next window — including one on a different port with an empty localStorage —
        // then inherits the real configuration instead of defaults. Without this the store fills in
        // only as each control happens to be touched, and a setting made long ago never migrates.
        pending.set(entry.key, String(entry.ref.value))
      }
    } finally {
      // Set LAST, and set even on failure: until this flips, every watcher holds its change rather
      // than pushing it, so a window that could not reach the store would otherwise never send one.
      hydrated = true
      flushPending()
    }
  })()
  return hydrating
}

/** Test seam: forget every registration and the hydrate latch. */
export function resetSharedPrefsForTest(): void {
  registry.length = 0
  hydrated = false
  hydrating = null
  stored = null
  synced.clear()
  pending.clear()
}
