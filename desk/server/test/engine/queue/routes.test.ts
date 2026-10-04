// The send queue's REST rows and /ws events through the real server (plugins/20-engine.ts) with a fake SDK
// query: hello carries the queue, every change is a queue.update, a queued message goes once the chat's
// turn ends, and a server stopped mid-turn holds that chat's queue at the next start.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, QueueItem, QueueState, ServerEvent, TranscriptItem } from '@shared/protocol'
import { QueueManager } from '../../../src/engine/queue'
import { createServer, type DeskServer } from '../../../src/index'
import { fakeBridge, fakeQueries, type FakeQuery } from '../manager/fakes'

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'src', 'plugins', '20-engine.ts')
const SID = 'queue-session-0001'

const temps: string[] = []
const servers: DeskServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close()
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

/** A desk server whose only plugin is the engine, on `home` (a new one unless given); the queue settles in 20 ms. */
async function boot(o: { home?: string } = {}) {
  const home = o.home ?? temp('desk-queue-home-')
  const plugins = temp('desk-queue-plugins-')
  writeFileSync(join(plugins, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const b = fakeBridge()
  const desk = await createServer({
    port: 0,
    home,
    pluginsDir: plugins,
    deps: { newChats: 'sdk', queryImpl: q.queryImpl, bridge: b.bridge, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, climaytePollMs: 20, queueSettleMs: 20 },
  })
  servers.push(desk)
  return { desk, home, ...q }
}

async function call<T = any>(desk: DeskServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await fetch(desk.url + path, init)
  return { status: res.status, body: (await res.json()) as T }
}

async function listen(desk: DeskServer): Promise<{ events: ServerEvent[]; hello: Extract<ServerEvent, { type: 'hello' }> }> {
  const ws = new WebSocket(desk.url.replace('http', 'ws') + '/ws')
  sockets.push(ws)
  const events: ServerEvent[] = []
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as ServerEvent)
  await waitFor(() => events.some((e) => e.type === 'hello'))
  return { events, hello: events.find((e) => e.type === 'hello') as Extract<ServerEvent, { type: 'hello' }> }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

let n = 0
const uuid = () => `50000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const init = (): SDKMessage => ({ type: 'system', subtype: 'init', session_id: SID, uuid: uuid(), cwd: '/', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', skills: [], plugins: [], claude_code_version: '2' }) as unknown as SDKMessage
const state = (s: 'running' | 'idle'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SID }) as unknown as SDKMessage
const textOf = (m: SDKUserMessage) => (m.message.content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')

/** Creates a chat with a prompt and brings its runtime to 'working'. */
async function working(t: Awaited<ReturnType<typeof boot>>): Promise<{ chat: ChatSummary; fake: FakeQuery }> {
  const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-queue-cwd-'), prompt: 'go' })
  const fake = t.last()
  fake.push(init(), state('running'))
  await waitFor(() => fake.sent.length === 1)
  const end = Date.now() + 3000
  while ((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body.status !== 'working') {
    if (Date.now() > end) throw new Error('the chat never started working')
    await pause(5)
  }
  return { chat, fake }
}

test('the queue routes: hello carries the queue, every change goes out as queue.update, bad bodies 400, unknown ids 404, conflicts 409', async () => {
  const t = await boot()
  const { events, hello } = await listen(t.desk)
  expect(hello.queue).toEqual({ items: [], paused: false, sendMode: 'immediate', maxNewChats: 2, held: {}, rev: 0 })
  const { chat } = await working(t)

  const a = await call<QueueItem>(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'after this turn' })
  expect(a.status).toBe(200)
  expect(a.body).toMatchObject({ kind: 'message', chatId: chat.id, state: 'waiting', text: 'after this turn' })
  await waitFor(() => events.some((e) => e.type === 'queue.update' && e.queue.items.some((i) => i.id === a.body.id)))
  expect((await call(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: 'nope', text: 'x' })).status).toBe(404)
  expect((await call(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: ' ' })).status).toBe(400)
  expect((await call(t.desk, 'POST', '/api/queue', { kind: 'later', text: 'x' })).status).toBe(400)
  expect((await call(t.desk, 'POST', '/api/queue', { kind: 'chat', cwd: 'relative/path', prompt: 'x' })).status).toBe(400)

  expect((await call(t.desk, 'PATCH', '/api/queue', { maxNewChats: 9 })).status).toBe(400)
  expect((await call(t.desk, 'PATCH', '/api/queue', { sendMode: 'later' })).status).toBe(400)
  const settings = await call<QueueState>(t.desk, 'PATCH', '/api/queue', { sendMode: 'queue', maxNewChats: 3 })
  expect(settings.body).toMatchObject({ sendMode: 'queue', maxNewChats: 3 })

  const b = await call<QueueItem>(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'second' })
  const { rev } = (await call<QueueState>(t.desk, 'GET', '/api/queue')).body
  expect((await call(t.desk, 'POST', '/api/queue/reorder', { ids: [b.body.id] })).status).toBe(409)
  expect((await call(t.desk, 'POST', '/api/queue/reorder', { ids: [b.body.id, a.body.id], ifRev: rev - 1 })).status).toBe(409)
  const order = await call<QueueState>(t.desk, 'POST', '/api/queue/reorder', { ids: [b.body.id, a.body.id], ifRev: rev })
  expect(order.body.items.map((i) => i.text)).toEqual(['second', 'after this turn'])

  expect((await call(t.desk, 'PATCH', `/api/queue/${a.body.id}`, { text: 'edited', ifRev: a.body.rev + 1 })).status).toBe(409)
  expect((await call(t.desk, 'PATCH', `/api/queue/${a.body.id}`, { title: 'x' })).status).toBe(400)
  expect((await call<QueueItem>(t.desk, 'PATCH', `/api/queue/${a.body.id}`, { text: 'edited', ifRev: a.body.rev })).body).toMatchObject({ text: 'edited', rev: a.body.rev + 1 })
  expect((await call(t.desk, 'POST', `/api/queue/${a.body.id}/retry`)).status).toBe(409)
  expect((await call(t.desk, 'POST', '/api/queue/nope/send-now')).status).toBe(404)

  expect((await call(t.desk, 'DELETE', `/api/queue/${b.body.id}`)).body).toEqual({ ok: true })
  expect((await call(t.desk, 'DELETE', `/api/queue/${b.body.id}`)).status).toBe(404)
  expect((await call<QueueState>(t.desk, 'GET', '/api/queue')).body.items.map((i) => i.text)).toEqual(['edited'])
})

test('a queued message goes to the chat once its turn ends, not into the running turn, under the uuid its transcript item gets', async () => {
  const t = await boot()
  const { chat, fake } = await working(t)
  await call(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'next' })
  await pause(100)
  expect(fake.sent).toHaveLength(1)

  fake.push(state('idle'))
  await waitFor(() => fake.sent.length === 2)
  const sent = fake.sent[1]!
  expect(textOf(sent)).toBe('next')
  const items = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chat.id}/items`)).body
  expect(items.find((i) => i.kind === 'user' && i.id === sent.uuid)).toMatchObject({ text: 'next' })
  expect(items.some((i) => i.kind === 'user' && i.queued)).toBe(false)
  expect((await call<QueueState>(t.desk, 'GET', '/api/queue')).body.items).toEqual([])
})

