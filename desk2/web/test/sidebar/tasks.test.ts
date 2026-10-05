import { expect, test } from 'bun:test'
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'
import { nestTasks, unplacedHeading, type TaskNode } from '../../src/components/sidebar/tasks'

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
  // Every running task is under a row or drawn as one, so none is listed again at the top.
  expect(tasks.unplaced).toEqual([])
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

// (owner, 2026-10-05, AgentHydra's CliMayte list against Desk's sidebar: "Is one smaller than six? Yes ... Why?")
test('a running task no row lists is still shown, at the top, one block per PC with a stand-in per chat, and every running task is shown once', () => {
  const bare = { sessionId: null, originSessionId: null, originWorkerId: null }
  const workers = [
    // Under its chat, as before.
    worker('placed', 1, { originSessionId: 's-chat' }),
    // Its chat is not in the list: the finished manager above it comes too.
    worker('mgr', 2, { originSessionId: 's-hidden', status: 'done', active: false }),
    worker('kid', 3, { originWorkerId: 'mgr', originSessionId: 's-mgr' }),
    // Nothing here says which chat started it.
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
  expect(tasks.unplaced.map((b) => [b.pc, b.chats.map((c) => [c.title, c.worker, listOf(c.nodes)])])).toEqual([
    [null, [['A chat · s-hidden', null, ['1:here:mgr', '2:here:kid']], ['No chat', null, ['1:here:loose', '1:here:orphan']]]],
    ['PC-OLD', [['Unknown chat', null, ['1:PC-OLD:old1', '1:PC-OLD:old2']]]],
    ['PC-NEW', [['A chat on PC-NEW · s-there', null, ['1:PC-NEW:new']], ['No chat', null, ['1:PC-NEW:new-loose']]]]
  ])
  const shown = [...[...tasks.byRow.values()].flat(), ...tasks.unplaced.flatMap((b) => b.chats.flatMap((c) => c.nodes))].map((n) => n.worker)
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
  expect(tasks.unplaced).toEqual([])
})

test("one block per PC however different its tasks' reasons, and the heading counts what runs", () => {
  const bare = { sessionId: null, originSessionId: null, originWorkerId: null }
  const tasks = nestTasks([], [
    worker('a', 1, { ...bare, pc: 'PC-X' }),
    worker('b', 2, { ...bare, pc: 'PC-X', originSessionId: 's-gone-1234' }),
    worker('c', 3, { ...bare, pc: 'PC-Y' }),
    worker('d', 4, { ...bare })
  ])
  expect(tasks.unplaced.map((b) => [b.pc, b.chats.length])).toEqual([[null, 1], ['PC-X', 2], ['PC-Y', 1]])
  expect(unplacedHeading(tasks.unplaced[1]!)).toEqual({ title: 'On PC-X', count: 2 })
  expect(unplacedHeading(tasks.unplaced[0]!).title).toBe('On this PC')
})

test("three tasks from one unlisted chat on another PC share one stand-in, titled as that PC titles it, else by a short id", () => {
  const from = { pc: 'PC-X', originSessionId: '0123456789abcdef' }
  const named = nestTasks([], [
    worker('t1', 1, { ...from }),
    worker('t2', 2, { ...from, originTitle: 'Example refactor chat' }),
    worker('t3', 3, { ...from })
  ])
  const [block] = named.unplaced
  expect(block!.chats.map((c) => [c.title, listOf(c.nodes)])).toEqual([['Example refactor chat', ['1:PC-X:t1', '1:PC-X:t2', '1:PC-X:t3']]])
  expect(block!.chats[0]!.note).toContain("is on PC-X and is not in this PC's session list")
  const plain = nestTasks([], [worker('t1', 1, { ...from }), worker('t2', 2, { ...from })])
  expect(plain.unplaced[0]!.chats.map((c) => c.title)).toEqual(['A chat on PC-X · 01234567'])
})

test("a Desk chat running as a worker on another PC is its own stand-in, with its task one step in", () => {
  const chat = worker('desk-chat', 1, { pc: 'PC-X', group: 'hydra-desk', title: 'Example Desk chat' })
  const tasks = nestTasks([], [chat, worker('task', 2, { pc: 'PC-X', originWorkerId: 'desk-chat', originSessionId: 's-desk-chat' })])
  const [c] = tasks.unplaced[0]!.chats
  expect(tasks.unplaced[0]!.chats).toHaveLength(1)
  expect(c!.title).toBe('Example Desk chat')
  expect(c!.worker).toBe(chat)
  expect(listOf(c!.nodes)).toEqual(['1:PC-X:task'])
  expect(unplacedHeading(tasks.unplaced[0]!).count).toBe(2)
})

test("a task dispatched from a remote worker's earlier session sits under that worker", () => {
  const mgr = worker('mgr', 1, { pc: 'PC-X', originSessionId: 's-chat-abcd', sessionId: 's-new', sessions: ['s-old', 's-new'] })
  const kid = worker('kid', 2, { pc: 'PC-X', originSessionId: 's-old' })
  const tasks = nestTasks([], [mgr, kid])
  expect(tasks.unplaced[0]!.chats.map((c) => listOf(c.nodes))).toEqual([['1:PC-X:mgr', '2:PC-X:kid']])
})

// HSwarm jobs: nested under the row of the session that called HSwarm, apart from the CliMayte tasks.
function swarmJob(id: string, o: Partial<SwarmJob> = {}): SwarmJob {
  return { id, title: id, status: 'running', active: true, startedAt: 1, endedAt: null, tasks: { total: 4, done: 1, failed: 0, cancelled: 0 }, callerSessionId: null, callerHostSessionId: null, callerTitle: null, pc: null, ...o }
}

// (The old rule dropped a finished job with no drawn chat; it now sits under its stand-in like a finished task.)
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
  expect(nested.unplaced).toEqual([])
})

