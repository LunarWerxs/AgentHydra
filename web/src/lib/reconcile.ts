// Polled data, applied without a redraw when nothing changed.
//
// Every table on the Instances tab polls every few seconds, and each poll used to assign a freshly
// parsed list: new objects with the same contents, which Vue must treat as changed, so every row,
// badge and popover re-rendered on every tick (owner, 2026-09-30: "the CLI instances on the page
// keep refreshing... the UI should only update if there's been a change"). These helpers keep the
// previous value wherever the new one is equal. Assigning the SAME reference back to a ref is a
// no-op in Vue, so a poll that brings nothing new touches nothing on screen, and a poll that
// changes one row re-renders that row only.

/** Deep equality for JSON-shaped API data (objects, arrays, primitives, null). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b as object, k)) return false
    if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false
  }
  return true
}

/** The new list, reusing each previous item (by key) that is unchanged, or the previous list
 *  itself when nothing at all changed, order included. */
export function reconcileList<T>(
  prev: readonly T[],
  next: readonly T[],
  key: (item: T) => string,
): T[] {
  const byKey = new Map(prev.map((item) => [key(item), item]))
  let changed = prev.length !== next.length
  const out = next.map((item, i) => {
    const old = byKey.get(key(item))
    if (old !== undefined && sameData(old, item)) {
      if (prev[i] !== old) changed = true
      return old
    }
    changed = true
    return item
  })
  return changed ? out : (prev as T[])
}

/** `prev` with `entries` written into it, as a new Map only when at least one value changed. */
export function reconcileMap<K, V>(prev: Map<K, V>, entries: Iterable<[K, V]>): Map<K, V> {
  let next: Map<K, V> | null = null
  for (const [k, v] of entries) {
    if (sameData(prev.get(k), v)) continue
    next ??= new Map(prev)
    next.set(k, v)
  }
  return next ?? prev
}
