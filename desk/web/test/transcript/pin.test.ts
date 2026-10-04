import { expect, test } from 'bun:test'
import { nextPinned } from '../../src/components/transcript/lib/pin'

const base = { pinned: true, top: 5000, lastTop: 5000, distance: 0, userDriven: false }

test('a layout-made upward move (rows measured shorter, then content grew) keeps a pinned chat pinned', () => {
  // scrollTop clamped from 5000 to 4400, then 300px of late content (history sync, an image) arrived
  expect(nextPinned({ ...base, top: 4400, distance: 300 })).toBe(true)
})

test('Jacob scrolling up lets go of the bottom', () => {
  expect(nextPinned({ ...base, top: 4000, distance: 900, userDriven: true })).toBe(false)
})

test('scrolling back near the bottom pins again, however it got there', () => {
  expect(nextPinned({ ...base, pinned: false, top: 5000, distance: 10 })).toBe(true)
})

test('an unpinned chat stays unpinned when the layout moves under it', () => {
  expect(nextPinned({ ...base, pinned: false, top: 2000, lastTop: 2000, distance: 3000 })).toBe(false)
})
