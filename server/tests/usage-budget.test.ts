// server/tests/usage-budget.test.ts — the agent-readable summary line (server/src/usage-budget.ts).
//
// buildUsageBudget() reads history off disk, so only the pure budgetSummary() is exercised here;
// UsageBudget objects are constructed by hand instead of going through the disk-backed builder.
//
// budgetSummary keys off `burnPctPerHourUpper` (never `burnPctPerHour`) to decide whether there is a
// burn signal to report at all, and every "will I hit the cap" phrase is worded against the pessimistic
// upper bound — see server/src/usage-history.ts for why a point estimate of 0 must never read as
// "definitely safe".

import { describe, expect, test } from 'bun:test'
import type { TokenSpend, UsageBudget, UsageForecast } from '../src/types'
import { budgetSummary } from '../src/usage-budget'

const EMPTY_SPEND: TokenSpend = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  raw: 0,
  weighted: 0,
  turns: 0,
  byModel: {},
}

const NULL_FORECAST: UsageForecast = {
  burnPctPerHour: null,
  burnPctPerHourUpper: null,
  remainingPct: null,
  headroomHours: null,
  exhaustsAt: null,
  hoursToReset: null,
  exhaustsBeforeReset: null,
  samples: 0,
}

const mkBudget = (overrides: Partial<UsageBudget> = {}): UsageBudget => ({
  forecast: NULL_FORECAST,
  spend: EMPTY_SPEND,
  lookbackHours: 6,
  weightedPerHour: null,
  weightedPerPercent: null,
  remainingWeighted: null,
  remainingTurns: null,
  weightedPerTurn: null,
  confidence: 'none',
  caveat: 'test caveat',
  ...overrides,
})

describe('budgetSummary', () => {
  test('says "work freely" when exhaustsBeforeReset is false (burning, but reset wins)', () => {
    const budget = mkBudget({
      forecast: {
        ...NULL_FORECAST,
        burnPctPerHour: 2,
        burnPctPerHourUpper: 2.5,
        remainingPct: 50,
        headroomHours: 25,
        exhaustsAt: '2024-07-15T03:00:00.000Z',
        hoursToReset: 5,
        exhaustsBeforeReset: false,
        samples: 10,
      },
    })
    const summary = budgetSummary(budget, 50)
    expect(summary).toContain('Weekly (all models): 50% used.')
    expect(summary).toContain('Burning ~2.00%/hour (at most 2.50%/hour).')
    expect(summary).toContain(
      'Even at the worst rate consistent with the readings you will NOT hit the cap before it resets in 5.0h. Work freely.',
    )
  })

  test('says it WILL hit the cap (worst case) and gives the headroom hours when exhaustsBeforeReset is true', () => {
    const budget = mkBudget({
      forecast: {
        ...NULL_FORECAST,
        burnPctPerHour: 5,
        burnPctPerHourUpper: 6,
        remainingPct: 15,
        headroomHours: 3,
        exhaustsAt: '2024-07-14T05:00:00.000Z',
        hoursToReset: 10,
        exhaustsBeforeReset: true,
        samples: 10,
      },
    })
    const summary = budgetSummary(budget, 85)
    expect(summary).toContain('Weekly (all models): 85% used.')
    expect(summary).toContain('Burning ~5.00%/hour (at most 6.00%/hour).')
    expect(summary).toContain(
      'Worst case you hit the cap in ~3.0h, before it resets in 10.0h. Plan around it.',
    )
    expect(summary).not.toContain('Work freely')
  })

  test('includes the "~N more assistant turns" phrase when remainingTurns is non-null', () => {
    const budget = mkBudget({
      remainingTurns: 42,
      spend: { ...EMPTY_SPEND, turns: 7 },
      lookbackHours: 6,
      confidence: 'rough',
    })
    const summary = budgetSummary(budget, null)
    expect(summary).toContain('~42 more assistant turns')
    expect(summary).toContain('measured over 7 turns in the last 6h')
    expect(summary).toContain('Confidence: rough')
  })

  test('point-burn of 0 reads "below what these readings can resolve", not "not burning"', () => {
    const budget = mkBudget({
      forecast: {
        ...NULL_FORECAST,
        burnPctPerHour: 0,
        burnPctPerHourUpper: 0.5,
        remainingPct: 70,
        headroomHours: 140,
        hoursToReset: 5, // imminent reset -> genuinely safe despite the slow/unresolved burn
        exhaustsBeforeReset: false,
        samples: 3,
      },
    })
    const summary = budgetSummary(budget, 30)
    expect(summary).toContain('Burn is below what these readings can resolve (under 0.50%/hour).')
    expect(summary).not.toContain('Not burning quota right now')
  })

  // REGRESSION: this is the wording-level guard for the false-"work freely" bug. A point estimate of
  // 0 must NOT be rendered as a blanket "safe" message — when the upper-bound math says the cap is
  // reachable before the reset, the summary must say so, even though burnPctPerHour reads 0.
  test('REGRESSION: point-burn 0 near the cap still renders "Plan around it", never "Work freely"', () => {
    const budget = mkBudget({
      forecast: {
        ...NULL_FORECAST,
        burnPctPerHour: 0,
        burnPctPerHourUpper: 0.5,
        remainingPct: 2,
        headroomHours: 4,
        exhaustsAt: '2024-07-14T06:00:00.000Z',
        hoursToReset: 100,
        exhaustsBeforeReset: true,
        samples: 8,
      },
    })
    const summary = budgetSummary(budget, 98)
    expect(summary).toContain('Weekly (all models): 98% used.')
    expect(summary).toContain('Burn is below what these readings can resolve (under 0.50%/hour).')
    expect(summary).toContain(
      'Worst case you hit the cap in ~4.0h, before it resets in 100.0h. Plan around it.',
    )
    expect(summary).not.toContain('Work freely')
  })

  test('handles the all-null / no-data budget without crashing', () => {
    const budget = mkBudget() // every default field null/none
    expect(() => budgetSummary(budget, null)).not.toThrow()
    const summary = budgetSummary(budget, null)
    expect(summary).toBe('') // nothing to say: no pct, no burn signal, no turn estimate
  })

  test('pct is rendered even with an otherwise all-null forecast', () => {
    const budget = mkBudget()
    const summary = budgetSummary(budget, 12)
    expect(summary).toBe('Weekly (all models): 12% used.')
  })
})
