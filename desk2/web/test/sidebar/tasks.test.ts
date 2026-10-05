import { expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { nestTasks, type TaskNode } from '../../src/components/sidebar/tasks'

// The sidebar's CliMayte toggle: each session's running tasks under it, a manager's wave one step further in.
function worker(id: string, at: number, o: Partial<CliMayteWorker>): CliMayteWorker {
  return {
    id,
    title: id,
    group: null,
    status: 'running',
    active: true,
    account: null,
    model: null,
    effort: null,
    kind: null,
    cwd: null,
    sessionId: `s-${id}`,
    originSessionId: null,
    originWorkerId: null,
    startedAt: at,
    endedAt: null,
    lastActivityAt: at,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    verdict: null,
    error: null,
    ...o
  }
}

test("a session's running tasks sit under it, a manager's wave under the manager, each task listed once", () => {
  const done = { status: 'done', active: false }
  const workers = [
    // The Desk chat runs as a CliMayte worker itself: its session is the chat's, never a task of its own.
    worker('chat', 1, { sessionId: 's-chat' }),
    worker('direct', 2, { originSessionId: 's-chat' }),
    worker('mgr', 3, { originSessionId: 's-chat' }),
    worker('wave1', 4, { originWorkerId: 'mgr', originSessionId: 's-mgr' }),
    worker('wave-done', 5, { originWorkerId: 'mgr', originSessionId: 's-mgr', ...done }),
    worker('finished', 6, { originSessionId: 's-chat', ...done }),
    // Dispatched from inside the chat's own worker.
    worker('inner', 7, { originWorkerId: 'chat', originSessionId: 's-chat' }),
    // A manager that finished while a task of its wave still runs is kept for it.
    worker('mgr2', 8, { originSessionId: 's-other', ...done }),
    worker('wave2', 9, { originWorkerId: 'mgr2', originSessionId: 's-mgr2' }),
    // A manager dispatched from a session no row stands for: its wave stays under its own row.
    worker('mgr3', 10, { originSessionId: 's-gone' }),
    worker('wave3', 11, { originWorkerId: 'mgr3', originSessionId: 's-mgr3' })
  ]
  // The cloud list's rows: the managers' own sessions are rows there too.
  const rows = ['s-chat', 's-mgr', 's-other', 's-mgr2', 's-wave2', 's-mgr3'].map((s) => ({ key: `cloud:${s}`, sessionIds: [s] }))
  const tasks = nestTasks(rows, workers)
  const shape = (key: string) => tasks.byRow.get(key)?.map((n) => `${n.depth}:${n.worker.id}`)
  expect(shape('cloud:s-chat')).toEqual(['1:direct', '1:mgr', '2:wave1', '1:inner'])
  expect(shape('cloud:s-other')).toEqual(['1:mgr2', '2:wave2'])
  expect(shape('cloud:s-mgr3')).toEqual(['1:wave3'])
  // A row that is itself a task listed under another row does not list its tasks again.
  expect(tasks.byRow.has('cloud:s-mgr')).toBe(false)
  expect(tasks.byRow.has('cloud:s-mgr2')).toBe(false)
  const listed = [...[...tasks.byRow.values()].flat(), ...tasks.unplaced].map((n) => n.worker.id)
  expect(listed.length).toBe(new Set(listed).size)
})

test('managers that name each other still give each row an answer, each task once', () => {
  const workers = [
    worker('a', 1, { originWorkerId: 'b' }),
    worker('b', 2, { originWorkerId: 'a' }),
    worker('kid', 3, { originWorkerId: 'a' })
  ]
  const tasks = nestTasks([{ key: 'cloud:s-a', sessionIds: ['s-a'] }, { key: 'cloud:s-b', sessionIds: ['s-b'] }], workers)
  const listed = [...[...tasks.byRow.values()].flat(), ...tasks.unplaced].map((n) => n.worker.id)
  expect(listed).toContain('kid')
  expect(listed.length).toBe(new Set(listed).size)
})

test('the running tasks no drawn row holds come back unplaced, once, a wave under its manager', () => {
  const done = { status: 'done', active: false }
  const workers = [
    worker('old', 1, { originSessionId: 's-hidden', ...done }),
    // The Desk chat runs as a worker: the row stands for it.
    worker('chat', 1, { sessionId: 's-chat' }),
    worker('placed', 2, { originSessionId: 's-chat' }),
    // Dispatched from a session the list does not draw.
    worker('orphan', 3, { originSessionId: 's-hidden' }),
    // A finished manager from there, kept while its wave runs.
    worker('mgr', 4, { originSessionId: 's-hidden', ...done }),
    worker('wave', 5, { originWorkerId: 'mgr', originSessionId: 's-mgr' }),
    // Another PC's tasks carry no session or origin, and the id may be one of this PC's.
    worker('placed', 6, { pc: 'OTHER-PC', sessionId: null }),
    worker('remote-done', 7, { pc: 'OTHER-PC', sessionId: null, ...done }),
    // A new Desk chat whose worker is still queued has no session yet: its row stands for it by id.
    worker('new-chat', 8, { status: 'queued', sessionId: null })
  ]
  const tasks = nestTasks([{ key: 'chat:1', sessionIds: ['s-chat'] }, { key: 'chat:2', sessionIds: [], workerId: 'new-chat' }], workers)
  const shape = (nodes: TaskNode[] | undefined) => nodes?.map((n) => `${n.depth}:${n.worker.pc ?? 'here'}:${n.worker.id}`)
  expect([...tasks.byRow.keys()]).toEqual(['chat:1'])
  expect(shape(tasks.byRow.get('chat:1'))).toEqual(['1:here:placed'])
  expect(shape(tasks.unplaced)).toEqual(['1:here:orphan', '1:here:mgr', '2:here:wave', '1:OTHER-PC:placed'])
})
