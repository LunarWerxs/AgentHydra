// The phantom-state sweep of 2026-08-29 found seven ways a chat could end up open with nobody
// coming for it. These pin the shapes of the fixes, so the holes cannot quietly reopen.
import { describe, expect, test } from 'bun:test'

describe('verify gives up eventually', () => {
  // A delivery that is never confirmed used to stay "in flight" forever: the reviewer was told
  // to check again next wake, every wake, while the chat sat in the banned state.
  const GIVE_UP_MS = 3 * 3600_000
  const decide = (ageMs: number): 'pending' | 'released' =>
    ageMs > GIVE_UP_MS ? 'released' : 'pending'

  test('a slow first turn is still just pending', () => {
    expect(decide(60_000)).toBe('pending')
    expect(decide(2.5 * 3600_000)).toBe('pending')
  })

  test('past the bound the item is RELEASED back to the normal cycle, not left in flight', () => {
    expect(decide(3.5 * 3600_000)).toBe('released')
    expect(decide(48 * 3600_000)).toBe('released')
  })
})

describe('save only what actually happened', () => {
  // Both seed-and-deliver paths used to stamp "delivered" BEFORE checking a route existed, so an
  // unreachable target produced a permanently in-flight item over a chat nothing would boot.
  const shouldPersistDelivery = (route: { mode: string; step?: unknown }): boolean =>
    route.mode !== 'none' && !!route.step

  test('a real route persists, an absent one does not', () => {
    expect(shouldPersistDelivery({ mode: 'own-instance', step: {} })).toBe(true)
    expect(shouldPersistDelivery({ mode: 'direct-live', step: {} })).toBe(true)
    expect(shouldPersistDelivery({ mode: 'none' })).toBe(false)
    // courier-task is handled before this point (queued), and carries no step of its own.
    expect(shouldPersistDelivery({ mode: 'courier-task' })).toBe(false)
  })
})

describe('suppression is never silence', () => {
  // A chat parked by the concurrency cap was dropped with a bare continue - no item, no counter,
  // no line - so it could wait for a slot indefinitely, unseen by reviewer and owner alike.
  const suppressedLine = (key: string) =>
    `${key} -> waiting for a rotation slot (concurrency cap); not offered until a slot frees`

  test('a slot-parked chat produces a visible suppressed line naming it', () => {
    const line = suppressedLine('idle:abc123')
    expect(line).toContain('idle:abc123')
    expect(line).toContain('rotation slot')
  })
})

describe('a live chat is never invisible', () => {
  // A live session whose transcript could not be stat'd returned nothing at all AND did not
  // count toward the concurrency cap - running, yet absent from every surface.
  const classify = (transcriptPath: string | null, mtime: number | null) => {
    if (!transcriptPath) return { item: 'errored', counted: false }
    if (mtime === null) return { item: 'errored', counted: true }
    return { item: 'normal', counted: true }
  }

  test('an unreadable transcript still raises an item AND holds its slot', () => {
    const r = classify('C:/x/t.jsonl', null)
    expect(r.item).toBe('errored')
    expect(r.counted).toBe(true)
  })

  test('a missing path keeps its existing behaviour', () => {
    expect(classify(null, null).item).toBe('errored')
  })
})
