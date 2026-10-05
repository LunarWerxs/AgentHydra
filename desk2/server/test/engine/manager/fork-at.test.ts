// Fork at a message (Claude Code's fork): a new chat with the history before one of the owner's messages,
// whose first send resumes the session cut at the entry before it. The message is found in its session
// file by its entry's uuid, else by its text (the same words sent twice told apart); a message that opened
// its session forks to a fresh chat; one no file has is refused. A CliMayte chat forks too, from the
// session (of several, across handoffs) that has the message, on the account whose folder holds it.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AccountInfo, ChatSummary, ServerEvent, TranscriptItem } from '@shared/protocol'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatError, ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { ahWorker, fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

const account = (num: number, configDir: string): AccountInfo => ({
  id: `acct-${num}`,
  label: `#${num} user${num} (Pro)`,
  configDir,
  number: num,
  email: null,
  plan: 'Pro',
  signedIn: true,
  fiveHourPct: 10,
  weeklyPct: 10,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false,
})

const SID = '5e5e5e5e-1111-4222-8333-444455556666'

type World = { cwd: string; a: AccountInfo; b: AccountInfo }

/** Desk's home with `chats` saved in it, a project folder, and two accounts whose folders AgentHydra lists. */
function boot(o: { chats?: (w: World) => { chat: ChatSummary; items: TranscriptItem[] }[]; items?: Record<string, TranscriptItem[]>; newChats?: 'climayte' | 'sdk' } = {}) {
  const home = temp('desk-forkat-')
  const cwd = temp('desk-cwd-')
  const a = account(35, temp('desk-acct-35-'))
  const b = account(61, temp('desk-acct-61-'))
  mkdirSync(join(home, 'chats'), { recursive: true })
  const saved = o.chats?.({ cwd, a, b }) ?? []
  writeFileSync(join(home, 'chats.json'), JSON.stringify(saved.map((c) => ({ ...c.chat, cwd }))))
  for (const c of saved) writeFileSync(join(home, 'chats', `${c.chat.id}.jsonl`), c.items.map((i) => JSON.stringify(i) + '\n').join(''))
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const fake = fakeBridge({ items: o.items, roots: [join(a.configDir!, 'projects'), join(b.configDir!, 'projects')] })
  const bridge: ManagerBridge = { ...fake.bridge, listAccounts: async () => [a, b] }
  const events: ServerEvent[] = []
  const m = new ChatManager({
    home,
    emit: (event) => events.push(event),
    settings: () => ({ ...DEFAULT_SETTINGS, defaultAccountId: a.id }),
    bridge,
    queryImpl: q.queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    newChats: o.newChats ?? 'sdk',
  })
  managers.push(m)
  return { m, cwd, a, b, state: fake.state, events, ...q }
}

