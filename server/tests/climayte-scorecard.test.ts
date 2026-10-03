// CliMayte's scorecard: which model and thinking level each kind of task gets (climayte-scorecard.ts).
import { describe, expect, test } from 'bun:test'
import {
  type CliMayteVerdict,
  HAIKU,
  nextRung,
  OPUS,
  pickConfig,
  SONNET,
  scoreRows,
} from '../src/climayte-scorecard'

const v = (
  verdict: 'pass' | 'fail',
  model: string,
  effort: string | null,
  units = 100_000,
  overrides?: Partial<CliMayteVerdict>,
): CliMayteVerdict => ({ at: 0, verdict, note: null, model, effort, units, ...overrides })
const task = (kind: string, ...verdicts: CliMayteVerdict[]) => ({ kind, verdicts })
const times = (n: number, make: () => ReturnType<typeof task>) => Array.from({ length: n }, make)

describe('pickConfig', () => {
  test('starts where the kind starts, then follows what passes and what fails', () => {
    // No verdicts: trivial starts on Haiku, a sweep and code on Sonnet medium, debug on Opus medium.
    expect(pickConfig('trivial', [], 0).config).toEqual({ model: HAIKU, effort: null })
    expect(pickConfig('sweep', [], 0).config).toEqual({ model: SONNET, effort: 'medium' })
    expect(pickConfig('code', [], 0).config).toEqual({ model: SONNET, effort: 'medium' })
    expect(pickConfig('debug', [], 0).config).toEqual({ model: OPUS, effort: 'medium' })
    expect(pickConfig('manage', [], 0).config).toEqual({ model: SONNET, effort: 'low' })

    // Sonnet high passed 3 of 3 code tasks: code moves to it.
    const high = times(3, () => task('code', v('pass', SONNET, 'high')))
    const cheap = scoreRows(high)
    expect(pickConfig('code', cheap, 0).config).toEqual({ model: SONNET, effort: 'high' })
    // Every 4th auto pick tries the cheapest rung still learning: Haiku first.
    expect(pickConfig('code', cheap, 3).config).toEqual({ model: HAIKU, effort: null })

    // ...the next one up once Haiku keeps failing (the CLI reports a dated Haiku id).
    const haikuBad = scoreRows([
      ...high,
      ...times(2, () => task('code', v('fail', `${HAIKU}-20251001`, null))),
    ])
    expect(pickConfig('code', haikuBad, 3).config).toEqual({ model: SONNET, effort: 'low' })

    // A start rung that keeps failing is stepped over: debug moves from Opus medium to Opus high.
    const startBad = scoreRows(times(2, () => task('debug', v('fail', OPUS, 'medium'))))
    expect(pickConfig('debug', startBad, 0).config).toEqual({ model: OPUS, effort: 'high' })
  })

  test('of the settings that pass reliably, the one that costs least per passed task wins', () => {
    // Owner, 2026-10-02: the cheapest model that reliably completes the task. Sonnet medium passing
    // 7 of 9 code tasks at a quarter of the quota beats Opus high passing every one; the first
    // version sent all code to Opus high, its 80% bar just above Sonnet medium's 78%.
    const rows = scoreRows([
      ...times(7, () => task('code', v('pass', SONNET, 'medium'))),
      ...times(2, () => task('code', v('fail', SONNET, 'medium'))),
      ...times(3, () => task('code', v('pass', OPUS, 'high', 400_000))),
    ])
    expect(pickConfig('code', rows, 0).config).toEqual({ model: SONNET, effort: 'medium' })
  })
})

describe('scoreRows', () => {
  test('skips provisional verdicts (piece 5: wave verdicts stay out until orchestrator confirms)', () => {
    // A provisional pass (by: 'wave') is skipped; a regular pass counts.
    const rows = scoreRows([
      task(
        'code',
        v('pass', SONNET, 'medium'),
        v('pass', SONNET, 'high', 100_000, { provisional: true, span: 5 }),
      ),
    ])
    // Only the non-provisional pass (Sonnet medium) counted.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        kind: 'code',
        model: SONNET,
        effort: 'medium',
        pass: 1,
        fail: 0,
      }),
    )
  })

  test('counts only the newest verdict per span of work: an orchestrator fail after a provisional wave pass leaves one fail', () => {
    // Same span (no attempt between them): the later verdict replaces the earlier one. A new span counts on its own.
    const rows = scoreRows([
      task(
        'code',
        v('pass', SONNET, 'medium', 100_000, { by: 'wave', provisional: true, span: 10 }),
        v('fail', SONNET, 'medium', 100_000, { by: 'orchestrator', span: 10 }),
        v('pass', OPUS, 'medium', 50_000, { by: 'check', span: 20 }),
      ),
    ])
    expect(rows.map((r) => [r.model, r.effort, r.pass, r.fail])).toEqual([
      [SONNET, 'medium', 0, 1],
      [OPUS, 'medium', 1, 0],
    ])
  })
})

describe('nextRung', () => {
  test('a failed result goes one rung up; the top has nowhere to go', () => {
    expect(nextRung({ model: HAIKU, effort: null })).toEqual({ model: SONNET, effort: 'low' })
    expect(nextRung({ model: SONNET, effort: 'high' })).toEqual({ model: OPUS, effort: 'medium' })
    expect(nextRung({ model: OPUS, effort: 'max' })).toBeNull()
    // The CLI's own default (no model or effort asked for) counts as Opus high.
    expect(nextRung({ model: null, effort: null })).toEqual({ model: OPUS, effort: 'xhigh' })
  })
})
