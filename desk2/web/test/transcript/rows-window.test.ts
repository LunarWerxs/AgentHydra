import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '../../../shared/protocol'
import { buildRows } from '../../src/components/transcript/lib/rows'
import { prefixOffsets, rowAt, visibleRange } from '../../src/components/transcript/lib/window'

const tool = (id: string, name: string, parent?: string): TranscriptItem => ({
  id,
  ts: 0,
  kind: 'tool_use',
  name,
  input: {},
  status: 'running',
  startedAt: 0,
  parentToolUseId: parent,
})

describe('buildRows', () => {
  test('sub-agent items nest under their Agent/Task card, recursively', () => {
    const items = [tool('a', 'Agent'), tool('a1', 'Read', 'a'), tool('t', 'Task', 'a'), tool('t1', 'Bash', 't'), tool('b', 'Bash')]
    const r = buildRows(items)
    expect(r.top.map((i) => i.id)).toEqual(['a', 'b'])
    expect(r.children.get('a')!.map((i) => i.id)).toEqual(['a1', 't'])
    expect(r.children.get('t')!.map((i) => i.id)).toEqual(['t1'])
  })

  test('an item whose parent is missing or not an agent stays visible at the top level', () => {
    const r = buildRows([tool('x', 'Read', 'gone'), tool('b', 'Bash'), tool('y', 'Read', 'b')])
    expect(r.top.map((i) => i.id)).toEqual(['x', 'b', 'y'])
  })
})

describe('windowing', () => {
  const offsets = prefixOffsets([10, 20, 30, 40])

  test('prefix offsets end at the total height', () => {
    expect([...offsets]).toEqual([0, 10, 30, 60, 100])
  })

  test('rowAt finds the row containing y', () => {
    expect(rowAt(offsets, 0)).toBe(0)
    expect(rowAt(offsets, 9.9)).toBe(0)
    expect(rowAt(offsets, 10)).toBe(1)
    expect(rowAt(offsets, 59)).toBe(2)
    expect(rowAt(offsets, 1000)).toBe(3)
  })

  test('visibleRange covers the viewport plus overscan', () => {
    expect(visibleRange(offsets, 30, 20, 0)).toEqual({ start: 2, end: 3 })
    expect(visibleRange(offsets, 30, 40, 0)).toEqual({ start: 2, end: 4 })
    expect(visibleRange(offsets, 0, 5, 0)).toEqual({ start: 0, end: 1 })
    expect(visibleRange(prefixOffsets([]), 0, 100)).toEqual({ start: 0, end: 0 })
  })

  test('3,000 rows render only a viewport worth', () => {
    const big = prefixOffsets(new Array(3000).fill(30))
    const r = visibleRange(big, 45_000, 900, 600)
    expect(r.end - r.start).toBeLessThan(80)
    expect(r.start).toBe(1480)
  })
})
