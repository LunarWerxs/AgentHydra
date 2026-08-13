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

  test('within the hour is idle, not working', () => {
    expect(ago(3 * 60_000)).toBe('idle')
    expect(ago(59 * 60_000)).toBe('idle')
  })

  test('past an hour is stale', () => {
    expect(ago(61 * 60_000)).toBe('stale')
    expect(ago(9 * 24 * 60 * 60_000)).toBe('stale')
  })

  test('the boundaries themselves fall on the quieter side', () => {
    expect(ago(2 * 60_000)).toBe('idle')
    expect(ago(60 * 60_000)).toBe('stale')
  })

  test('a clock skewed into the future does not read as stale', () => {
    // A transcript written by another machine, or a clock adjustment, can be slightly ahead. The
    // honest answer there is "just now", never "abandoned".
    expect(ago(-5000)).toBe('working')
  })
})
