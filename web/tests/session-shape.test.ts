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
  test.each([
    ['a short exchange over a few minutes is quick', 6, 3, 'quick'],
    ['a normal working session is standard', 120, 40, 'standard'],
    ['a long build is deep', 600, 200, 'deep'],
    ['an all-day session is a marathon', 1400, 600, 'marathon'],
  ] as const)('%s', (_case, messages, minutes, shape) => {
    expect(at(messages, minutes)).toBe(shape)
  })
})

describe('when the two axes disagree, the larger verdict wins', () => {
  test.each([
    ['a handful of messages spread across a whole day is not quick', 8, 600, 'marathon'],
    ['a thousand messages in minutes is not quick either', 1200, 8, 'marathon'],
    ['a small count over a long sitting reads by the clock', 30, 200, 'deep'],
  ] as const)('%s', (_case, messages, minutes, shape) => {
    expect(at(messages, minutes)).toBe(shape)
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
