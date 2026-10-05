// The sidebar's leave hook (src/lib/row-leave.ts): a row that goes away fades, but never stays behind, and
// rows a search or a filter hides go at once. No DOM here: the window's two facts it reads are set below.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { nextTick, ref } from 'vue'
import { leaveUnlessFiltered, rowLeave } from '../../src/lib/row-leave'

const g = globalThis as Record<string, unknown>
let saved: Record<string, unknown>
beforeEach(() => {
  saved = { document: g.document, matchMedia: g.matchMedia }
  g.document = { visibilityState: 'visible' }
  g.matchMedia = () => ({ matches: false })
})
afterEach(() => Object.assign(g, saved))

/** A row whose animations start and never finish, as in a window hidden halfway through. */
function row() {
  const calls: unknown[] = []
  const el = { style: {}, offsetHeight: 28, animate: (k: unknown) => (calls.push(k), {}) }
  return { el: el as unknown as Element, calls }
}

describe('a row leaving the sidebar', () => {
  test('fades, and goes even when its animation never finishes', async () => {
    const r = row()
    let done = 0
    rowLeave(r.el, () => done++)
    expect(r.calls.length).toBe(2) // the fade, then the fold
    expect(done).toBe(0)
    await Bun.sleep(700)
    expect(done).toBe(1)
  })

  test('goes at once when a search or a filter hid it, and fades when it went by itself', async () => {
    const query = ref('')
    const leave = leaveUnlessFiltered([query])
    const hidden = row()
    let done = 0
    query.value = 'alpha'
    leave(hidden.el, () => done++) // Vue removes the hidden rows in the render right after the change
    expect(done).toBe(1)
    expect(hidden.calls.length).toBe(0)
    await nextTick()
    await Bun.sleep(5)
    const gone = row()
    leave(gone.el, () => {})
    expect(gone.calls.length).toBe(2)
  })
})
