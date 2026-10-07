import { expect, test } from 'bun:test'
import type { CliMayteWorker, CloudSession, ExternalSession, SwarmJob } from '@shared/protocol'
import type { CloudGroup } from '../../src/components/cloud/logic'
import type { ChatGroup, SidebarEntry } from '../../src/components/sidebar/logic'
import { addToCloudGroups, addToDeskGroups, addedPulse, addedStatus, nestTasks, runningJobsIn, runningTasksIn, type AddedRow, type TaskNode } from '../../src/components/sidebar/tasks'

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
  // Every running task is under a row or drawn as one, so no row is added for one.
  expect(tasks.added).toEqual([])
})

test('a running task deep in a chain is still listed, at the deepest indent, with the finished task above it', () => {
  const workers = [
    worker('mgr', 1, { originSessionId: 's-chat' }),
    worker('task', 2, { originWorkerId: 'mgr' }),
    worker('sub', 3, { originWorkerId: 'task', status: 'done', active: false }),
    worker('subsub', 4, { originWorkerId: 'sub' })
  ]
  const tasks = nestTasks([{ key: 'chat:1', sessionIds: ['s-chat'] }], workers)
  expect(listOf(tasks.byRow.get('chat:1'))).toEqual(['1:here:mgr', '2:here:task', '3:here:sub', '3:here:subsub'])
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
test('a task sits only under the row that spawned it: one from a session no row draws is under no drawn row', () => {
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

// (owner, 2026-10-05, AgentHydra's CliMayte list against Desk's sidebar: "Is one smaller than six? Yes ... Why?")
test('a running task no row lists is still shown: its chat, else the task itself, is added as a row, and every running task is shown once', () => {
  const bare = { sessionId: null, originSessionId: null, originWorkerId: null }
  const workers = [
    // Under its chat, as before.
    worker('placed', 1, { originSessionId: 's-chat' }),
    // Its chat is not in the list: the finished manager above it comes too, under that chat's row.
    worker('mgr', 2, { originSessionId: 's-hidden', status: 'done', active: false }),
    worker('kid', 3, { originWorkerId: 'mgr', originSessionId: 's-mgr' }),
    // Nothing here says which chat started it: the task is a row itself, never under a "No chat" heading.
    worker('loose', 4, { originSessionId: null }),
    // A PC whose older AgentHydra sends no session or origin for any task.
    worker('old1', 5, { ...bare, pc: 'PC-OLD' }),
    worker('old2', 6, { ...bare, pc: 'PC-OLD' }),
    worker('old-done', 7, { ...bare, pc: 'PC-OLD', status: 'done', active: false }),
    // A PC whose AgentHydra does: one task from a chat the list does not show, one no chat started.
    worker('new', 8, { pc: 'PC-NEW', originSessionId: 's-there' }),
    worker('new-loose', 9, { ...bare, pc: 'PC-NEW', status: 'queued' }),
    // A Desk chat that runs as a worker, still queued: drawn as its row.
    worker('queued-chat', 10, { ...bare, status: 'queued' }),
    // Its dispatcher is gone from the list: nothing here names its chat.
    worker('orphan', 11, { originWorkerId: 'gone', originSessionId: null })
  ]
  const rows = [
    { key: 'chat:1', sessionIds: ['s-chat'] },
    { key: 'chat:2', sessionIds: [], workerId: 'queued-chat' }
  ]
  const tasks = nestTasks(rows, workers)
  expect(listOf(tasks.byRow.get('chat:1'))).toEqual(['1:here:placed'])
  // An unknown chat takes its first task's title.
  expect(tasks.added.map((a) => [a.pc, a.title, a.worker?.id ?? null, listOf(a.nodes)])).toEqual([
    [null, 'mgr', null, ['1:here:mgr', '2:here:kid']],
    [null, 'loose', 'loose', []],
    ['PC-OLD', 'old1', 'old1', []],
    ['PC-OLD', 'old2', 'old2', []],
    ['PC-NEW', 'new', null, ['1:PC-NEW:new']],
    ['PC-NEW', 'new-loose', 'new-loose', []],
    [null, 'orphan', 'orphan', []]
  ])
  const shown = [...[...tasks.byRow.values()].flat().map((n) => n.worker), ...tasks.added.flatMap((a) => [...(a.worker ? [a.worker] : []), ...a.nodes.map((n) => n.worker)])]
  const running = workers.filter((w) => w.active && w.id !== 'queued-chat')
  expect(shown.filter((w) => w.active).sort((a, b) => a.startedAt! - b.startedAt!)).toEqual(running)
})

test("a worker that handed off is two rows' session, and its tasks are listed once, under the row on its current session", () => {
  const workers = [
    worker('handed', 1, { sessionId: 's-new', sessions: ['s-old', 's-new'] }),
    worker('k1', 2, { originWorkerId: 'handed', originSessionId: 's-new' }),
    // Dispatched from its first session, before the handoff.
    worker('k2', 3, { originSessionId: 's-old' })
  ]
  const tasks = nestTasks([{ key: 'external:s-old', sessionIds: ['s-old'] }, { key: 'external:s-new', sessionIds: ['s-new'] }], workers)
  expect([...tasks.byRow.keys()]).toEqual(['external:s-new'])
  expect(listOf(tasks.byRow.get('external:s-new'))).toEqual(['1:here:k1', '1:here:k2'])
  expect(tasks.added).toEqual([])
})

test("an added chat row takes the title, folder and time the window knows its session by; another PC's unknown chat has no folder", () => {
  const bare = { sessionId: null, originSessionId: null, originWorkerId: null }
  const known = new Map([
    ['s-desktop', { title: 'Example chat', cwd: 'C:/Users/me/Projects/app', at: 50 }],
    // The other PC's chat the chat sync brought here: the same session id.
    ['s-synced', { title: 'Example synced chat', cwd: 'D:/Work/app', at: 60 }]
  ])
  const tasks = nestTasks([], [
    worker('a', 1, { originSessionId: 's-desktop' }),
    worker('b', 2, { ...bare, cwd: 'C:/Users/me/Projects/other' }),
    worker('c', 3, { pc: 'PC-X', originSessionId: 's-synced' }),
    worker('d', 4, { pc: 'PC-X', originSessionId: 's-remote-0123456789', originTitle: 'Example remote chat' }),
    worker('e', 5, { ...bare, pc: 'PC-X' })
  ], [], known)
  expect(tasks.added.map((a) => [a.pc, a.title, a.cwd, a.at])).toEqual([
    [null, 'Example chat', 'C:/Users/me/Projects/app', 50],
    [null, 'b', 'C:/Users/me/Projects/other', 2],
    ['PC-X', 'Example synced chat', 'D:/Work/app', 60],
    ['PC-X', 'Example remote chat', null, 4],
    ['PC-X', 'e', null, 5]
  ])
})

test("another PC's task whose own session the window knows runs in that session's folder, and its chat's row with it", () => {
  // The chat sync brought the task's session here, with its folder; nothing here knows the chat that started it.
  const known = new Map([
    ['s-t1', { title: 'Example task', cwd: 'D:/Work/app', at: 1 }],
    // An earlier session of a task that handed off.
    ['s-t3-old', { title: 'Example task', cwd: 'D:/Work/other', at: 1 }]
  ])
  const tasks = nestTasks([], [
    worker('t1', 1, { pc: 'PC-X', originSessionId: 's-remote-chat-0123' }),
    worker('t2', 2, { pc: 'PC-X', originSessionId: null }),
    worker('t3', 3, { pc: 'PC-X', originSessionId: null, sessionId: 's-t3-new', sessions: ['s-t3-old', 's-t3-new'] })
  ], [], known)
  expect(tasks.added.map((a) => [a.title, a.cwd])).toEqual([
    ['t1', 'D:/Work/app'],
    ['t2', null],
    ['t3', 'D:/Work/other']
  ])
})

test('three tasks from one unlisted chat on another PC share one row, titled as that PC titles it, else after its first task', () => {
  const from = { pc: 'PC-X', originSessionId: '0123456789abcdef' }
  const named = nestTasks([], [
    worker('t1', 1, { ...from }),
    worker('t2', 2, { ...from, originTitle: 'Example refactor chat' }),
    worker('t3', 3, { ...from })
  ])
  expect(named.added.map((a) => [a.title, a.sessionId, listOf(a.nodes)])).toEqual([['Example refactor chat', '0123456789abcdef', ['1:PC-X:t1', '1:PC-X:t2', '1:PC-X:t3']]])
  const plain = nestTasks([], [worker('t1', 1, { ...from }), worker('t2', 2, { ...from })])
  expect(plain.added.map((a) => a.title)).toEqual(['t1'])
})

test('a Desk chat running as a worker on another PC is its own row, with its task one step in and its HSwarm job', () => {
  const chat = worker('desk-chat', 1, { pc: 'PC-X', group: 'hydra-desk', title: 'Example Desk chat' })
  const tasks = nestTasks(
    [],
    [chat, worker('task', 2, { pc: 'PC-X', originWorkerId: 'desk-chat', originSessionId: 's-desk-chat' })],
    [swarmJob('j-desk', { callerSessionId: 's-desk-chat', pc: 'PC-X' })]
  )
  expect(tasks.added).toHaveLength(1)
  const [row] = tasks.added
  expect(row!.title).toBe('Example Desk chat')
  expect(row!.worker).toBe(chat)
  expect(listOf(row!.nodes)).toEqual(['1:PC-X:task'])
  expect(row!.jobs.map((j) => j.id)).toEqual(['j-desk'])
  expect(addedStatus(row!)).toBe('working')
  expect(runningTasksIn([row!.nodes]) + runningJobsIn([row!.jobs])).toBe(2)
})

test("a task dispatched from a remote worker's earlier session sits under that worker", () => {
  const mgr = worker('mgr', 1, { pc: 'PC-X', originSessionId: 's-chat-abcd', sessionId: 's-new', sessions: ['s-old', 's-new'] })
  const kid = worker('kid', 2, { pc: 'PC-X', originSessionId: 's-old' })
  const tasks = nestTasks([], [mgr, kid])
  expect(tasks.added.map((a) => listOf(a.nodes))).toEqual([['1:PC-X:mgr', '2:PC-X:kid']])
})

// HSwarm jobs: nested under the row of the session that called HSwarm, apart from the CliMayte tasks.
function swarmJob(id: string, o: Partial<SwarmJob> = {}): SwarmJob {
  return { id, title: id, status: 'running', active: true, startedAt: 1, endedAt: null, tasks: { total: 4, done: 1, failed: 0, cancelled: 0 }, callerSessionId: null, callerHostSessionId: null, callerTitle: null, pc: null, ...o }
}

test("an HSwarm job sits under the row of its caller's session, or of its host session, apart from the CliMayte tasks", () => {
  const rows = [
    { key: 'chat:a', sessionIds: ['11111111-2222-4333-8444-555555555555'] },
    { key: 'chat:b', sessionIds: ['66666666-7777-4888-8999-000000000000'] }
  ]
  const workers = [worker('w1', 1, { originSessionId: '11111111-2222-4333-8444-555555555555' })]
  const jobs = [
    swarmJob('j-session', { callerSessionId: '11111111-2222-4333-8444-555555555555' }),
    swarmJob('j-prefix', { callerSessionId: '66666666', status: 'done', active: false }),
    swarmJob('j-host', { callerSessionId: 'ffffffff-0000-4000-8000-000000000000', callerHostSessionId: '66666666-7777-4888-8999-000000000000', startedAt: 5 })
  ]
  const nested = nestTasks(rows, workers, jobs)
  expect(listOf(nested.byRow.get('chat:a'))).toEqual(['1:here:w1'])
  expect(nested.jobsByRow.get('chat:a')?.map((j) => j.id)).toEqual(['j-session'])
  expect(nested.jobsByRow.get('chat:b')?.map((j) => j.id)).toEqual(['j-host', 'j-prefix'])
  expect(nested.byRow.has('chat:b')).toBe(false)
  expect(nested.added).toEqual([])
})

test('a running HSwarm job no row has adds its caller as a row, titled from callerTitle else after the job, or is a row itself; a finished one only joins a row', () => {
  const jobs = [
    swarmJob('j-lost', { callerSessionId: '99999999', startedAt: 5 }),
    swarmJob('j-old', { callerSessionId: '99999999', startedAt: 4, status: 'done', active: false }),
    swarmJob('j-named', { callerSessionId: '11111111-2222-3333-4444-555555555555', callerTitle: 'Example chat', startedAt: 3 }),
    // Finished, and no row is there for its caller: drawn nowhere, as a finished task is.
    swarmJob('j-gone', { callerSessionId: '88888888', startedAt: 2, status: 'done', active: false }),
    // Nothing says which chat called it.
    swarmJob('j-alone', { startedAt: 1 })
  ]
  const nested = nestTasks([{ key: 'chat:a', sessionIds: ['s-a'] }], [], jobs)
  expect(nested.jobsByRow.size).toBe(0)
  expect(nested.added.map((a) => [a.title, a.job?.id ?? null, a.jobs.map((j) => j.id), a.cwd])).toEqual([
    ['j-lost', null, ['j-lost', 'j-old'], null],
    ['Example chat', null, ['j-named'], null],
    ['j-alone', 'j-alone', [], null]
  ])
  // Every running job is drawn once: under its row, or as the row itself.
  const drawn = nested.added.flatMap((a) => [...(a.job ? [a.job] : []), ...a.jobs])
  expect(drawn.filter((j) => j.active).map((j) => j.id)).toEqual(['j-lost', 'j-named', 'j-alone'])
  expect(runningTasksIn(nested.added.map((a) => a.nodes)) + runningJobsIn(nested.added.map((a) => a.jobs))).toBe(2)
})

test('a job and a task of the same unlisted chat share one row, whether the job has the full id or its prefix', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const nested = nestTasks([], [worker('w1', 1, { originSessionId: sid })], [swarmJob('j-full', { callerSessionId: sid }), swarmJob('j-prefix', { callerSessionId: '11111111', status: 'done', active: false })])
  expect(nested.added.map((a) => [a.nodes.length, a.jobs.map((j) => j.id)])).toEqual([[1, ['j-full', 'j-prefix']]])
})

test("a task HSwarm sent to CliMayte sits under the chat that called its job, on its own PC; one whose job is not listed is a row of its own", () => {
  const sid = '11111111-2222-4333-8444-555555555555'
  const remote = '22222222-3333-4444-8555-666666666666'
  const workers = [
    worker('w-routed', 1, { group: 'hswarm-20261007-084102-1c59-t1' }),
    worker('w-prefix', 2, { group: 'hswarm-20261007-090000-aaaa-t2' }),
    worker('w-remote', 3, { group: 'hswarm-20261007-084102-1c59-t1', pc: 'PC-B' }),
    worker('w-unknown', 4, { group: 'hswarm-20261007-999999-ffff-t1' })
  ]
  const jobs = [
    swarmJob('20261007-084102-1c59', { callerSessionId: sid }),
    swarmJob('20261007-090000-aaaa', { callerSessionId: '11111111', startedAt: 2 }),
    // The other PC's job of the same id: its task goes under its own caller there, never under this PC's.
    swarmJob('20261007-084102-1c59', { callerSessionId: remote, callerTitle: 'Example remote chat', pc: 'PC-B' })
  ]
  const nested = nestTasks([{ key: 'chat:a', sessionIds: [sid] }], workers, jobs)
  expect(listOf(nested.byRow.get('chat:a'))).toEqual(['1:here:w-routed', '1:here:w-prefix'])
  expect(nested.added.map((a) => [a.title, a.pc, a.worker?.id ?? null, a.nodes.map((n) => n.worker.id), a.jobs.map((j) => j.pc)])).toEqual([
    ['Example remote chat', 'PC-B', null, ['w-remote'], ['PC-B']],
    ['w-unknown', null, 'w-unknown', [], []]
  ])
})

test('an 8-character prefix that two rows share adds a row for the job, not a guess between the two', () => {
  const rows = [
    { key: 'chat:a', sessionIds: ['abcdef12-0000-4000-8000-000000000001'] },
    { key: 'chat:b', sessionIds: ['abcdef12-0000-4000-8000-000000000002'] }
  ]
  const nested = nestTasks(rows, [], [swarmJob('j-amb', { callerSessionId: 'abcdef12' })])
  expect(nested.jobsByRow.size).toBe(0)
  expect(nested.added.map((a) => [a.title, a.jobs.map((j) => j.id)])).toEqual([['j-amb', ['j-amb']]])
})

test('in the cloud list (rows keyed cloud:<id>) a job sits under the cloud row of its caller session', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const rows = [{ key: `cloud:${sid}`, sessionIds: [sid] }]
  const nested = nestTasks(rows, [], [swarmJob('j-cloud', { callerSessionId: sid })])
  expect(nested.jobsByRow.get(`cloud:${sid}`)?.map((j) => j.id)).toEqual(['j-cloud'])
  expect(nested.added).toEqual([])
})

test("the other PC's job goes under the row that has its session, else under a row added on its PC", () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const other = swarmJob('j-other', { callerSessionId: sid, pc: 'Other-PC' })
  const placed = nestTasks([{ key: 'cloud:x', sessionIds: [sid] }], [], [other])
  expect(placed.jobsByRow.get('cloud:x')?.map((j) => j.id)).toEqual(['j-other'])
  const lost = nestTasks([], [], [other, swarmJob('j-here', { callerSessionId: sid })])
  expect(lost.added.map((a) => [a.pc, a.jobs.map((j) => j.id)])).toEqual([
    ['Other-PC', ['j-other']],
    [null, ['j-here']]
  ])
})

// The rows added for running work, drawn inline in their folder's group (owner, 2026-10-05: "I shouldn't even be
// able to tell the difference between ones on his computer and mine, besides them having a Cloud icon").
const addedRow = (id: string, cwd: string | null, at: number): AddedRow => ({ id: `added::task:${id}`, title: id, pc: null, cwd, folder: null, at, sessionId: null, worker: null, job: null, nodes: [], jobs: [] })

function deskRow(id: string, at: number, cwd: string | null): SidebarEntry {
  const session: ExternalSession = { id, title: id, cwd, source: 'cli', instance: null, status: 'idle', activity: null, lastActivityAt: at, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null }
  return { kind: 'external', id, at, session }
}

test("the desk list draws an added row in its folder's group among its own rows, a folder it has no group for after its groups", () => {
  const app: ChatGroup = { key: 'C:/Users/me/Projects/app', label: 'app', cwd: 'C:/Users/me/Projects/app', entries: [deskRow('s-a', 30, 'C:/Users/me/Projects/app'), deskRow('s-b', 10, 'C:/Users/me/Projects/app')] }
  const moved: ChatGroup = { key: 'group:Example', label: 'Example', cwd: null, entries: [deskRow('s-c', 20, 'C:/Users/me/Projects/app')] }
  // The same folder spelled another way; a row the saved order already places, and one it does not.
  const recorded = addedRow('recorded', 'c:\\users\\me\\projects\\app\\', 20)
  const fresh = addedRow('fresh', 'C:/Users/me/Projects/app', 40)
  const out = addToDeskGroups([app, moved], [recorded, fresh, addedRow('new-folder', 'C:/Users/me/Projects/new', 5), addedRow('no-folder', null, 7), addedRow('hidden', 'C:/Users/me/Projects/hid', 50)], {
    order: { groups: [], rows: ['s-a', recorded.id, 's-b'] },
    hidden: new Set(['c:/users/me/projects/hid']),
    showHidden: false
  })
  expect(out.map((g) => [g.label, g.cwd, g.entries.map((e) => e.id)])).toEqual([
    ['app', 'C:/Users/me/Projects/app', [fresh.id, 's-a', recorded.id, 's-b']],
    ['Example', null, ['s-c']],
    ['No folder', null, ['added::task:no-folder']],
    ['new', 'C:/Users/me/Projects/new', ['added::task:new-folder']]
  ])
  // A moved-to group is no folder's: it is left as it was.
  expect(out[1]).toBe(moved)
  expect(out[0]!.entries[0]!.kind).toBe('external')
})

const cloudRow = (id: string, at: number, cwd: string | null): CloudSession => ({ id, title: id, cwd, lastCwd: null, source: 'claude', instance: null, lastActivityAt: at, createdAt: null, messageCount: 1, dispatched: false, archived: false, fromPc: null, model: null, effort: null, instanceNum: null })

test("the cloud list draws another PC's chat in the group of its synced folder among its rows, with that PC on it", () => {
  const known = new Map([['s-synced', { title: 'Example synced chat', cwd: 'd:\\work\\app', at: 60 }]])
  const { added } = nestTasks([], [worker('t', 1, { pc: 'PC-X', originSessionId: 's-synced' }), worker('u', 2, { pc: 'PC-X', originSessionId: 's-other' })], [], known)
  const app: CloudGroup = { key: 'cloud:d:/work/app', label: 'app', cwd: 'D:/Work/app', orderKey: 'd:/work/app', rows: [cloudRow('s-desk', 70, 'D:/Work/app'), cloudRow('s-cloud', 50, 'D:/Work/app')] }
  const out = addToCloudGroups([app], added, {
    order: { groups: [], rows: [] },
    hidden: new Set<string>(),
    showHidden: false,
    orderKey: (id) => id,
    onDesk: (id) => id === 's-desk'
  })
  // A row the desk list lacks goes after the desk's rows, as the cloud list puts its own.
  expect(out.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
    ['app', ['s-desk', 'added:PC-X:chat:s-synced', 's-cloud']],
    ['No folder', ['added:PC-X:chat:s-other']]
  ])
  expect(out[0]!.rows[1]!.fromPc).toBe('PC-X')
  expect(out[1]!.orderKey).toBe('')
})