test('an HSwarm job no row has goes under its stand-in on this PC, finished or running, titled from callerTitle else by short id', () => {
  const jobs = [
    swarmJob('j-lost', { callerSessionId: '99999999' }),
    swarmJob('j-old', { callerSessionId: '99999999', status: 'done', active: false }),
    swarmJob('j-named', { callerSessionId: '11111111-2222-3333-4444-555555555555', callerTitle: 'Example chat', status: 'done', active: false })
  ]
  const nested = nestTasks([{ key: 'chat:a', sessionIds: ['s-a'] }], [], jobs)
  expect(nested.jobsByRow.size).toBe(0)
  expect(nested.unplaced).toHaveLength(1)
  const [block] = nested.unplaced
  expect(block!.pc).toBeNull()
  expect(block!.chats.map((c) => [c.title, c.jobs.map((j) => j.id), c.nodes.length])).toEqual([
    ['A chat · 99999999', ['j-lost', 'j-old'], 0],
    ['Example chat', ['j-named'], 0]
  ])
  // Only the running one counts in the heading.
  expect(unplacedHeading(block!).count).toBe(1)
})

test('a job and a task of the same unlisted chat share one stand-in, whether the job has the full id or its prefix', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const nested = nestTasks([], [worker('w1', 1, { originSessionId: sid })], [swarmJob('j-full', { callerSessionId: sid }), swarmJob('j-prefix', { callerSessionId: '11111111', status: 'done', active: false })])
  const chats = nested.unplaced.flatMap((b) => b.chats)
  expect(chats.map((c) => [c.nodes.length, c.jobs.map((j) => j.id)])).toEqual([[1, ['j-full', 'j-prefix']]])
})

test('an 8-character prefix that two rows share places the job under its stand-in, not under a guessed row', () => {
  const rows = [
    { key: 'chat:a', sessionIds: ['abcdef12-0000-4000-8000-000000000001'] },
    { key: 'chat:b', sessionIds: ['abcdef12-0000-4000-8000-000000000002'] }
  ]
  const nested = nestTasks(rows, [], [swarmJob('j-amb', { callerSessionId: 'abcdef12' })])
  expect(nested.jobsByRow.size).toBe(0)
  expect(nested.unplaced[0]!.chats.map((c) => [c.title, c.jobs.map((j) => j.id)])).toEqual([['A chat · abcdef12', ['j-amb']]])
})

test('in the cloud list (rows keyed cloud:<id>) a job sits under the cloud row of its caller session', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const rows = [{ key: `cloud:${sid}`, sessionIds: [sid] }]
  const nested = nestTasks(rows, [], [swarmJob('j-cloud', { callerSessionId: sid })])
  expect(nested.jobsByRow.get(`cloud:${sid}`)?.map((j) => j.id)).toEqual(['j-cloud'])
  expect(nested.unplaced).toEqual([])
})

test("the other PC's job goes under the row that has its session, else into that PC's block", () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const other = swarmJob('j-other', { callerSessionId: sid, pc: 'Other-PC' })
  const placed = nestTasks([{ key: 'cloud:x', sessionIds: [sid] }], [], [other])
  expect(placed.jobsByRow.get('cloud:x')?.map((j) => j.id)).toEqual(['j-other'])
  const lost = nestTasks([], [], [other, swarmJob('j-here', { callerSessionId: sid })])
  expect(lost.unplaced.map((b) => [b.pc, b.chats.map((c) => c.jobs.map((j) => j.id))])).toEqual([
    [null, [['j-here']]],
    ['Other-PC', [['j-other']]]
  ])
  expect(unplacedHeading(lost.unplaced[1]!).title).toBe('On Other-PC')
})
