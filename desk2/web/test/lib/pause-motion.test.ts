// The window holds its animations still while unfocused or hidden (src/lib/pause-motion.ts). No DOM here:
// a fake window and document carry the three facts it reads.

import { describe, expect, test } from 'bun:test'
import { PAUSED_CLASS, pauseMotionWhenAway } from '../../src/lib/pause-motion'

function page(state = { visible: true, focused: true }) {
  const on = new Set<string>()
  const listeners: Record<string, () => void> = {}
  const add = (type: string, fn: () => void) => void (listeners[type] = fn)
  const doc = {
    get visibilityState() {
      return state.visible ? 'visible' : 'hidden'
    },
    hasFocus: () => state.focused,
    documentElement: { classList: { toggle: (n: string, v: boolean) => (v ? on.add(n) : on.delete(n)) } },
    addEventListener: add,
  }
  pauseMotionWhenAway({ addEventListener: add }, doc)
  return { paused: () => on.has(PAUSED_CLASS), state, fire: (t: string) => listeners[t]?.() }
}

describe('pauseMotionWhenAway', () => {
  test('a focused, visible page keeps moving', () => expect(page().paused()).toBe(false))

  test('a page that starts unfocused starts paused', () => expect(page({ visible: true, focused: false }).paused()).toBe(true))

  test('blur pauses, focus resumes', () => {
    const p = page()
    p.state.focused = false
    p.fire('blur')
    expect(p.paused()).toBe(true)
    p.state.focused = true
    p.fire('focus')
    expect(p.paused()).toBe(false)
  })

  test('a hidden page stays paused even if it still has focus', () => {
    const p = page()
    p.state.visible = false
    p.fire('visibilitychange')
    expect(p.paused()).toBe(true)
    p.state.visible = true
    p.fire('visibilitychange')
    expect(p.paused()).toBe(false)
  })
})
