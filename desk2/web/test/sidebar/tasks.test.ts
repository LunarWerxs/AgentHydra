import { expect, test } from 'bun:test'
import type { CliMayteWorker } from '@shared/protocol'
import { nestTasks } from '../../src/components/sidebar/tasks'

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

test("a session's running tasks sit under it, a manager's wave under the manager, each shown once", () => {
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
    worker('wave2', 9, { originWorkerId: 'mgr2', originSessionId: 's-mgr2' })
  ]
  const rows = [
    { key: 'chat:c', sessionIds: ['s-chat'], hideable: false },
    { key: 'external:s-direct', sessionIds: ['s-direct'], hideable: true },
    { key: 'external:s-mgr', sessionIds: ['s-mgr'], hideable: true },
    { key: 'external:s-wave1', sessionIds: ['s-wave1'], hideable: true },
    { key: 'external:s-other', sessionIds: ['s-other'], hideable: true },
    { key: 'external:s-wave2', sessionIds: ['s-wave2'], hideable: true }
  ]
  const { tasks, hidden } = nestTasks(rows, workers)
  const shape = (key: string) => tasks.get(key)?.map((n) => `${n.depth}:${n.worker.id}`)
  expect(shape('chat:c')).toEqual(['1:direct', '1:mgr', '2:wave1', '1:inner'])
  expect(shape('external:s-other')).toEqual(['1:mgr2', '2:wave2'])
  // A task shown under the row that handed it out is not also a row of its own.
  expect([...hidden].sort()).toEqual(['external:s-direct', 'external:s-mgr', 'external:s-wave1', 'external:s-wave2'])
  expect(tasks.has('external:s-mgr')).toBe(false)
})
