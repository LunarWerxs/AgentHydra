// web/src/lib/storage-rebrand.ts — carry pre-rename localStorage keys over to the new namespace.
//
// Every persisted UI preference (sidebar width, provider scope, collapse state, locale) was
// namespaced `ccmanagerui.*` up to v0.13.x, the last release before the AgentHydra rename. VueUse's
// useStorage resolves its key once during component setup and never re-reads it, so the carry-over
// has to run BEFORE anything mounts — main.ts calls it as its first statement.
//
// A LEAF module on purpose: no Vue, no app imports, takes its Storage by parameter, so the test
// drives it with a stub instead of a jsdom global.

const LEGACY_PREFIX = 'ccmanagerui.'
const PREFIX = 'agenthydra.'

/**
 * Set when the carry-over actually found pre-rename keys, i.e. this machine ran CC Manager UI.
 *
 * It exists to gate the one-time rebrand notice on being an UPGRADER. A first-time install has
 * never heard the old name and should not be shown a note explaining a rename it did not live
 * through. App.vue reads and clears it on mount; the value crossing a module boundary through
 * storage (rather than a return value) is what lets main.ts run the carry-over before any
 * component exists to receive it.
 */
export const REBRAND_NOTICE_KEY = `${PREFIX}rebrandNoticePending`

/**
 * Copy every `ccmanagerui.*` entry to its `agenthydra.*` name and drop the original.
 *
 * An existing new-namespace value always wins, which makes this idempotent and means a user who
 * ran a newer build, went back to v0.13.x, then upgraded again does not get their newer choice
 * overwritten by the stale one the old build left behind. Storage access is wrapped because
 * private-browsing modes throw on the very first `length` read; preferences then fall back to their
 * defaults, exactly as they already do when useStorage itself cannot reach storage.
 */
export function migrateLegacyStorageKeys(store: Storage = localStorage): void {
  try {
    const legacyKeys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key)
    }
    for (const legacyKey of legacyKeys) {
      const key = PREFIX + legacyKey.slice(LEGACY_PREFIX.length)
      const value = store.getItem(legacyKey)
      if (value !== null && store.getItem(key) === null) store.setItem(key, value)
      store.removeItem(legacyKey)
    }
    if (legacyKeys.length > 0) store.setItem(REBRAND_NOTICE_KEY, '1')
  } catch {
    // Storage unavailable. Nothing to carry over, and nothing worth surfacing to the user.
  }
}
