// CliMayte's scorecard: which model and thinking level each kind of task gets (climayte-scorecard.ts).
import { describe, expect, test } from 'bun:test'
import { type RunDefaults, runSetting } from '../src/climayte'
import {
  type CliMayteVerdict,
  HAIKU,
  nextRung,
  OPUS,
  pickConfig,
  SONNET,
  scoreOf,
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

describe('pickConfig on an Opus pick', () => {
  test("while the kind's best rung is Opus, every 2nd auto pick explores; on Sonnet every 4th", () => {
    // Owner, 2026-10-05: review sat on Opus high though Sonnet only had 2 verdicts.
    const rows = scoreRows([
      ...times(3, () => task('review', v('pass', OPUS, 'high'))),
      ...times(2, () => task('review', v('pass', SONNET, 'medium'))),
    ])
    const picks = [0, 1, 2, 3].map((i) => pickConfig('review', rows, i).config)
    expect(picks).toEqual([
      { model: OPUS, effort: 'high' },
      { model: HAIKU, effort: null },
      { model: OPUS, effort: 'high' },
      { model: HAIKU, effort: null },
    ])
    const sonnet = scoreRows(times(3, () => task('code', v('pass', SONNET, 'medium'))))
    expect([0, 1, 2, 3].map((i) => pickConfig('code', sonnet, i).config.model)).toEqual([
      SONNET,
      SONNET,
      SONNET,
      HAIKU,
    ])
  })
})

describe('runSetting: what a named model holds', () => {
  const defaults: RunDefaults = {
    auto: false,
    model: null,
    effort: null,
    why: null,
    ownerWords: null,
    kind: null,
    priority: 0,
  }
  // code's pick is Sonnet medium.
  const rows = scoreRows(times(3, () => task('code', v('pass', SONNET, 'medium'))))
  const set = (t: Record<string, unknown>) =>
    runSetting({ prompt: 'x', cwd: '.', kind: 'code', ...t }, defaults, rows, new Map())

  test('a modelWhy holds only a setting cheaper than the pick; ownerWords holds any', () => {
    const opus = set({ model: 'opus', modelWhy: 'a hard one' })
    expect(opus).toMatchObject({ auto: true, model: SONNET, effort: 'medium' })
    expect(opus.reason).toContain('claude-opus-5-5 was named but not held')

    const owner = set({ model: 'opus', ownerWords: 'use Opus for this' })
    expect(owner).toMatchObject({ auto: false, model: OPUS, effort: null })
    expect(owner.reason).toBe('named by the owner: "use Opus for this"')

    expect(set({ model: 'haiku', modelWhy: 'a rename' })).toMatchObject({
      auto: false,
      model: HAIKU,
    })
    // The pick itself is not cheaper than the pick.
    expect(set({ model: 'sonnet', effort: 'medium', modelWhy: 'same' }).auto).toBe(true)
  })

  test('an effort named alone ranks as Opus at that effort', () => {
    // review's pick is Opus high: Opus medium is cheaper, Opus xhigh is not.
    const opusRows = scoreRows(times(3, () => task('review', v('pass', OPUS, 'high'))))
    const review = (t: Record<string, unknown>) =>
      runSetting({ prompt: 'x', cwd: '.', kind: 'review', ...t }, defaults, opusRows, new Map())
    expect(review({ effort: 'medium', modelWhy: 'a light read' })).toMatchObject({
      auto: false,
      model: null,
      effort: 'medium',
    })
    expect(review({ effort: 'xhigh', modelWhy: 'a hard one' }).auto).toBe(true)
  })

  test("the run's ownerWords hold the run's setting, not one a task names itself", () => {
    const run: RunDefaults = { ...defaults, model: OPUS, ownerWords: 'Opus for this batch' }
    const held = runSetting({ prompt: 'x', cwd: '.', kind: 'code' }, run, rows, new Map())
    expect(held).toMatchObject({ auto: false, model: OPUS })
    const own = runSetting(
      { prompt: 'x', cwd: '.', kind: 'code', effort: 'max' },
      run,
      rows,
      new Map(),
    )
    expect(own).toMatchObject({ auto: true, model: SONNET, effort: 'medium' })
  })

  test('ownerWords is trimmed, quoted to 120 characters and refused past 2000, on a chat too', () => {
    const long = set({ model: 'opus', ownerWords: `  ${'w'.repeat(500)}  ` })
    expect(long.reason).toBe(`named by the owner: "${'w'.repeat(120)}"`)
    expect(() => set({ model: 'opus', ownerWords: 'w'.repeat(2001) })).toThrow('ownerWords')
    expect(() => set({ chat: true, ownerWords: 'w'.repeat(2001) })).toThrow('ownerWords')
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

describe('fail severity (owner, 2026-10-06: a whoopsie-daisy is not a catastrophic fail)', () => {
  const sev = (severity: 0 | 1 | 2 | 3 | undefined) =>
    task('code', v('fail', SONNET, 'medium', 100_000, severity === undefined ? {} : { severity }))
  const pass = () => task('code', v('pass', SONNET, 'medium'))
  const row = (...t: ReturnType<typeof task>[]) => scoreRows(t)[0]!

  test('credit is pass 1, slip 2/3, rework 1/3, failed 0; severity 0 is outside n and units', () => {
    const cases: Array<[string, ReturnType<typeof task>[], number | null, number]> = [
      ['slip', [pass(), sev(1)], (1 + 2 / 3) / 2, 200_000],
      ['rework', [pass(), sev(2)], (1 + 1 / 3) / 2, 200_000],
      ['failed', [pass(), sev(3)], 1 / 2, 200_000],
      ['no severity counts as 3', [pass(), sev(undefined)], 1 / 2, 200_000],
      ['severity 0 is not scored', [pass(), sev(0)], 1, 100_000],
      ['only severity 0: nothing scored', [sev(0)], null, 0],
    ]
    for (const [name, tasks, score, units] of cases) {
      const r = row(...tasks)
      expect([name, scoreOf(r), r.units]).toEqual([name, score, units])
    }
    const r = row(pass(), sev(0), sev(1), sev(2), sev(3), sev(undefined))
    expect([r.pass, r.fail, r.slip, r.rework, r.failed, r.excluded]).toEqual([1, 4, 1, 1, 2, 1])
  })

  test('a slip-heavy rung becomes trusted where all-full-fails would not', () => {
    // 2 passes and 4 slips: 33% as full fails (written off), 78% weighted (trusted, over the 70% bar).
    const make = (severity: 1 | 3) => [...times(2, pass), ...times(4, () => sev(severity))]
    expect(pickConfig('code', scoreRows(make(3)), 0).config).not.toEqual({
      model: SONNET,
      effort: 'medium',
    })
    const slips = scoreRows(make(1))
    const picked = pickConfig('code', slips, 0)
    expect(picked.config).toEqual({ model: SONNET, effort: 'medium' })
    expect(picked.reason).toContain('passed 2 of 6')
  })
})
