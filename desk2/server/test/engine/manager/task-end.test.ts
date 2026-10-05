// A background task ends with the process that ran its session (2026-10-05: a chat's panel said '3 running tasks'
// for five hours after its session had ended, its sidebar grey). When that process is gone (an SDK runtime closed,
// a worker finished, moved to another account or continued in a fresh session, a restart), each of its task items
// still 'running' is settled 'stopped' with TASK_SESSION_ENDED, on disk and live, and the sidebar's count agrees.
// A task in a live runtime, and a long-lived one (a local server), are left as they are.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerEvent, TranscriptItem } from '@shared/protocol'
import { ChatManager, TASK_SESSION_ENDED } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup(o: { newChats?: 'sdk'; home?: string } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'desk-task-end-'))
  if (!o.home) temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const q = fakeQueries()
  const events: ServerEvent[] = []
  const m = new ChatManager({ home, emit: (e) => events.push(e), settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, ...(o.newChats ? { newChats: o.newChats } : {}) })
  managers.push(m)
  return { home, m, b, q, events }
}

type Task = Extract<TranscriptItem, { kind: 'task' }>
const task = (taskId: string, description: string, ts = 5): Task => ({ kind: 'task', id: `task:${taskId}`, ts, taskId, description, status: 'running', taskKind: 'bash' })
const taskOf = (items: TranscriptItem[], taskId: string): Task | undefined => items.find((i): i is Task => i.kind === 'task' && i.taskId === taskId)
/** What the panel counts: running task items that are not long-lived. */
const runningIds = (items: TranscriptItem[]): string[] => items.flatMap((i) => (i.kind === 'task' && i.status === 'running' && !/localhost/.test(i.description) ? [i.taskId] : []))

const started = (taskId: string, description: string): SDKMessage =>
  ({ type: 'system', subtype: 'task_started', task_id: taskId, description, task_type: 'local_bash', uuid: `70000000-0000-4000-8000-${taskId.padStart(12, '0')}`, session_id: 's' }) as unknown as SDKMessage

test('an SDK chat: a running task stays running while its runtime runs and is settled as ended when the runtime closes', async () => {
  const { home, m, q, events } = setup({ newChats: 'sdk' })
  const chat = await m.create({ cwd: home, prompt: 'start the build' })
  await waitFor(() => q.all.length > 0)
  q.last().push(started('1', 'Land the almanac note'), started('2', 'npm run dev on localhost:5173'))
  await waitFor(() => m.get(chat.id).backgroundActive === 1)

  // Live: untouched, and the sidebar counts what the panel shows.
  expect(taskOf(m.listItems(chat.id), '1')?.status).toBe('running')
  expect(runningIds(m.listItems(chat.id))).toEqual(['1'])

  await m.closeAll({ chats: true })
  const items = m.listItems(chat.id)
  expect(taskOf(items, '1')).toMatchObject({ status: 'stopped', summary: TASK_SESSION_ENDED, description: 'Land the almanac note' })
  expect(taskOf(items, '1')?.durationMs).toBeNumber()
  // Long-lived: as it was.
  expect(taskOf(items, '2')?.status).toBe('running')
  expect(m.get(chat.id).backgroundActive ?? 0).toBe(0)
  expect(runningIds(items)).toEqual([])
  // Every window was told, not only a later reload.
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.upsert', chatId: chat.id, item: expect.objectContaining({ taskId: '1', status: 'stopped' }) }))
})

test('after a restart, an SDK chat no host kept settles the tasks its Desk file still says are running', async () => {
  const first = setup({ newChats: 'sdk' })
  const chat = await first.m.create({ cwd: first.home })
  first.m.store.appendItem(chat.id, task('b6o886gzv', 'Wait (bounded) for typecheck and almanac land'))
  await first.m.closeAll()

  const { m } = setup({ newChats: 'sdk', home: first.home })
  const items = m.listItems(chat.id)
  expect(taskOf(items, 'b6o886gzv')).toMatchObject({ status: 'stopped', summary: TASK_SESSION_ENDED })
  // On disk too: the next read finds it settled.
  expect(taskOf(m.store.loadItems(chat.id), 'b6o886gzv')?.status).toBe('stopped')
})

