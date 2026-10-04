import { describe, expect, it } from 'bun:test'
import { holdFocus } from '@/lib/hold-focus'

// A box that counts how often it was focused; `later` runs at once instead of on the next frame.
function box() {
  const el = Object.assign(new EventTarget(), { focused: 0, isConnected: true, focus: () => el.focused++ })
  return el
}
const now = (fn: () => void) => fn()

describe('a new session keeps the caret in its box', () => {
  it('takes focus back from a closing menu, but not from the user', () => {
    const el = box()
    const doc = new EventTarget()
    holdFocus(el, doc, 1000, now)
    expect(el.focused).toBe(1)
    // The menu that opened the session hands focus back to its trigger after its exit animation.
    doc.dispatchEvent(new Event('focusin'))
    expect(el.focused).toBe(2)
    // The user clicks elsewhere: that move stands.
    doc.dispatchEvent(new Event('pointerdown'))
    doc.dispatchEvent(new Event('focusin'))
    expect(el.focused).toBe(2)
  })
})
