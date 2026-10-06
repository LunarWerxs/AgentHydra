// The window holds its animations still while unfocused or hidden (src/lib/pause-motion.ts). No DOM here:
// a fake window and document carry the three facts it reads.

import { describe, expect, test } from 'bun:test'
import { PAUSED_CLASS, pauseMotionWhenAway } from '../src/lib/pause-motion'

function page(state = { visible: true, focused: true, topFocused: true }, framed = false) {
  const on = new Set<string>()
  const listeners: Record<string, () => void> = {}
  const add = (type: string, fn: () => void) => {
    listeners[type] = fn
  }
  const doc = {
    get visibilityState() {
      return state.visible ? 'visible' : 'hidden'
    },
    hasFocus: () => state.focused,
    documentElement: {
      classList: { toggle: (n: string, v: boolean) => (v ? on.add(n) : on.delete(n)) },
    },
    addEventListener: add,
  }
  const topListeners: Record<string, () => void> = {}
  const top = {
    addEventListener: (t: string, fn: () => void) => {
      topListeners[t] = fn
    },
    document: { hasFocus: () => state.topFocused },
  }
  pauseMotionWhenAway(framed ? { addEventListener: add, top } : { addEventListener: add }, doc)
  return {
    paused: () => on.has(PAUSED_CLASS),
    state,
    fire: (t: string) => listeners[t]?.(),
    fireTop: (t: string) => topListeners[t]?.(),
  }
}

describe('pauseMotionWhenAway', () => {
  test('a focused, visible page keeps moving', () => expect(page().paused()).toBe(false))

  test('a page that starts unfocused starts paused', () =>
    expect(page({ visible: true, focused: false, topFocused: false }).paused()).toBe(true))

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

  test('in a frame the top page decides: an unfocused frame under a focused top keeps moving', () => {
    const p = page({ visible: true, focused: false, topFocused: true }, true)
    expect(p.paused()).toBe(false)
    p.state.topFocused = false
    p.fireTop('blur')
    expect(p.paused()).toBe(true)
  })
})
