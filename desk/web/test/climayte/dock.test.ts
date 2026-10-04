import { describe, expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { chatWorkers, loadDismissed, saveDismissed, summarizeDock } from '../../src/components/climayte/dock'

function w(id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    title: id,
    group: null,
    status: 'running',
    active: true,
    account: '#68',
    model: null,
    effort: null,
    kind: null,
    cwd: null,
    sessionId: `s-${id}`,
    originSessionId: 'chat-1',
    startedAt: 1_000_000,
    lastActivityAt: null,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    endedAt: null,
    verdict: null,
    error: null,
    ...over
  }
}
const done = (id: string, over: Partial<CliMayteWorker> = {}) => w(id, { status: 'done', active: false, verdict: 'ok', ...over })

describe('summarizeDock', () => {
  test('labels', () => {
    expect(summarizeDock([w('a')]).label).toBe('1 agent running')
    expect(summarizeDock([w('a'), w('b'), w('c')]).label).toBe('3 agents running')
    expect(summarizeDock([w('a'), w('b'), done('c')])).toEqual({ running: 2, done: 1, tone: 'running', label: '2 running, 1 done' })
    expect(summarizeDock([done('a')])).toEqual({ running: 0, done: 1, tone: 'done', label: '1 agent done' })
    expect(summarizeDock([done('a'), done('b'), done('c'), done('d')]).label).toBe('4 agents done')
    expect(summarizeDock([])).toEqual({ running: 0, done: 0, tone: 'none', label: '' })
  })
  test('climayteActive covers workers the list has not reported yet', () => {
    expect(summarizeDock([], 2).label).toBe('2 agents running')
    expect(summarizeDock([w('a'), w('b'), w('c')], 1).running).toBe(3)
  })
  test('cleared done workers no longer count', () => {
    expect(summarizeDock([w('a'), done('b')], 0, new Set(['b'])).label).toBe('1 agent running')
    expect(summarizeDock([done('b')], 0, new Set(['b'])).tone).toBe('none')
  })
})

test('chatWorkers keeps only this chat', () => {
  const list = [w('a'), w('b', { originSessionId: 'other' }), w('c', { originSessionId: null })]
  expect(chatWorkers(list, 'chat-1').map((x) => x.id)).toEqual(['a'])
  expect(chatWorkers(list, null)).toEqual([])
})

test('dismissed ids round-trip through storage', () => {
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  saveDismissed(new Set(['a', 'b']), storage)
  expect([...loadDismissed(storage)]).toEqual(['a', 'b'])
  expect(loadDismissed({ getItem: () => 'not json' }).size).toBe(0)
})
