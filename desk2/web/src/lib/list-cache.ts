// The last copy of a list the sidebar draws (outside sessions, CliMayte workers, the cloud list), kept in
// this browser so a reload paints the sidebar at once instead of empty until the server answers
// (Michael, 2026-10-04: "population of the left sidebar seems first laggy ... should do better with
// caching"). The server's own copy replaces it a moment later; nothing here is ever sent anywhere.

const PREFIX = 'hydra-desk.cache.'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The cached value, or null when there is none or it does not parse. */
export function readCache<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** A cached list, or null when there is none or what is kept is not a list (another build's, a hand edit). */
export function readListCache<T>(key: string): T[] | null {
  const value = readCache<unknown>(key)
  return Array.isArray(value) ? (value as T[]) : null
}

/** Kept until the next write; a full or blocked storage just goes without. */
export function writeCache(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // floor-ok: without the cache a reload waits for the server, as it did before.
  }
}
