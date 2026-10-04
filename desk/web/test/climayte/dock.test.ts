import { expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { chatWorkers, loadDismissed, saveDismissed } from '../../src/components/climayte/dock'

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