async function workerChat(s: ReturnType<typeof setup>) {
  const chat = await s.m.create({ cwd: s.home, prompt: 'land the almanac' })
  await waitFor(() => !!s.m.get(chat.id).workerId)
  const row = s.b.state.rows[0]!
  Object.assign(row, { status: 'running', accountId: 'cli-110', account: '#110 a' })
  s.b.state.workerItems['worker-session-1'] = [task('t1', 'Land the almanac note'), task('t2', 'serve on localhost:8000')]
  await s.m.syncWorkers(chat.id)
  expect(s.m.get(chat.id).backgroundActive).toBe(1)
  expect(taskOf(s.m.listItems(chat.id), 't1')?.status).toBe('running')
  return { chat, row }
}

test('a CliMayte chat: its worker finished, so the tasks it left running are settled, and stay so', async () => {
  const s = setup()
  const { chat, row } = await workerChat(s)

  Object.assign(row, { status: 'done' })
  await s.m.syncWorkers(chat.id)
  const items = s.m.listItems(chat.id)
  expect(taskOf(items, 't1')).toMatchObject({ status: 'stopped', summary: TASK_SESSION_ENDED })
  expect(taskOf(items, 't2')?.status).toBe('running')
  expect(s.m.get(chat.id).backgroundActive ?? 0).toBe(0)
  expect(runningIds(items)).toEqual([])

  // The next message revives the same session: its JSONL still says 'running', which never undoes the end.
  Object.assign(row, { status: 'running' })
  s.b.state.workerItems['worker-session-1'] = [...s.b.state.workerItems['worker-session-1']!, { kind: 'assistant_text', id: 'a-2', ts: 9, text: 'again' }]
  await s.m.send(chat.id, 'and again')
  await s.m.syncWorkers(chat.id)
  expect(taskOf(s.m.listItems(chat.id), 't1')?.status).toBe('stopped')
  expect(s.m.get(chat.id).backgroundActive ?? 0).toBe(0)
})

test('a CliMayte chat moved to another account and continued in a fresh session: the old session\'s tasks end, the new one\'s run', async () => {
  const s = setup()
  const { chat, row } = await workerChat(s)

  // CliMayte moved this chat from #110 to #168, continuing it in a fresh session that started a task of its own.
  Object.assign(row, { accountId: 'cli-168', account: '#168 b', sessions: ['worker-session-1'], sessionId: 'worker-session-2' })
  s.b.state.workerItems['worker-session-2'] = [task('t3', 'Land the almanac update in the background', 20)]
  await s.m.syncWorkers(chat.id)
  await s.m.syncWorkers(chat.id)
  const items = s.m.listItems(chat.id)
  expect(taskOf(items, 't1')).toMatchObject({ status: 'stopped', summary: TASK_SESSION_ENDED })
  expect(taskOf(items, 't3')?.status).toBe('running')
  expect(s.m.get(chat.id).backgroundActive).toBe(1)
  expect(runningIds(items)).toEqual(['t3'])

  // Reloaded (a restart): the end holds against the old JSONL, the live task still counts.
  await s.m.closeAll()
  const again = setup({ home: s.home })
  again.b.state.rows.push(row)
  again.b.state.workerItems = s.b.state.workerItems
  await again.m.syncWorkers(chat.id)
  const reloaded = again.m.listItems(chat.id)
  expect(taskOf(reloaded, 't1')?.status).toBe('stopped')
  expect(taskOf(reloaded, 't3')?.status).toBe('running')
})

test('a CliMayte chat moved to another account in the same session: the tasks of the process that ran it end', async () => {
  const s = setup()
  const { chat, row } = await workerChat(s)
  Object.assign(row, { accountId: 'cli-168', account: '#168 b' })
  await s.m.syncWorkers(chat.id)
  expect(taskOf(s.m.listItems(chat.id), 't1')?.status).toBe('stopped')
  expect(s.m.get(chat.id).backgroundActive ?? 0).toBe(0)
})
