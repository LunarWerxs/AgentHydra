import { expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { nestTasks, type TaskNode } from '../../src/components/sidebar/tasks'

// The sidebar's CliMayte toggle: each session's running tasks under it and nowhere else, a manager's wave one
// step further in.
const listOf = (nodes: TaskNode[] | undefined) => nodes?.map((n) => `${n.depth}:${n.worker.pc ?? 'here'}:${n.worker.id}`)

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
  const listed = [...tasks.byRow.values()].flat().map((n) => n.worker.id)
  expect(listed.length).toBe(new Set(listed).size)
})

test('managers that name each other still give each row an answer, each task once', () => {
  const workers = [
    worker('a', 1, { originWorkerId: 'b' }),
    worker('b', 2, { originWorkerId: 'a' }),
    worker('kid', 3, { originWorkerId: 'a' })
  ]
  const tasks = nestTasks([{ key: 'cloud:s-a', sessionIds: ['s-a'] }, { key: 'cloud:s-b', sessionIds: ['s-b'] }], workers)
  const listed = [...tasks.byRow.values()].flat().map((n) => n.worker.id)
  expect(listed).toContain('kid')
  expect(listed.length).toBe(new Set(listed).size)
})

// The owner, 2026-10-04: "Under the chat which spawned them. Not as its own stand alone table".
test('a task sits only under the row that spawned it: one from a session no row draws is listed nowhere', () => {
  const done = { status: 'done', active: false }
  const workers = [
    // The Desk chat runs as a worker: the row stands for it.
    worker('chat', 1, { sessionId: 's-chat' }),
    worker('placed', 2, { originSessionId: 's-chat' }),
    // Dispatched from a session the list does not draw, and a finished manager from there with its wave.
    worker('orphan', 3, { originSessionId: 's-hidden' }),
    worker('mgr', 4, { originSessionId: 's-hidden', ...done }),
    worker('wave', 5, { originWorkerId: 'mgr', originSessionId: 's-mgr' }),
    // Another PC's task as an older AgentHydra shares it: no session or origin, its id one of this PC's.
    worker('placed', 6, { pc: 'OTHER-PC', sessionId: null }),
    // A new Desk chat whose worker is still queued has no session yet: its row stands for it by id.
    worker('new-chat', 8, { status: 'queued', sessionId: null })
  ]
  const tasks = nestTasks([{ key: 'chat:1', sessionIds: ['s-chat'] }, { key: 'chat:2', sessionIds: [], workerId: 'new-chat' }], workers)
  expect([...tasks.byRow.keys()]).toEqual(['chat:1'])
  expect(listOf(tasks.byRow.get('chat:1'))).toEqual(['1:here:placed'])
})

test("another PC's tasks sit under the chat that spawned them there, a wave under its manager, known by PC and id", () => {
  const workers = [
    worker('chat', 1, { sessionId: 's-chat' }),
    worker('w-1', 2, { originSessionId: 's-chat' }),
    worker('w-2', 3, { originWorkerId: 'w-1', originSessionId: 's-w-1' }),
    // The other PC's manager, spawned by its chat (which the chat sync brings here as an outside row), and
    // a task of its wave; both ids repeat this PC's.
    worker('w-1', 4, { pc: 'OTHER-PC', kind: 'manage', sessionId: 's-remote-mgr', originSessionId: 's-remote-chat' }),
    worker('w-2', 5, { pc: 'OTHER-PC', sessionId: null, originWorkerId: 'w-1', originSessionId: 's-remote-mgr' })
  ]
  const rows = [
    { key: 'chat:1', sessionIds: ['s-chat'] },
    { key: 'external:s-remote-chat', sessionIds: ['s-remote-chat'] }
  ]
  const tasks = nestTasks(rows, workers)
  expect(listOf(tasks.byRow.get('chat:1'))).toEqual(['1:here:w-1', '2:here:w-2'])
  expect(listOf(tasks.byRow.get('external:s-remote-chat'))).toEqual(['1:OTHER-PC:w-1', '2:OTHER-PC:w-2'])
})
