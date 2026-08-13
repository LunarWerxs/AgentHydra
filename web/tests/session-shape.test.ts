// web/src/lib/session-shape.ts — quick / standard / deep / marathon / automation.
//
// The interesting cases are the two where the axes DISAGREE, because taking the larger verdict is
// the whole design: a handful of messages spread over an afternoon is a long sitting, and hundreds
// of messages in ten minutes is a grind. A classifier that only counted messages would call the
// first one "quick", which is the description a reader would most obviously disagree with.

import { describe, expect, test } from 'bun:test'
import { sessionShape } from '../src/lib/session-shape'

const MIN = 60_000
const at = (messages: number, minutes: number | null, dispatched = false) =>
  sessionShape({
    message_count: messages,
    created_at: minutes === null ? null : 0,
    last_activity_at: (minutes ?? 0) * MIN,
    dispatched,
  })

describe('the ordinary cases', () => {
  test('a short exchange over a few minutes is quick', () => {
    expect(at(6, 3)).toBe('quick')
  })

  test('a normal working session is standard', () => {
    expect(at(120, 40)).toBe('standard')
  })

  test('a long build is deep', () => {
    expect(at(600, 200)).toBe('deep')
  })

  test('an all-day session is a marathon', () => {
    expect(at(1400, 600)).toBe('marathon')
  })
})

describe('when the two axes disagree, the larger verdict wins', () => {
  test('a handful of messages spread across a whole day is not quick', () => {
    expect(at(8, 600)).toBe('marathon')
  })

  test('a thousand messages in minutes is not quick either', () => {
    expect(at(1200, 8)).toBe('marathon')
  })

  test('a small count over a long sitting reads by the clock', () => {
    expect(at(30, 200)).toBe('deep')
  })
})

describe('the edges', () => {
  test('a queued run is automation, whatever its size', () => {
    expect(at(3, 1, true)).toBe('automation')
    expect(at(2000, 900, true)).toBe('automation')
  })

  test('a transcript with no start time is judged on messages alone', () => {
    expect(at(5, null)).toBe('quick')
    expect(at(1500, null)).toBe('marathon')
  })

  test('an empty session does not fall off the scale', () => {
    expect(at(0, 0)).toBe('quick')
  })
})
