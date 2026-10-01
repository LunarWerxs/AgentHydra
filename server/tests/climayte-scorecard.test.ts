// CliMayte's scorecard: which model and thinking level each kind of task gets (climayte-scorecard.ts).
import { describe, expect, test } from 'bun:test'
import { type CliMayteVerdict, nextRung, pickConfig, scoreRows } from '../src/climayte-scorecard'

const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const v = (verdict: 'pass' | 'fail', model: string, effort: string): CliMayteVerdict => ({
  at: 0,
  verdict,
  note: null,
  model,
  effort,
  units: 100_000,
})
const task = (kind: string, ...verdicts: CliMayteVerdict[]) => ({ kind, verdicts })

describe('pickConfig', () => {
  test('starts where the kind starts, then follows what passes and what fails', () => {
    // No verdicts: a sweep starts on Sonnet medium, code on Opus high.
    expect(pickConfig('sweep', [], 0).config).toEqual({ model: SONNET, effort: 'medium' })
    expect(pickConfig('code', [], 0).config).toEqual({ model: OPUS, effort: 'high' })

    // Sonnet high passed 3 of 3 code tasks: code moves down to it.
    const cheap = scoreRows([
      task('code', v('pass', SONNET, 'high')),
      task('code', v('pass', SONNET, 'high')),
      task('code', v('pass', SONNET, 'high')),
    ])
    expect(pickConfig('code', cheap, 0).config).toEqual({ model: SONNET, effort: 'high' })
    // Every 4th auto pick tries one rung cheaper, to keep learning.
    expect(pickConfig('code', cheap, 3).config).toEqual({ model: SONNET, effort: 'medium' })

    // ...unless that rung keeps failing.
    const medBad = scoreRows([
      ...[0, 1, 2].map(() => task('code', v('pass', SONNET, 'high'))),
      task('code', v('fail', SONNET, 'medium')),
      task('code', v('fail', SONNET, 'medium')),
    ])
    expect(pickConfig('code', medBad, 3).config).toEqual({ model: SONNET, effort: 'high' })

    // A start rung that keeps failing is stepped over: debug starts on Opus xhigh.
    const startBad = scoreRows([
      task('debug', v('fail', OPUS, 'xhigh')),
      task('debug', v('fail', OPUS, 'xhigh')),
    ])
    expect(pickConfig('debug', startBad, 0).config).toEqual({ model: OPUS, effort: 'max' })
  })
})

describe('nextRung', () => {
  test('a failed result goes one rung up; the top has nowhere to go', () => {
    expect(nextRung({ model: SONNET, effort: 'high' })).toEqual({ model: OPUS, effort: 'medium' })
    expect(nextRung({ model: OPUS, effort: 'max' })).toBeNull()
    // The CLI's own default (no model or effort asked for) counts as Opus high.
    expect(nextRung({ model: null, effort: null })).toEqual({ model: OPUS, effort: 'xhigh' })
  })
})
