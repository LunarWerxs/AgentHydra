// A CliMayte worker's folder is the chat's folder too (SPEC "A chat moves folders", two ways): the folder
// AgentHydra reports for the worker (its pending folder, else its current one) moves the chat when the chat
// still sits where the worker was last started or sent. A folder the Desk side set moves the worker, not back.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))
const movedLines = (m: ChatManager, id: string) => systemTexts(m.listItems(id)).filter((s) => s.startsWith('Moved this chat'))

function newManager(home: string, b: ReturnType<typeof fakeBridge>) {
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)
  return m
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'desk-wcwd-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const base = mkdtempSync(join(tmpdir(), 'desk-wcwd-folders-'))
  temps.push(base)
  const a = join(base, 'A')
  const x = join(base, 'X')
  mkdirSync(a, { recursive: true })
  mkdirSync(x, { recursive: true })
  return { home, base, a, x }
}

async function startedChat(home: string, cwd: string) {
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd, prompt: 'go' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  return { b, m, chat, row: b.state.rows[0]! }
}

test('a folder AgentHydra gives the worker moves the chat at once, with one line, and the next send passes nothing back', async () => {
  const { home, a, x } = setup()
  const { b, m, chat, row } = await startedChat(home, a)
  row.pendingCwd = x
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).cwd).toBe(x)
  expect(movedLines(m, chat.id)).toEqual([`Moved this chat to ${x}.`])
  await m.send(chat.id, 'now there')
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'now there' })
})

test('a worker that is already in a new folder (launched with it) moves the chat there too', async () => {
  const { home, a, x } = setup()
  const { m, chat, row } = await startedChat(home, a)
  row.cwd = x
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).cwd).toBe(x)
  expect(movedLines(m, chat.id)).toEqual([`Moved this chat to ${x}.`])
})

test('a UNC path or a folder that does not exist never moves the chat', async () => {
  const { home, base, a } = setup()
  const { m, chat, row } = await startedChat(home, a)
  row.pendingCwd = '//files.example.test/share/projects'
  await m.syncWorkers(chat.id)
  row.pendingCwd = join(base, 'missing')
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).cwd).toBe(a)
  expect(movedLines(m, chat.id)).toEqual([])
})

test('a folder the Desk side set is not undone by the worker still in the old folder, and the send passes it once', async () => {
  const { home, a, x } = setup()
  const { b, m, chat, row } = await startedChat(home, a)
  await m.patch(chat.id, { cwd: x })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).cwd).toBe(x)
  await m.send(chat.id, 'one')
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'one', cwd: x })
  // AgentHydra keeps the folder it was sent as its pending folder until the next launch: no move back, no second pass.
  row.pendingCwd = x
  await m.syncWorkers(chat.id)
  await m.send(chat.id, 'two')
  expect(m.get(chat.id).cwd).toBe(x)
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'two' })
  expect(movedLines(m, chat.id)).toEqual([])
})

test('a restarted server keeps the move and does not move the chat again', async () => {
  const { home, a, x } = setup()
  const { m, chat, row } = await startedChat(home, a)
  row.pendingCwd = x
  await m.syncWorkers(chat.id)
  await m.closeAll()

  const b2 = fakeBridge()
  b2.state.rows.push(row)
  const m2 = newManager(home, b2)
  await m2.syncWorkers(chat.id)
  expect(m2.get(chat.id).cwd).toBe(x)
  expect(movedLines(m2, chat.id)).toEqual([`Moved this chat to ${x}.`])
  await m2.send(chat.id, 'after restart')
  expect(b2.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'after restart' })
})
