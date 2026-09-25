// server/tests/compaction-history.test.ts - history_search / history_read pinned: they see exactly
// what the LAST compaction dropped (never what is still in context unless asked), tool calls and
// tool results included, and a source id found by search pages back its exact text.
import { expect, test } from 'bun:test'
import {
  PAGE_CHARS,
  parseHistory,
  readHistory,
  scopeOf,
  searchHistory,
} from '../src/compaction-history'

const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n')

const user = (uuid: string, content: unknown, extra: object = {}) => ({
  type: 'user',
  uuid,
  timestamp: '2026-09-25T10:00:00Z',
  message: { role: 'user', content },
  ...extra,
})
const assistant = (uuid: string, content: unknown[]) => ({
  type: 'assistant',
  uuid,
  timestamp: '2026-09-25T10:01:00Z',
  message: { role: 'assistant', content },
})
const boundary = { type: 'system', subtype: 'compact_boundary', content: 'Compacted' }
const summary = (uuid: string) => user(uuid, 'Summary of earlier work', { isCompactSummary: true })

const LONG = `start ${'x'.repeat(PAGE_CHARS + 500)} end`

const transcript = jsonl([
  user('u1', 'Please fix the flaky test in orbit-sync, the one timing out'),
  assistant('a1', [
    { type: 'thinking', thinking: 'secret reasoning about orbit-sync' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test orbit-sync' } },
  ]),
  user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'error: ETIMEDOUT at line 42' }]),
  user('u3', [{ type: 'tool_result', tool_use_id: 't2', content: LONG }]),
  boundary,
  summary('s1'),
  user('u4', 'now the orbit-sync docs'),
])

test('only what the last compaction dropped is searched, unless all is asked for', () => {
  const h = parseHistory(transcript)
  expect(h.compactions).toBe(1)
  const dropped = scopeOf(h, false)
  expect(dropped.map((s) => s.id)).toEqual(['u1#0', 'a1#1', 'u2#0', 'u3#0'])
  // "now the orbit-sync docs" is still in context: not a dropped source.
  expect(searchHistory(dropped, 'docs')).toEqual([])
  expect(searchHistory(scopeOf(h, true), 'docs').map((x) => x.sourceId)).toEqual(['u4#0'])
})

test('tool calls and tool results are searchable; reasoning and the summary are not', () => {
  const dropped = scopeOf(parseHistory(transcript), false)
  expect(searchHistory(dropped, 'ETIMEDOUT')[0]?.sourceId).toBe('u2#0')
  expect(searchHistory(dropped, '"bun test"')[0]?.kind).toBe('tool_use')
  expect(searchHistory(dropped, 'reasoning')).toEqual([])
  expect(searchHistory(dropped, 'Summary')).toEqual([])
})

test('every term must match; excerpts are bounded and hits capped at eight', () => {
  const dropped = scopeOf(parseHistory(transcript), false)
  expect(searchHistory(dropped, 'orbit-sync flaky').map((x) => x.sourceId)).toEqual(['u1#0'])
  const needles = Array.from({ length: 12 }, (_, i) => user(`m${i}`, `needle ${i}`))
  const many = scopeOf(parseHistory(jsonl([...needles, boundary])), false)
  expect(searchHistory(many, 'needle', 50)).toHaveLength(8)
  const long = searchHistory(dropped, 'end')[0]
  expect(long?.excerpt.length).toBeLessThanOrEqual(606)
})

test('history_read pages a source exactly, ending with nextOffset null', () => {
  const dropped = scopeOf(parseHistory(transcript), false)
  const first = readHistory(dropped, 'u3#0')
  expect(first.text).toBe(LONG.slice(0, PAGE_CHARS))
  expect(first.nextOffset).toBe(PAGE_CHARS)
  const second = readHistory(dropped, 'u3#0', first.nextOffset ?? 0)
  expect(first.text + second.text).toBe(LONG)
  expect(second.nextOffset).toBeNull()
  expect(() => readHistory(dropped, 'u4#0')).toThrow()
})
