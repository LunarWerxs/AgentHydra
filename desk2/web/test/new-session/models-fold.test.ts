// The stats card's Models tab (foldModels in src/components/shell/stats.ts): the models of significance show,
// the rest wait behind one "+N more" row (owner, 2026-10-05: "it gets really, really long, 'cause we're
// using a lot of models").

import { expect, test } from 'bun:test'
import { foldModels } from '../../src/components/shell/stats'

/** Models 'Model A', 'Model B', ... with these sessions, most first. */
const models = (sessions: number[]) => sessions.map((n, i) => ({ label: `Model ${String.fromCharCode(65 + i)}`, sessions: n }))

const tiny = (count: number, sessions: number) => Array<number>(count).fill(sessions)

// [case, sessions per model, models shown, models folded, the folded ones' share]
const cases: [string, number[], number, number, number][] = [
  ['20 models, 14 of them under 1%: the six that matter, the 14 folded', [300, 200, 150, 100, 80, 50, ...tiny(14, 5)], 6, 14, 70 / 950],
  ['12 models of equal weight: never more than 8 shown', tiny(12, 10), 8, 4, 40 / 120],
  ['4 models, one at 1%: all 4, no fold', [50, 30, 19, 1], 4, 0, 0],
  ['one model at 99%: it alone, the rest folded', [990, ...tiny(10, 1)], 1, 10, 10 / 1000],
  ['7 models where one is left over: it shows rather than a "+1 more" row', [30, 25, 20, 10, 8, 6, 1], 7, 0, 0]
]

for (const [name, sessions, shown, folded, share] of cases)
  test(name, () => {
    const all = models(sessions)
    const fold = foldModels(all)
    expect(fold.shown.map((m) => m.label)).toEqual(all.slice(0, shown).map((m) => m.label))
    expect(fold.rest.length).toBe(folded)
    expect(fold.restShare).toBeCloseTo(share, 9)
  })
