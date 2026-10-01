// Where CliMayte starts a task so it can finish there (climayte-placement.ts).
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TASK_PCT,
  expectedCost,
  planFactor,
  projectedPct,
  waitsForRoom,
} from '../src/climayte-placement'

describe('projectedPct', () => {
  test('counts what running tasks still owe, once, and scales by the plan', () => {
    // An idle Pro account at 10%: a 25% task ends near 35%.
    expect(projectedPct({ sessionPct: 10 }, [], 25)).toBe(35)
    // Three 25% tasks just started there (the meter has not moved yet): a fourth ends at 110.
    const fresh = [25, 25, 25].map((expected) => ({ expected, startPct: 10 }))
    expect(projectedPct({ sessionPct: 10 }, fresh, 25)).toBe(110)
    // Later the meter reads 50: 40 of their 75 are spent and already in the reading.
    expect(projectedPct({ sessionPct: 50 }, fresh, 25)).toBe(110)
    // A Max 5x window holds five Pro windows.
    expect(projectedPct({ sessionPct: 10, planFactor: planFactor('Max 5×') }, fresh, 25)).toBe(30)
    // One 25% task running since 10%; another task that ended meanwhile spent 20 of the rise to 40.
    // The running one has spent 10 and still owes 15: a new 25% task ends near 80, not 65.
    const one = [{ expected: 25, startPct: 10 }]
    expect(projectedPct({ sessionPct: 40 }, one, 25, 20)).toBe(80)
  })
})

describe('expectedCost', () => {
  test('blends from the broadest record to the narrowest, by how many tasks each has', () => {
    const O = 'claude-opus-5-5'
    const S = 'claude-sonnet-5-5'
    const done = (kind: string, model: string, effort: string, pct: number, n = 1) =>
      Array.from({ length: n }, () => ({ kind, model, effort, pct }))
    const sonnetCode = { kind: 'code', model: S, effort: 'medium' }
    expect(expectedCost(sonnetCode, [])).toEqual({
      pct: DEFAULT_TASK_PCT,
      basis: 'default',
      samples: 0,
    })
    // Two Opus code tasks at 26: a Sonnet one is half that at a Sonnet token's weight, pulled toward
    // the default by two tasks' worth: (13 + 13 + 2 * 25) / 4.
    const opus = done('code', O, 'high', 26, 2)
    expect(expectedCost(sonnetCode, opus)).toMatchObject({ basis: 'kind', samples: 2 })
    expect(expectedCost(sonnetCode, opus).pct).toBeCloseTo(19, 6)
    // Three Sonnet medium code tasks at 5 (mobile-w10/m3c, 2026-10-01: 3.9, 4.6, 6.1 against an
    // estimate of 13.7): the estimate comes most of the way down to them, under 6.
    const three = expectedCost(sonnetCode, [...opus, ...done('code', S, 'medium', 5, 3)])
    expect(three).toMatchObject({ basis: 'setting', samples: 3 })
    expect(three.pct).toBeGreaterThan(5)
    expect(three.pct).toBeLessThan(6)
    // Twenty of them and the record is nearly all of it.
    expect(
      expectedCost(sonnetCode, [...opus, ...done('code', S, 'medium', 5, 20)]).pct,
    ).toBeCloseTo(5, 0)
  })
})

describe('waitsForRoom', () => {
  test('never holds a session going on at home, nor a task no window fits', () => {
    const chosen = { id: 'a', sessionPct: 80 }
    const placement = { expected: 40, running: new Map() }
    expect(waitsForRoom(chosen, placement, [1], false)).toBe(true)
    // Its own account has its conversation in a warm cache: it carries on there.
    expect(waitsForRoom(chosen, placement, [1], true)).toBe(false)
    // 150% fits no Pro window, so waiting would be for ever: it goes where the projection is lowest.
    expect(waitsForRoom(chosen, { ...placement, expected: 150 }, [1], false)).toBe(false)
  })
})
