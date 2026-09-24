// web/src/lib/format.ts — the working/idle/stale dot on a session row.
//
// The only thing available is when the transcript was last written, so the dot is a claim about
// FILE ACTIVITY, not about whether a human is present. These pin the boundaries so a change to them
// is deliberate: the point of the dot is telling "someone is in this right now" from "this has been
// sitting for a week", and thresholds that drift quietly stop doing that.

import { describe, expect, test } from 'bun:test'
import { sessionActivity } from '../src/lib/format'

const NOW = 1_786_600_000_000
const ago = (ms: number) => sessionActivity(NOW - ms, NOW)

describe('session activity', () => {
  test('a turn in the last couple of minutes reads as working', () => {
    expect(ago(0)).toBe('working')
    expect(ago(90_000)).toBe('working')
  })

  // The boundaries themselves (2 min, 60 min) fall on the quieter side.
  test.each([
    ['within the hour is idle, not working', 3 * 60_000, 'idle'],
    ['within the hour is idle, not working', 59 * 60_000, 'idle'],
    ['the 2-minute boundary is already idle', 2 * 60_000, 'idle'],
    ['past an hour is stale', 61 * 60_000, 'stale'],
    ['past an hour is stale', 9 * 24 * 60 * 60_000, 'stale'],
    ['the 60-minute boundary is already stale', 60 * 60_000, 'stale'],
  ] as const)('%s (%d ms ago)', (_case, ms, activity) => {
    expect(ago(ms)).toBe(activity)
  })

  test('a clock skewed into the future does not read as stale', () => {
    // A transcript written by another machine, or a clock adjustment, can be slightly ahead. The
    // honest answer there is "just now", never "abandoned".
    expect(ago(-5000)).toBe('working')
  })
})
