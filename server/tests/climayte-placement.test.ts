// Where CliMayte starts a task so it can finish there (climayte-placement.ts).
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TASK_PCT,
  expectedPct,
  planFactor,
  projectedPct,
  waitsForRoom,
} from '../src/climayte-placement'
import { UNITS_PER_PRO_PERCENT } from '../src/climayte-scorecard'

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

describe('expectedPct', () => {
  test('the setting, else its kind on its model, else its kind scaled to its model, else the model family, else the default', () => {
    const row = (kind: string, model: string, effort: string, pct: number, n: number) => ({
      kind,
      model,
      effort,
      pass: n,
      fail: 0,
      units: pct * n * UNITS_PER_PRO_PERCENT,
    })
    const rows = [
      row('code', 'claude-opus-5-5', 'high', 26, 2),
      row('code', 'claude-sonnet-5-5', 'medium', 6, 1),
      row('sweep', 'claude-opus-5-5', 'high', 36, 3),
    ]
    const opusHigh = { kind: 'code', model: 'claude-opus-5-5', effort: 'high' }
    expect(expectedPct(opusHigh, rows, [])).toBe(26)
    expect(expectedPct({ ...opusHigh, effort: 'max' }, rows, [])).toBe(26)
    // Only Opus sweeps on record: a Sonnet one costs what they did at a Sonnet token's weight, half
    // (mobile-w9, 2026-10-01: sized at the Opus 36% before).
    const sonnetSweep = { kind: 'sweep', model: 'claude-sonnet-5-5', effort: 'medium' }
    expect(expectedPct(sonnetSweep, rows, [])).toBeCloseTo(18, 6)
    const finished = [{ model: 'claude-sonnet-5-5', pct: 4 }]
    expect(expectedPct({ ...sonnetSweep, kind: 'docs' }, rows, finished)).toBe(4)
    expect(expectedPct({ kind: null, model: null, effort: null }, rows, finished)).toBe(
      DEFAULT_TASK_PCT,
    )
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
