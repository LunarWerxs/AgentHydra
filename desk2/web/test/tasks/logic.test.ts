import { describe, expect, test } from 'bun:test'
import type { CliMayteWorker, TranscriptItem } from '@shared/protocol'
import {
  agentState,
  formatElapsed,
  formatTokens,
  openPhase,
  panelLists,
  phaseSquares,
  runningLabel,
  workerUnits
} from '../../src/components/tasks/logic'

function w(id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    title: id,
    description: null,
    group: null,
    status: 'running',
    active: true,
    account: '#68',
    model: 'claude-opus-5-5',
    effort: null,
    kind: 'code',
    cwd: null,
    sessionId: `s-${id}`,
    originSessionId: 'chat-1',
    startedAt: 1_000,
    endedAt: null,
    lastActivityAt: null,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    verdict: null,
    error: null,
    ...over
  }
}
const done = (id: string, over: Partial<CliMayteWorker> = {}) =>
  w(id, { status: 'done', active: false, verdict: 'ok', endedAt: 5_000, ...over })

const task = (id: string, status: 'running' | 'completed' | 'failed', over: Partial<Extract<TranscriptItem, { kind: 'task' }>> = {}): TranscriptItem => ({
  id,
  ts: 2_000,
  kind: 'task',
  taskId: id,
  description: 'bun test ./web/test\nsecond line',
  status,
  taskKind: 'bash',
  ...over
})

describe('units', () => {
  test('a group is one unit; a worker with no group is its own', () => {
    const units = workerUnits([w('a', { group: 'g' }), w('b', { group: 'g' }), w('c')])
    expect(units.map((u) => [u.id, u.name, u.agents])).toEqual([
      ['worker:c', 'c', 1],
      ['group:g', 'g', 2]
    ])
  })

  test('a group sums its tokens, takes the first line of its oldest task and lists its running workers for Stop', () => {
    const [u] = workerUnits([
      w('a', { group: 'g', tokens: 170_500, startedAt: 2_000, description: 'later' }),
      w('b', { group: 'g', tokens: 177_500, startedAt: 1_000, description: 'Round 2: fix' }),
      done('c', { group: 'g', tokens: 191_600, startedAt: 1_500 })
    ])
    expect(u!.tokens).toBe(539_600)
    expect(u!.description).toBe('Round 2: fix')
    expect(u!.startedAt).toBe(1_000)
    expect(u!.running).toBe(true)
    expect(u!.endedAt).toBeNull()
    expect(u!.stoppable.sort()).toEqual(['a', 'b'])
    expect(u!.label).toBe('CliMayte')
  })

  test('tokens stay unknown when no worker knows them', () => {
    expect(workerUnits([w('a')])[0]!.tokens).toBeNull()
  })

  test('phases by stage: done/total, running agents first, friendly model names', () => {
    const [u] = workerUnits([
      done('shell', { group: 'g', kind: 'fix', startedAt: 1 }),
      w('news', { group: 'g', kind: 'fix', startedAt: 2 }),
      w('audit', { group: 'g', kind: 'reaudit', status: 'queued', startedAt: 3 })
    ])
    expect(u!.phases.map((p) => [p.name, p.done, p.total])).toEqual([
      ['Fix', 1, 2],
      ['Reaudit', 0, 1]
    ])
    expect(u!.phases[0]!.agents.map((a) => [a.name, a.model, a.state])).toEqual([
      ['news', 'Opus 5.5', 'running'],
      ['shell', 'Opus 5.5', 'done']
    ])
    expect(phaseSquares(u!.phases[0]!)).toEqual(['done', 'running'])
    expect(openPhase(u!)).toBe('Fix')
  })

  test('agent states', () => {
    expect(agentState(w('a', { status: 'checking' }))).toBe('running')
    expect(agentState(w('a', { status: 'waiting' }))).toBe('waiting')
    expect(agentState(done('a'))).toBe('done')
    expect(agentState(done('a', { status: 'failed' }))).toBe('failed')
    expect(agentState(done('a', { status: 'cancelled' }))).toBe('failed')
  })
})

describe('panelLists', () => {
  test("scoped to this chat's workers unless All, plus its running tasks", () => {
    const workers = [w('mine'), w('theirs', { originSessionId: 'chat-2' })]
    const items = [task('t1', 'running'), task('t2', 'completed')]
    const mine = panelLists({ workers, items, sessionId: 'chat-1' })
    expect(mine.running.map((u) => u.id)).toEqual(['task:t1', 'worker:mine'])
    expect(mine.running[0]!.name).toBe('bun test ./web/test')
    expect(mine.running[0]!.label).toBe('Background command')
    expect(mine.finished.map((u) => u.id)).toEqual(['task:t2'])
    expect(panelLists({ workers, sessionId: 'chat-1', all: true }).running).toHaveLength(2)
    expect(panelLists({ workers, sessionId: null }).running).toHaveLength(0)
  })

  test('the matched workerIds list its workers, finished ones too, whatever their origin session', () => {
    const workers = [w('moved', { originSessionId: 'old-session' }), done('gone', { originSessionId: 'old-session' }), w('theirs', { originSessionId: 'chat-2' })]
    const lists = panelLists({ workers, sessionId: 'new-session', workerIds: ['moved', 'gone'] })
    expect(lists.running.map((u) => u.id)).toEqual(['worker:moved'])
    expect(lists.finished.map((u) => u.id)).toEqual(['worker:gone'])
  })

  test("finished: most recent first, minus the cleared, capped at the real app's 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => done(`d${i}`, { endedAt: 10_000 + i }))
    const { finished } = panelLists({ workers: many, sessionId: 'chat-1', cleared: new Set(['d59']) })
    expect(finished).toHaveLength(50)
    expect(finished[0]!.id).toBe('worker:d58')
  })

  test("a chat's finished background tasks list and count under finished, a failed one marked", () => {
    const items = [task('run', 'running'), task('ok', 'completed', { durationMs: 1_000 }), task('bad', 'failed', { durationMs: 500 })]
    const lists = panelLists({ workers: [], items, sessionId: 'chat-1' })
    expect(lists.running.map((u) => u.id)).toEqual(['task:run'])
    expect(lists.finished.map((u) => [u.id, !!u.failed])).toEqual([
      ['task:ok', false],
      ['task:bad', true]
    ])
  })
})

test('labels and formats', () => {
  expect(runningLabel(0)).toBe('')
  expect(runningLabel(1)).toBe('1 running task')
  expect(runningLabel(3)).toBe('3 running tasks')
  expect(runningLabel(1, 2)).toBe('1 running task · 2 finished')
  expect(runningLabel(0, 1)).toBe('1 finished task')
  expect(runningLabel(0, 50)).toBe('50+ finished tasks')
  expect(formatElapsed(666_000)).toBe('11m 06s')
  expect(formatElapsed(45_000)).toBe('45s')
  expect(formatElapsed(3_720_000)).toBe('1h 02m')
  expect(formatTokens(539_600)).toBe('539.6k')
  expect(formatTokens(812)).toBe('812')
  expect(formatTokens(4_106_540)).toBe('4.1M')
  expect(formatTokens(null)).toBe('–')
})
