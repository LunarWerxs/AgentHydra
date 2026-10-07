// CliMayte's scorecard: which model and thinking level each kind of task gets (climayte-scorecard.ts).
import { describe, expect, test } from 'bun:test'
import { type RunDefaults, runSetting } from '../src/climayte'
import {
  bestRungPastHaiku,
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
/** Both Haiku rungs written off for `kind`: two fails on each. */
const haikuOut = (kind: string) => [
  ...times(2, () => task(kind, v('fail', HAIKU, 'medium'))),
  ...times(2, () => task(kind, v('fail', HAIKU, 'high'))),
]

describe('pickConfig', () => {
  test('starts on Haiku medium, then follows what passes and what fails', () => {
    // No verdicts: every kind starts on Haiku 5.5 medium (owner, 2026-10-07).
    for (const kind of ['trivial', 'code', 'debug', 'manage'] as const)
      expect(pickConfig(kind, [], 0).config).toEqual({ model: HAIKU, effort: 'medium' })
    // Fails on Haiku 4.5 judged another model: they leave Haiku 5.5's start alone.
    const old = scoreRows(
      times(2, () => task('code', v('fail', 'claude-haiku-4-5-20251001', null))),
    )
    expect(pickConfig('code', old, 0).config).toEqual({ model: HAIKU, effort: 'medium' })

    // Haiku medium keeps failing (the CLI reports a dated id, no effort counts as medium): Haiku
    // high is next; with both written off each kind goes where it started before Haiku 5.5.
    const mediumBad = scoreRows(times(2, () => task('code', v('fail', `${HAIKU}-20261007`, null))))
    expect(pickConfig('code', mediumBad, 0).config).toEqual({ model: HAIKU, effort: 'high' })
    expect(pickConfig('code', scoreRows(haikuOut('code')), 0).config).toEqual({
      model: SONNET,
      effort: 'medium',
    })
    expect(pickConfig('manage', scoreRows(haikuOut('manage')), 0).config).toEqual({
      model: SONNET,
      effort: 'low',
    })

    // Sonnet high passed 3 of 3 code tasks: code moves to it, and every 4th auto pick tries the
    // cheapest rung still learning.
    const high = [...haikuOut('code'), ...times(3, () => task('code', v('pass', SONNET, 'high')))]
    const cheap = scoreRows(high)
    expect(pickConfig('code', cheap, 0).config).toEqual({ model: SONNET, effort: 'high' })
    expect(pickConfig('code', cheap, 3).config).toEqual({ model: SONNET, effort: 'low' })

    // A start rung that keeps failing is stepped over: debug moves from Opus medium to Opus high.
    const startBad = scoreRows([
      ...haikuOut('debug'),
      ...times(2, () => task('debug', v('fail', OPUS, 'medium'))),
    ])
    expect(pickConfig('debug', startBad, 0).config).toEqual({ model: OPUS, effort: 'high' })
  })

  test('while Haiku medium is learning every auto pick tries it; written off, picks return', () => {
    // Owner, 2026-10-07: things should start "attempting to offload there first". A trusted
    // Sonnet medium and no Haiku verdicts: every pick, not every 4th, goes to Haiku medium.
    const sonnet = times(3, () => task('code', v('pass', SONNET, 'medium')))
    const learning = [0, 1, 2, 3].map((i) => pickConfig('code', scoreRows(sonnet), i))
    expect(learning.map((p) => p.config)).toEqual(Array(4).fill({ model: HAIKU, effort: 'medium' }))
    expect(learning[0]?.reason).toBe(
      'trying Haiku medium first (Haiku 5.5), cheaper than Sonnet medium, for code',
    )
    // Two Haiku medium fails write it off: picks go back to Sonnet medium, and only the every-4th
    // exploring pick still tries the next Haiku rung.
    const out = scoreRows([...sonnet, ...times(2, () => task('code', v('fail', HAIKU, 'medium')))])
    expect([0, 1, 2, 3].map((i) => pickConfig('code', out, i).config)).toEqual([
      { model: SONNET, effort: 'medium' },
      { model: SONNET, effort: 'medium' },
      { model: SONNET, effort: 'medium' },
      { model: HAIKU, effort: 'high' },
    ])
    // Both Haiku rungs at 2 of 3, between the bars: the every-pick trial is over, picks go back to
    // Sonnet medium (it never takes every pick of the kind for good).
    const between = scoreRows([
      ...sonnet,
      ...['medium', 'high'].flatMap((effort) => [
        ...times(2, () => task('code', v('pass', HAIKU, effort))),
        task('code', v('fail', HAIKU, effort)),
      ]),
    ])
    expect([0, 1, 2].map((i) => pickConfig('code', between, i).config)).toEqual(
      Array(3).fill({ model: SONNET, effort: 'medium' }),
    )
  })

  test('of the settings that pass reliably, the one that costs least per passed task wins', () => {
    // Owner, 2026-10-02: the cheapest model that reliably completes the task. Sonnet medium passing
    // 7 of 9 code tasks at a quarter of the quota beats Opus high passing every one; the first
    // version sent all code to Opus high, its 80% bar just above Sonnet medium's 78%.
    const rows = scoreRows([
      ...haikuOut('code'),
      ...times(7, () => task('code', v('pass', SONNET, 'medium'))),
      ...times(2, () => task('code', v('fail', SONNET, 'medium'))),
      ...times(3, () => task('code', v('pass', OPUS, 'high', 400_000))),
    ])
    expect(pickConfig('code', rows, 0).config).toEqual({ model: SONNET, effort: 'medium' })
  })
})

describe('pickConfig on an Opus pick', () => {
  test("while the kind's best rung is Opus, every 2nd auto pick explores; on Sonnet every 4th", () => {
    // Owner, 2026-10-05: review sat on Opus high though Sonnet only had 2 verdicts. Haiku is
    // written off here, so the cadence is the exploring one, not the Haiku trial.
    const rows = scoreRows([
      ...haikuOut('review'),
      ...times(3, () => task('review', v('pass', OPUS, 'high'))),
      ...times(2, () => task('review', v('pass', SONNET, 'medium'))),
    ])
    const picks = [0, 1, 2, 3].map((i) => pickConfig('review', rows, i).config)
    expect(picks).toEqual([
      { model: OPUS, effort: 'high' },
      { model: SONNET, effort: 'low' },
      { model: OPUS, effort: 'high' },
      { model: SONNET, effort: 'low' },
    ])
    const sonnet = scoreRows([
      ...haikuOut('code'),
      ...times(3, () => task('code', v('pass', SONNET, 'medium'))),
    ])
    expect([0, 1, 2, 3].map((i) => pickConfig('code', sonnet, i).config)).toEqual([
      { model: SONNET, effort: 'medium' },
      { model: SONNET, effort: 'medium' },
      { model: SONNET, effort: 'medium' },
      { model: SONNET, effort: 'low' },
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
  // code's pick is Sonnet medium (Haiku written off, so no Haiku trial).
  const rows = scoreRows([
    ...haikuOut('code'),
    ...times(3, () => task('code', v('pass', SONNET, 'medium'))),
  ])
  const set = (t: Record<string, unknown>) =>
    runSetting({ prompt: 'x', cwd: '.', kind: 'code', ...t }, defaults, rows, new Map())

  test('a modelWhy holds only a setting cheaper than the pick; ownerWords holds any', () => {
    const opus = set({ model: 'opus', modelWhy: 'a hard one' })
    expect(opus).toMatchObject({ auto: true, model: SONNET, effort: 'medium' })
    expect(opus.reason).toContain('claude-opus-5-5 was named but not held')

    const owner = set({ model: 'opus', ownerWords: 'use Opus for this' })
    expect(owner).toMatchObject({ auto: false, model: OPUS, effort: null })
    expect(owner.reason).toBe('named by the owner: "use Opus for this"')

    // A Haiku named with no effort runs at medium.
    expect(set({ model: 'haiku', modelWhy: 'a rename' })).toMatchObject({
      auto: false,
      model: HAIKU,
      effort: 'medium',
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

  test('a sealed task holds the setting it names, through a Haiku trial too, and is no kind sample', () => {
    const sealed = {
      systemPromptFile: 'C:/Users/me/visit/system.md',
      mcpConfig: 'C:/Users/me/visit/mcp.json',
      allowedTools: ['mcp__visit-hands__*'],
    }
    const visit = (t: Record<string, unknown>, onRows = rows) =>
      runSetting({ prompt: 'x', cwd: '.', sealed, ...t }, defaults, onRows, new Map())
    // Sonnet (at the CLI's high) is above code's Sonnet medium pick: a modelWhy alone held nothing.
    const held = visit({ model: 'sonnet', modelWhy: 'visitors run on Sonnet' })
    expect(held).toMatchObject({ auto: false, model: SONNET, effort: null, kind: null })
    expect(held.reason).toBe('named by a sealed task: visitors run on Sonnet')
    // With no verdicts at all, code's pick is a Haiku trial; the sealed task still runs what it named.
    expect(visit({ model: 'sonnet' }, scoreRows([]))).toMatchObject({ auto: false, model: SONNET })
    // A sealed task that names nothing is still the scorecard's, and an ordinary task is unchanged.
    expect(visit({}).auto).toBe(true)
    expect(set({ model: 'sonnet', modelWhy: 'visitors run on Sonnet' }).auto).toBe(true)
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
    // Haiku 5.5 with no effort ran at medium.
    expect(nextRung({ model: HAIKU, effort: null })).toEqual({ model: HAIKU, effort: 'high' })
    expect(nextRung({ model: HAIKU, effort: 'high' })).toEqual({ model: SONNET, effort: 'low' })
    expect(nextRung({ model: SONNET, effort: 'high' })).toEqual({ model: OPUS, effort: 'medium' })
    expect(nextRung({ model: OPUS, effort: 'max' })).toBeNull()
    // The CLI's own default (no model or effort asked for) counts as Opus high.
    expect(nextRung({ model: null, effort: null })).toEqual({ model: OPUS, effort: 'xhigh' })
  })

  test('a failed Haiku trial goes back on the setting its kind would have run without it', () => {
    // As sendBack climbs: the floor is the kind's rung without the Haiku trial.
    const failed = { model: HAIKU, effort: 'medium' }
    const sonnet = scoreRows([
      ...times(3, () => task('code', v('pass', SONNET, 'medium'))),
      task('code', v('fail', HAIKU, 'medium')),
    ])
    expect(nextRung(failed, bestRungPastHaiku('code', sonnet))).toEqual({
      model: SONNET,
      effort: 'medium',
    })
    // Nothing on record: the start the kind had before Haiku 5.5.
    expect(nextRung(failed, bestRungPastHaiku('debug', []))).toEqual({
      model: OPUS,
      effort: 'medium',
    })
    // A kind whose trusted rung is Haiku medium itself climbs one rung.
    const haiku = scoreRows(times(3, () => task('trivial', v('pass', HAIKU, 'medium'))))
    expect(nextRung(failed, bestRungPastHaiku('trivial', haiku))).toEqual({
      model: HAIKU,
      effort: 'high',
    })
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
    const make = (severity: 1 | 3) => [
      ...haikuOut('code'),
      ...times(2, pass),
      ...times(4, () => sev(severity)),
    ]
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
