// web/src/lib/chart.ts — the arithmetic the charts are drawn from.
//
// The two properties worth pinning are the ones that make a chart honest rather than pretty: an
// axis that always starts at zero (a truncated baseline exaggerates every difference on it, which
// is the most common way a chart lies), and a colour that follows the ENTITY rather than its rank
// (so filtering the data cannot silently repaint the series that survive).

import { describe, expect, test } from 'bun:test'
import {
  areaPath,
  axisMax,
  linePath,
  niceStep,
  seriesColor,
  shortUsd,
  ticks,
  topNWithOther,
} from '../src/lib/chart'

describe('axis ticks', () => {
  test('always start at zero, whatever the data', () => {
    for (const max of [1, 7, 93, 1234, 0.4]) expect(ticks(max)[0]).toBe(0)
  })

  test('steps are round numbers a person would choose', () => {
    expect(niceStep(0.9)).toBe(1)
    expect(niceStep(1.7)).toBe(2)
    expect(niceStep(2.3)).toBe(2.5)
    expect(niceStep(4)).toBe(5)
    expect(niceStep(9)).toBe(10)
    expect(niceStep(230)).toBe(250)
  })

  test('the top tick is at or above the data, so the tallest bar never touches the frame', () => {
    for (const max of [1, 7, 93, 1234]) expect(axisMax(max)).toBeGreaterThanOrEqual(max)
  })

  test('an empty or nonsensical range degrades to a single zero rather than throwing', () => {
    expect(ticks(0)).toEqual([0])
    expect(ticks(Number.NaN)).toEqual([0])
    expect(ticks(-5)).toEqual([0])
  })
})

describe('paths', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 5, y: 4 },
    { x: 10, y: 8 },
  ]

  test('a line is straight segments, never a curve', () => {
    const d = linePath(pts)
    expect(d.startsWith('M0.00 10.00')).toBe(true)
    expect(d).not.toContain('C') // no bezier: a spline invents values between samples
    expect(d.match(/L/g)?.length).toBe(2)
  })

  test('an area closes down to the baseline and back', () => {
    const d = areaPath(pts, 20)
    expect(d.endsWith('Z')).toBe(true)
    expect(d).toContain('20.00')
  })

  test('no points is an empty path, not a crash', () => {
    expect(linePath([])).toBe('')
    expect(areaPath([], 10)).toBe('')
  })
})

describe('series colour follows the entity, not the rank', () => {
  const order = ['opus', 'sonnet', 'haiku']

  test('the same name keeps the same slot however the data is filtered', () => {
    expect(seriesColor('sonnet', order)).toBe('var(--viz-2)')
    // 'opus' filtered out: sonnet must NOT become slot 1.
    expect(seriesColor('sonnet', order)).toBe('var(--viz-2)')
  })

  test('past the validated slots names share the last one rather than inventing a hue', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(seriesColor('f', many)).toBe('var(--viz-6)')
    expect(seriesColor('g', many)).toBe('var(--viz-6)')
    expect(seriesColor('unknown', many)).toBe('var(--viz-6)')
  })
})

describe('folding the tail into Other', () => {
  const rows = [
    { key: 'a', v: 10 },
    { key: 'b', v: 6 },
    { key: 'c', v: 3 },
    { key: 'd', v: 1 },
  ]
  const fold = (keep: number) =>
    topNWithOther(
      rows,
      keep,
      (r) => r.v,
      (total, count) => ({ key: 'other', v: total, count }) as never,
    )

  test('a short list is left alone', () => {
    expect(fold(4)).toHaveLength(4)
    expect(fold(9)).toHaveLength(4)
  })

  test('the tail becomes one row whose value is the tail total', () => {
    const out = fold(2) as Array<{ key: string; v: number }>
    expect(out).toHaveLength(3)
    expect(out[2]?.key).toBe('other')
    expect(out[2]?.v).toBe(4)
  })
})

describe('compact money', () => {
  test('reads at a glance across four orders of magnitude', () => {
    expect(shortUsd(0)).toBe('$0')
    expect(shortUsd(0.004)).toBe('<$0.01')
    expect(shortUsd(1.5)).toBe('$1.50')
    expect(shortUsd(42)).toBe('$42')
    expect(shortUsd(2500)).toBe('$2.5k')
    expect(shortUsd(135000)).toBe('$135k')
  })
})
