// web/src/composables/useSharedPrefs.ts — the few UI preferences that must agree across WINDOWS.
//
// The problem this exists for: the quick-instances window usually opens on the running daemon's own
// port and shares the full manager's localStorage, but when no daemon is running the quick launcher
// starts its own server on a DIFFERENT port (server/src/instance-mode.ts). A browser scopes
// localStorage to scheme+host+PORT, so that window lands on a blank slate — same machine, same
// user, same app, no usage filter. Mirroring the handful of keys through the daemon
// (server/src/core/ui-prefs.ts) is what makes "it remembered how I had it set" true either way.
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

import type { Ref } from 'vue'
import { watch } from 'vue'
import * as api from '@/lib/api'

/** A registered preference: the storage key it mirrors, and the live ref behind it. */
interface SharedPref {
  key: string
  ref: Ref<boolean> | Ref<number>
}

const registry: SharedPref[] = []
let hydrated = false
let hydrating: Promise<void> | null = null

/**
 * Parse a stored string back into the ref's own type.
 *
 * vueuse serializes booleans and numbers alike with String(), and the server stores that verbatim,
 * so the ref's CURRENT value is the only type information available — which is enough, because
 * these keys never change type. A value that doesn't parse is ignored rather than coerced: NaN or
 * a surprise `false` written into a threshold is worse than keeping what is already on screen.
 */
function parseLike(current: boolean | number, raw: string): boolean | number | undefined {
  if (typeof current === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Mirror a persisted ref through the daemon so every window agrees on it.
 *
 * Call at MODULE scope, beside the useStorage that owns the key — these are singletons, and a
 * registration inside a component's setup would install one watcher per mount.
 */
export function registerSharedPref(key: string, ref: Ref<boolean> | Ref<number>): void {
  if (registry.some((entry) => entry.key === key)) return
  registry.push({ key, ref })
  watch(ref, (value) => {
    // Pre-hydrate writes are the app materializing defaults, not the user choosing anything.
    if (!hydrated) return
    void api.updateUiPrefs({ [key]: String(value) }).catch(() => {
      // A preference that fails to reach the daemon still applies locally and is still in
      // localStorage; the next change re-tries. Never surface this — it is not the user's problem.
    })
  })
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
      const { prefs } = await api.getUiPrefs()
      const known = registry.filter((entry) => prefs[entry.key] !== undefined)

      // FIRST RUN after this feature shipped: the store holds none of our keys, but this browser
      // may have years of settings in localStorage. Seed the store from them in one write, so the
      // very next window — including one on a different port with an empty localStorage — inherits
      // the real configuration instead of defaults. Without this the store fills in only as each
      // control happens to be touched, and a filter the user set long ago would never migrate.
      if (known.length === 0) {
        const seed: Record<string, string> = {}
        for (const entry of registry) seed[entry.key] = String(entry.ref.value)
        if (Object.keys(seed).length) await api.updateUiPrefs(seed)
        return
      }

      for (const entry of known) {
        const next = parseLike(entry.ref.value, prefs[entry.key] as string)
        if (next === undefined || next === entry.ref.value) continue
        ;(entry.ref as Ref<boolean | number>).value = next
      }
    } catch {
      // No daemon route (an older server), or it failed: local values stand. This is an
      // enhancement to where preferences live, never a requirement for the UI to work.
    } finally {
      // Set LAST, and set even on failure: until this flips, every watcher is muted, so a window
      // that could not reach the store would otherwise never push a change again.
      hydrated = true
    }
  })()
  return hydrating
}

/** Test seam: forget every registration and the hydrate latch. */
export function resetSharedPrefsForTest(): void {
  registry.length = 0
  hydrated = false
  hydrating = null
}