// Owner, 2026-10-06: another PC shares only the last name of a task's folder, never its path; a chat of it this PC
// does not have goes in the group of that name, not in "No folder".
test("another PC's chat known only by its folder's last name goes in the one group of that name here, else in a group of that name", () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const { added } = nestTasks(
    [],
    [
      worker('t', 1, { pc: 'PC-X', originSessionId: 's-app', folder: 'App' }),
      worker('u', 2, { pc: 'PC-X', originSessionId: 's-repo', folder: 'Example-repo' }),
      worker('v', 3, { pc: 'PC-X', originSessionId: 's-shared', folder: 'shared' }),
      worker('w', 4, { pc: 'PC-X', originSessionId: 's-none' })
    ],
    [swarmJob('j', { pc: 'PC-X', callerSessionId: sid, folder: 'Example-repo', startedAt: 5 })]
  )
  const group = (cwd: string, at: number): CloudGroup => ({ key: `cloud:${cwd.toLowerCase()}`, label: cwd.split('/').pop()!, cwd, orderKey: cwd.toLowerCase(), rows: [cloudRow(`s-${at}`, at, cwd)] })
  // Two folders here are named "shared": which one is a guess, so that chat gets a group of its own.
  const out = addToCloudGroups([group('D:/Work/app', 70), group('D:/Work/shared', 60), group('E:/Other/shared', 50)], added, {
    order: { groups: [], rows: [] },
    hidden: new Set<string>(),
    showHidden: false,
    orderKey: (id) => id,
    onDesk: (id) => !id.startsWith('added:')
  })
  expect(out.map((g) => [g.label, g.orderKey, g.rows.map((r) => r.id)])).toEqual([
    ['app', 'd:/work/app', ['s-70', 'added:PC-X:chat:s-app']],
    ['shared', 'd:/work/shared', ['s-60']],
    ['shared', 'e:/other/shared', ['s-50']],
    ['Example-repo', 'name:example-repo', [`added:PC-X:chat:${sid}`, 'added:PC-X:chat:s-repo']],
    ['No folder', '', ['added:PC-X:chat:s-none']],
    ['shared', 'name:shared', ['added:PC-X:chat:s-shared']]
  ])
})

// Owner, 2026-10-05: another PC's chats pulse gray while their CliMayte tasks run, still when none does; blue is HSwarm's alone.
test('an added row pulses gray while a task it lists runs, blue as a running job itself, and is still with nothing running', () => {
  const idle = { worker: null, job: null, nodes: [], jobs: [] }
  const task = (active: boolean): TaskNode => ({ worker: worker('t', 1, { active, pc: 'PC-X' }), depth: 0 })
  expect(addedPulse({ ...idle, nodes: [task(true)] })).toBe('gray')
  expect(addedPulse({ ...idle, nodes: [task(false)] })).toBeNull()
  expect(addedPulse({ ...idle, jobs: [swarmJob('j', { active: true })] })).toBe('gray')
  expect(addedPulse({ ...idle, job: swarmJob('j', { active: true }) })).toBe('blue')
  expect(addedPulse(idle)).toBeNull()
})