test('a queue that throws on every chat event breaks neither a create nor a plain send', async () => {
  const observe = QueueManager.prototype.observe
  const warn = console.warn
  const warned: string[] = []
  QueueManager.prototype.observe = () => {
    throw new Error('queue.json is held by another process')
  }
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '))
  try {
    const t = await boot()
    const { chat, fake } = await working(t)
    expect((await call(t.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: 'plain' })).status).toBe(200)
    await waitFor(() => fake.sent.length === 2)
    expect(textOf(fake.sent[1]!)).toBe('plain')
    expect(warned.some((w) => w.includes('the send queue could not take in chat.upsert: queue.json is held by another process'))).toBe(true)
  } finally {
    QueueManager.prototype.observe = observe
    console.warn = warn
  }
})

test('send-now hands a queued message to the running turn, as a plain Enter does', async () => {
  const t = await boot()
  const { chat, fake } = await working(t)
  const a = await call<QueueItem>(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'now please' })
  const now = await call(t.desk, 'POST', `/api/queue/${a.body.id}/send-now`)
  expect(now.body).toEqual({ ok: true, chatId: chat.id, queued: true })
  await waitFor(() => fake.sent.length === 2)
  expect(textOf(fake.sent[1]!)).toBe('now please')
  expect((await call<QueueState>(t.desk, 'GET', '/api/queue')).body.items).toEqual([])
})

test('a server stopped while a chat works holds its queue at the next start; resume sends it', async () => {
  const first = await boot()
  const { chat } = await working(first)
  await call(first.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'later' })
  await servers.splice(servers.indexOf(first.desk), 1)[0]!.stop()

  const second = await boot({ home: first.home })
  const { hello } = await listen(second.desk)
  expect(hello.queue).toMatchObject({ held: { [chat.id]: 'restart' }, items: [{ chatId: chat.id, text: 'later', state: 'held' }] })
  await pause(100)
  expect(second.all).toHaveLength(0)

  const resumed = await call<QueueState>(second.desk, 'POST', `/api/queue/chats/${chat.id}/resume`)
  expect(resumed.body.held).toEqual({})
  await waitFor(() => second.all.length === 1 && second.last().sent.length === 1)
  expect(textOf(second.last().sent[0]!)).toBe('later')
})