/** A session transcript at <config dir>/projects/<cwd's folder>/<id>.jsonl, one entry a line. */
function session(configDir: string, cwd: string, id: string, entries: object[]): void {
  const file = join(configDir, 'projects', encodeProjectDir(cwd), `${id}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''))
}

const said = (uuid: string, parentUuid: string | null, content: unknown) => ({ type: 'user', uuid, parentUuid, sessionId: SID, message: { role: 'user', content } })
const reply = (uuid: string, parentUuid: string) => ({ type: 'assistant', uuid, parentUuid, sessionId: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })

/** Plan, then tomatoes (text blocks), a tool round trip, then "water them" twice. */
const ENTRIES = [
  said('u-1', null, 'Plan the garden beds'),
  reply('a-1', 'u-1'),
  said('u-2', 'a-1', [{ type: 'text', text: 'Add a row of\ntomatoes' }]),
  reply('a-2', 'u-2'),
  said('t-1', 'a-2', [{ type: 'tool_result', tool_use_id: 'x', content: 'Water them' }]),
  { type: 'user', uuid: 'm-1', parentUuid: 't-1', isMeta: true, message: { role: 'user', content: 'Water them' } },
  said('u-3', 'm-1', 'Water them'),
  reply('a-3', 'u-3'),
  said('u-4', 'a-3', 'Water them'),
  reply('a-4', 'u-4'),
]

/** The Desk side of ENTRIES: the "water them" items carry ids no entry has (an older chat's). */
const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u-1', ts: 1, text: 'Plan the garden beds' },
  { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'ok' },
  { kind: 'user', id: 'u-2', ts: 3, text: 'Add a row of tomatoes' },
  { kind: 'assistant_text', id: 'a-2', ts: 4, text: 'ok' },
  { kind: 'user', id: 'old-3', ts: 5, text: 'Water  them' },
  { kind: 'assistant_text', id: 'a-3', ts: 6, text: 'ok' },
  { kind: 'user', id: 'old-4', ts: 7, text: 'Water them' },
  { kind: 'assistant_text', id: 'a-4', ts: 8, text: 'ok' },
]

function record(over: Partial<ChatSummary>): ChatSummary {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    sessionId: SID,
    title: 'Garden',
    cwd: '/',
    account: { id: 'acct-35', label: '#35 user35 (Pro)', configDir: null },
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: true,
    archived: false,
    group: 'Yard',
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 1,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over,
  }
}

/** The items the windows were told to take out of the chat, in order. */
const removed = (events: ServerEvent[], chatId: string) => events.flatMap((e) => (e.type === 'item.removed' && e.chatId === chatId ? [e.itemId] : []))

async function refusal(p: Promise<unknown>): Promise<ChatError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(err instanceof ChatError)) throw new Error(`expected a ChatError, got ${String(err)}`)
  return err
}

test("a chat's fork at a message has the history before it, and its first send resumes the session cut just before it", async () => {
  const src = record({})
  const t = boot({ chats: (w) => [{ chat: { ...src, account: { ...src.account, configDir: w.a.configDir } }, items: ITEMS }] })
  session(t.a.configDir!, t.cwd, SID, ENTRIES)

  const fork = await t.m.forkBefore(src.id, 'u-2')
  expect(fork).toMatchObject({ title: 'Garden (fork)', sessionId: null, forkedFrom: SID, status: 'closed', group: 'Yard', pinned: false, account: { id: 'acct-35' } })
  expect(t.m.listItems(fork.id).map((i) => i.id)).toEqual(['u-1', 'a-1'])
  expect(t.m.listItems(src.id)).toHaveLength(ITEMS.length)
  await t.m.send(fork.id, 'Add a row of peppers')
  expect(t.last().options).toMatchObject({ resume: SID, forkSession: true, resumeSessionAt: 'a-1', env: { CLAUDE_CONFIG_DIR: t.a.configDir } })
})

test('a message whose id no entry has is found by its text, the same words sent twice told apart; a tool result or meta line never counts', async () => {
  // The chat's account folder lacks the session: the folders AgentHydra lists find it.
  const src = record({})
  const t = boot({ chats: () => [{ chat: src, items: ITEMS }] })
  session(t.b.configDir!, t.cwd, SID, ENTRIES)

  const first = await t.m.forkBefore(src.id, 'old-3')
  expect(t.m.listItems(first.id).map((i) => i.id)).toEqual(['u-1', 'a-1', 'u-2', 'a-2'])
  await t.m.send(first.id, 'go')
  expect(t.last().options.resumeSessionAt).toBe('m-1')

  const second = await t.m.forkBefore(src.id, 'old-4')
  await t.m.send(second.id, 'go')
  expect(t.last().options.resumeSessionAt).toBe('a-3')
})

test('a fork at the message that opened the session is a fresh chat; one no session file has, or not the owner\'s, is refused', async () => {
  const src = record({})
  const t = boot({ chats: (w) => [{ chat: { ...src, account: { ...src.account, configDir: w.a.configDir } }, items: [...ITEMS, { kind: 'user', id: 'lost', ts: 9, text: 'Never sent anywhere' }] }] })
  session(t.a.configDir!, t.cwd, SID, ENTRIES)

  const fresh = await t.m.forkBefore(src.id, 'u-1')
  expect(fresh).toMatchObject({ sessionId: null, forkedFrom: null })
  expect(t.m.listItems(fresh.id)).toEqual([])
  await t.m.send(fresh.id, 'Plan the garden beds again')
  expect(t.last().options.resume).toBeUndefined()

  const lost = await refusal(t.m.forkBefore(src.id, 'lost'))
  expect(lost.status).toBe(409)
  expect(lost.message).toMatch(/could not find this message in its session file/i)
  expect((await refusal(t.m.forkBefore(src.id, 'a-1'))).status).toBe(400)
  expect((await refusal(t.m.forkBefore(src.id, 'nope'))).status).toBe(400)
  expect(t.m.list({ archived: true })).toHaveLength(2)
})

test("a CliMayte chat forks from the session of its worker that has the message, on the account whose folder holds it", async () => {
  const OLD = '6a6a6a6a-1111-4222-8333-444455556666'
  const src = record({ sessionId: 'worker-session-2', workerId: 'w1', workerIds: ['w9'], account: { id: 'cli-2', label: '#62', configDir: null }, accountAuto: true, climayteActive: 1 })
  const t = boot({ chats: () => [{ chat: src, items: ITEMS }], newChats: 'climayte' })
  t.state.rows.push(ahWorker({ id: 'w1', status: 'done', sessions: [OLD], sessionId: 'worker-session-2', accountId: 'cli-2', cwd: t.cwd }))
  // The first session ran on #61 before CliMayte handed the worker on; the second has only the handoff.
  session(t.b.configDir!, t.cwd, OLD, ENTRIES)
  session(t.a.configDir!, t.cwd, 'worker-session-2', [said('h-1', null, 'Continue the garden task from the handoff notes')])

  const fork = await t.m.forkBefore(src.id, 'u-2')
  expect(fork).not.toHaveProperty('workerId')
  expect(fork).not.toHaveProperty('workerIds')
  expect(fork).toMatchObject({ forkedFrom: OLD, account: { id: 'acct-61', configDir: t.b.configDir }, accountAuto: true, climayteActive: 0 })
  expect(t.m.listItems(fork.id).map((i) => i.id)).toEqual(['u-1', 'a-1'])
  await t.m.send(fork.id, 'Add a row of peppers')
  expect(t.state.sentToWorker).toEqual([])
  expect(t.last().options).toMatchObject({ resume: OLD, forkSession: true, resumeSessionAt: 'a-1', env: { CLAUDE_CONFIG_DIR: t.b.configDir } })

  // At its first message: a CliMayte chat again, its worker started by the first send.
  const fresh = await t.m.forkBefore(src.id, 'u-1')
  expect(fresh).toMatchObject({ workerId: null, forkedFrom: null, account: { id: 'climayte' } })
})

test("an outside session forks at one of its messages: the history before it, cut there", async () => {
  const t = boot({ items: { [SID]: ITEMS } })
  session(t.a.configDir!, t.cwd, SID, ENTRIES)
  const fork = await t.m.importSession({ sessionId: SID, cwd: t.cwd, title: 'Desktop chat', configDir: t.a.configDir, fork: true, at: 'old-4' })
  expect(fork).toMatchObject({ title: 'Desktop chat (fork)', sessionId: null, forkedFrom: SID })
  expect(t.m.listItems(fork.id).map((i) => i.id)).toEqual(['u-1', 'a-1', 'u-2', 'a-2', 'old-3', 'a-3'])
  await t.m.send(fork.id, 'go')
  expect(t.last().options).toMatchObject({ resume: SID, forkSession: true, resumeSessionAt: 'a-3' })
  expect((await refusal(t.m.importSession({ sessionId: SID, cwd: t.cwd, configDir: t.a.configDir, fork: true, at: 'a-1' }))).status).toBe(400)
})

test('Undo at a message takes it and all after it out of the same chat, and its next send resumes the session cut just before it', async () => {
  const src = record({})
  const t = boot({ chats: (w) => [{ chat: { ...src, account: { ...src.account, configDir: w.a.configDir } }, items: ITEMS }] })
  session(t.a.configDir!, t.cwd, SID, ENTRIES)

  const back = await t.m.rewind(src.id, 'u-2')
  expect(back).toMatchObject({ id: src.id, title: 'Garden', sessionId: null, forkedFrom: SID, status: 'closed', pinned: true, group: 'Yard', account: { id: 'acct-35' } })
  expect(t.m.list({ archived: true })).toHaveLength(1)
  expect(t.m.listItems(src.id).map((i) => i.id)).toEqual(['u-1', 'a-1'])
  expect(removed(t.events, src.id)).toEqual(['u-2', 'a-2', 'old-3', 'a-3', 'old-4', 'a-4'])
  // The session with the turns taken back is still this chat's own, never listed under Elsewhere.
  expect(t.m.sessionIds()).toContain(SID)
  await t.m.send(src.id, 'Add a row of peppers')
  expect(t.last().options).toMatchObject({ resume: SID, forkSession: true, resumeSessionAt: 'a-1', env: { CLAUDE_CONFIG_DIR: t.a.configDir } })
})

test('Undo during a running turn stops it first; at the message that opened the session the chat is left empty and starts afresh; a refused Undo changes nothing', async () => {
  const src = record({})
  const t = boot({ chats: (w) => [{ chat: { ...src, account: { ...src.account, configDir: w.a.configDir } }, items: [...ITEMS, { kind: 'user', id: 'lost', ts: 9, text: 'Never sent anywhere' }] }] })
  session(t.a.configDir!, t.cwd, SID, ENTRIES)

  expect((await refusal(t.m.rewind(src.id, 'lost'))).message).toMatch(/no telling where the chat would go back to/)
  expect((await refusal(t.m.rewind(src.id, 'a-1'))).status).toBe(400)
  expect(t.m.listItems(src.id)).toHaveLength(ITEMS.length + 1)
  expect(t.m.get(src.id)).toMatchObject({ sessionId: SID })

  await t.m.send(src.id, 'Water them again')
  const running = t.last()
  expect(running.calls.close).toBe(0)
  const back = await t.m.rewind(src.id, 'u-1')
  expect(running.calls.close).toBe(1)
  expect(back).toMatchObject({ sessionId: null, forkedFrom: null, status: 'closed' })
  expect(t.m.listItems(src.id)).toEqual([])
  await t.m.send(src.id, 'Plan the garden beds again')
  expect(t.last()).not.toBe(running)
  expect(t.last().options.resume).toBeUndefined()
})

test("Undo in a CliMayte chat cancels its worker, and the chat goes on from the session that has the message, on the account whose folder holds it", async () => {
  const OLD = '6a6a6a6a-1111-4222-8333-444455556666'
  const src = record({ sessionId: 'worker-session-2', workerId: 'w1', workerIds: ['w9'], account: { id: 'cli-2', label: '#62', configDir: null }, accountAuto: true })
  const t = boot({ chats: () => [{ chat: src, items: ITEMS }], newChats: 'climayte' })
  t.state.rows.push(ahWorker({ id: 'w1', status: 'running', sessions: [OLD], sessionId: 'worker-session-2', accountId: 'cli-2', cwd: t.cwd }))
  session(t.b.configDir!, t.cwd, OLD, ENTRIES)
  session(t.a.configDir!, t.cwd, 'worker-session-2', [said('h-1', null, 'Continue the garden task from the handoff notes')])

  const back = await t.m.rewind(src.id, 'u-2')
  expect(t.state.cancelled).toEqual(['w1'])
  expect(back).not.toHaveProperty('workerId')
  // The workers it handed work to are still its own.
  expect(back).toMatchObject({ id: src.id, workerIds: ['w9'], sessionId: null, forkedFrom: OLD, account: { id: 'acct-61', configDir: t.b.configDir }, accountAuto: true })
  expect(t.m.listItems(src.id).map((i) => i.id)).toEqual(['u-1', 'a-1'])
  await t.m.send(src.id, 'Add a row of peppers')
  expect(t.state.sentToWorker).toEqual([])
  expect(t.last().options).toMatchObject({ resume: OLD, forkSession: true, resumeSessionAt: 'a-1', env: { CLAUDE_CONFIG_DIR: t.b.configDir } })
})
