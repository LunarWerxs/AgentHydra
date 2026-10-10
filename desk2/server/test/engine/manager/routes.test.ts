// plugins/20-engine.ts through the real server with a fake SDK query: the chat REST rows, the /ws
// events they cause, and the lifecycle across a server restart on the same home.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, ExternalSession, QueueState, ServerEvent, SessionMeta, TranscriptItem } from '@shared/protocol'
import { createServer, type DeskServer } from '../../../src/index'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { titleFrom } from '@shared/chat-title'
import { FailureLedger } from '../../../src/engine/failures'
import { explorerArg } from '../../../src/engine/reveal'
import { STATIC_COMMANDS, STATIC_MODELS } from '../../../src/engine/models'
import { ACCOUNT_68, fakeBridge, fakeQueries, worker, type FakeQuery } from './fakes'

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'src', 'plugins', '20-engine.ts')
const FIXTURE_SID = 'bc02ba58-0cd0-4a7d-8e96-e0055fcccd74'
const SID = 'manager-session-0001'

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

type Fakes = ReturnType<typeof fakeQueries> & ReturnType<typeof fakeBridge>

/** A desk server whose only plugin is the engine, on `home` (a new one unless given). */
async function boot(o: { home?: string; bridge?: ReturnType<typeof fakeBridge>; deps?: Record<string, unknown> } = {}): Promise<{ desk: DeskServer; home: string } & Fakes> {
  const home = o.home ?? temp('desk-manager-home-')
  const plugins = temp('desk-manager-plugins-')
  writeFileSync(join(plugins, '20-engine.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const b = o.bridge ?? fakeBridge()
  const desk = await createServer({
    port: 0,
    home,
    pluginsDir: plugins,
    deps: { newChats: 'sdk', queryImpl: q.queryImpl, bridge: b.bridge, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, claudeHome: home, climaytePollMs: 20, ...o.deps },
  })
  servers.push(desk)
  return { desk, home, ...q, ...b }
}

async function call<T = any>(desk: DeskServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await fetch(desk.url + path, init)
  return { status: res.status, body: (await res.json()) as T }
}

/** A /ws connection collecting every event; resolves once hello arrived. */
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

function loadJsonl(name: string): SDKMessage[] {
  return readFileSync(join(import.meta.dir, '..', '..', 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SDKMessage)
}

let n = 0
const uuid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const init = (): SDKMessage => ({ type: 'system', subtype: 'init', session_id: SID, uuid: uuid(), cwd: '/', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', skills: [], plugins: [], claude_code_version: '2' }) as unknown as SDKMessage
const state = (s: 'running' | 'idle' | 'requires_action'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SID }) as unknown as SDKMessage
const result = (queued?: number): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 9,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    result: 'ok',
    uuid: uuid(),
    session_id: SID,
    ...(queued === undefined ? {} : { queued_turn_count: queued }),
  }) as unknown as SDKMessage

const chatEvents = (events: ServerEvent[], id: string) => events.flatMap((e) => (e.type === 'chat.upsert' && e.chat.id === id ? [e.chat] : []))
const statuses = (events: ServerEvent[], id: string) => chatEvents(events, id).map((c) => c.status)

/** Polls GET /api/chats/:id until the chat has `status`. */
async function untilStatus(desk: DeskServer, id: string, status: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while ((await call<ChatSummary>(desk, 'GET', `/api/chats/${id}`)).body.status !== status) {
    if (Date.now() > end) throw new Error(`chat ${id} never reached ${status}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Creates a chat with a prompt and brings its runtime to 'working'. */
async function working(t: Awaited<ReturnType<typeof boot>>, cwd: string): Promise<{ chat: ChatSummary; fake: FakeQuery }> {
  const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd, prompt: 'go' })
  const fake = t.last()
  fake.push(init(), state('running'))
  await waitFor(() => fake.sent.length === 1)
  await untilStatus(t.desk, chat.id, 'working')
  return { chat, fake }
}

describe('chat routes', () => {
  test('create streams a turn over /ws and stores it; title, account and options', async () => {
    const t = await boot()
    const cwd = temp('desk-cwd-')
    const { events, hello } = await listen(t.desk)
    expect(hello.chats).toEqual([])
    expect(hello.settings.defaultPermissionMode).toBe('bypassPermissions')

    const prompt = 'What does notes.txt say? Please read the file and tell me exactly what it contains today\nsecond line'
    const res = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd, prompt, effort: 'high', accountId: ACCOUNT_68.id })
    expect(res.status).toBe(200)
    const chat = res.body
    expect(chat.title).toBe(titleFrom(prompt))
    expect(chat.title.length).toBeLessThanOrEqual(60)
    expect(chat.title.startsWith('What does notes.txt say?')).toBe(true)
    expect(chat.account).toEqual({ id: ACCOUNT_68.id, label: ACCOUNT_68.label, configDir: ACCOUNT_68.configDir, number: 68 })
    expect(chat.status).toBe('starting')

    const fake = t.last()
    expect(fake.options.cwd).toBe(cwd)
    expect(fake.options.env?.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_68.configDir!)
    expect(fake.options.effort).toBe('high')
    expect(fake.options.permissionMode).toBe('bypassPermissions')
    expect(fake.options.resume).toBeUndefined()
    await waitFor(() => fake.sent.length === 1)
    expect((fake.sent[0]!.message as { content: unknown }).content).toEqual([{ type: 'text', text: prompt }])

    fake.push(...loadJsonl('basic-turn.jsonl'))
    await waitFor(() => statuses(events, chat.id).at(-1) === 'idle')
    const seen = statuses(events, chat.id)
    expect(seen).toContain('working')
    expect(seen.indexOf('working')).toBeLessThan(seen.lastIndexOf('idle'))
    expect(events.some((e) => e.type === 'item.upsert' && e.chatId === chat.id && e.item.kind === 'user')).toBe(true)
    expect(events.some((e) => e.type === 'item.delta' && e.chatId === chat.id)).toBe(true)
    await waitFor(() => events.some((e) => e.type === 'notify' && e.chatId === chat.id && e.reason === 'finished'))

    const got = (await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body
    expect(got).toMatchObject({ status: 'idle', sessionId: FIXTURE_SID, unread: true })
    const items = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chat.id}/items`)).body
    expect(items.find((i) => i.kind === 'assistant_text')).toMatchObject({ text: 'The meeting is Thursday at 10am.' })

    // reading it clears unread
    const read = await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, { unread: false })
    expect(read.body.unread).toBe(false)
  })

  test('create refuses bad input with the reason', async () => {
    const t = await boot()
    const rel = await call(t.desk, 'POST', '/api/chats', { cwd: 'not/absolute' })
    expect(rel.status).toBe(400)
    expect(rel.body.error).toMatch(/absolute/)
    const missing = await call(t.desk, 'POST', '/api/chats', { cwd: join(tmpdir(), 'desk-no-such-folder-xyz') })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toMatch(/does not exist/)
    const badEffort = await call(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), effort: 'huge' })
    expect(badEffort.status).toBe(400)
    expect(badEffort.body.error).toMatch(/effort must be one of/)
    const badAccount = await call(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), accountId: 'inst-nope' })
    expect(badAccount.status).toBe(400)
    expect(badAccount.body.error).toMatch(/unknown account inst-nope/)
    const notJson = await call(t.desk, 'POST', '/api/chats', '{oops')
    expect(notJson.status).toBe(400)
    expect(notJson.body.error).toBe('the body must be JSON')
    expect((await call(t.desk, 'GET', '/api/chats/nope')).status).toBe(404)
    // a chat with no prompt does not start a runtime
    const empty = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), accountId: 'default' })
    expect(empty.body).toMatchObject({ status: 'closed', title: 'New session', account: { id: 'default', configDir: null } })
    expect(t.all).toHaveLength(0)
  })

  test('a send while working is queued; interrupt stops the turn', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const { chat, fake } = await working(t, temp('desk-cwd-'))

    const second = await call(t.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: 'and then this' })
    expect(second.body).toEqual({ queued: true })
    await waitFor(() => fake.sent.length === 2)
    await waitFor(() => events.some((e) => e.type === 'item.upsert' && e.item.kind === 'user' && e.item.text === 'and then this' && e.item.queued === true))
    await waitFor(() => chatEvents(events, chat.id).at(-1)?.queuedCount === 1)

    expect((await call(t.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: '  ' })).status).toBe(400)

    const stop = await call(t.desk, 'POST', `/api/chats/${chat.id}/interrupt`)
    expect(stop.body).toEqual({ ok: true })
    expect(fake.calls.interrupt).toBe(1)
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body.status).toBe('stopped')
    await waitFor(() => statuses(events, chat.id).includes('stopped'))
  })

  test('Stop on a background task: the process stops it and its notice settles it; one the process no longer runs is settled here', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const { chat, fake } = await working(t, temp('desk-cwd-'))
    const sys = (subtype: string, more: Record<string, unknown>): SDKMessage => ({ type: 'system', subtype, uuid: uuid(), session_id: SID, ...more }) as unknown as SDKMessage
    const started = (id: string) => sys('task_started', { task_id: id, description: `check ${id}`, task_type: 'local_bash' })
    fake.push(started('b1'), started('b2'), sys('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'check b1' }] }))
    await waitFor(() => chatEvents(events, chat.id).at(-1)?.backgroundActive === 2)
    fake.onStopTask = (id) => fake.push(sys('task_notification', { task_id: id, status: 'stopped', summary: 'Stopped by the user', output_file: '' }))

    const one = await call<{ item: TranscriptItem }>(t.desk, 'POST', `/api/chats/${chat.id}/tasks/b1/stop`)
    expect(one.status).toBe(200)
    expect(fake.calls.stopTask).toEqual(['b1'])
    expect(one.body.item).toMatchObject({ kind: 'task', taskId: 'b1', status: 'stopped', summary: 'Stopped by the user' })

    // b2 is not among the tasks the process says are alive: no control message, settled by the Desk.
    const two = await call<{ item: TranscriptItem }>(t.desk, 'POST', `/api/chats/${chat.id}/tasks/b2/stop`)
    expect(fake.calls.stopTask).toEqual(['b1'])
    expect(two.body.item).toMatchObject({ kind: 'task', taskId: 'b2', status: 'stopped', summary: 'Stopped from Hydra Desk.' })
    await waitFor(() => events.some((e) => e.type === 'item.upsert' && e.item.kind === 'task' && e.item.taskId === 'b2' && e.item.status === 'stopped'))
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body.backgroundActive).toBe(0)
    const stored = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chat.id}/items`)).body.filter((i) => i.kind === 'task')
    expect(stored.map((i) => i.kind === 'task' && i.status)).toEqual(['stopped', 'stopped'])
    // The chat's turn goes on: stopping a task is not a Stop.
    expect(fake.calls.interrupt).toBe(0)

    // A settled task stays as it is; an unknown one is a 404.
    expect((await call<{ item: TranscriptItem }>(t.desk, 'POST', `/api/chats/${chat.id}/tasks/b1/stop`)).body.item).toMatchObject({ summary: 'Stopped by the user' })
    expect((await call(t.desk, 'POST', `/api/chats/${chat.id}/tasks/nope/stop`)).status).toBe(404)
  })

  test('Send now on a queued message stops the turn (the CLI keeps the message) and the send queue is not held by it', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const { chat, fake } = await working(t, temp('desk-cwd-'))
    expect((await call(t.desk, 'POST', `/api/chats/${chat.id}/send-now`)).body).toEqual({ ok: true, stopped: false, message: 'Nothing was stopped: the message had already gone on.' })
    expect(fake.calls.interrupt).toBe(0)

    await call(t.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: 'and then this' })
    await waitFor(() => chatEvents(events, chat.id).at(-1)?.queuedCount === 1)
    const later = await call<{ id: string; state: string }>(t.desk, 'POST', '/api/queue', { kind: 'message', chatId: chat.id, text: 'after that, this' })
    expect(later.body.state).toBe('waiting')

    const now = await call(t.desk, 'POST', `/api/chats/${chat.id}/send-now`, { itemId: 'ignored-for-an-sdk-chat' })
    expect(now.body).toEqual({ ok: true, stopped: true })
    expect(fake.calls.interrupt).toBe(1)
    const queue = await call<QueueState>(t.desk, 'GET', '/api/queue')
    expect(queue.body.held).toEqual({})
    expect(queue.body.items.find((i) => i.id === later.body.id)?.state).not.toBe('held')
  })

  test('a permission round trip over HTTP', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const { chat, fake } = await working(t, temp('desk-cwd-'))

    const ac = new AbortController()
    const decision = fake.options.canUseTool!('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'toolu_1', requestId: 'r1' }) as Promise<PermissionResult>
    await waitFor(() => events.some((e) => e.type === 'item.upsert' && e.item.kind === 'permission'))
    const item = events.find((e) => e.type === 'item.upsert' && e.item.kind === 'permission') as Extract<ServerEvent, { type: 'item.upsert' }>
    expect(item.item).toMatchObject({ toolName: 'Bash', state: 'pending' })
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body).toMatchObject({ status: 'needs_you', pendingCount: 1 })
    await waitFor(() => events.some((e) => e.type === 'notify' && e.reason === 'needs_you'))

    const bad = await call(t.desk, 'POST', `/api/chats/${chat.id}/permission/${item.item.id}`, { decision: 'maybe' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/allow, session, always or deny/)
    const unknown = await call(t.desk, 'POST', `/api/chats/${chat.id}/permission/nope`, { decision: 'allow' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toMatch(/no pending permission request nope/)

    const ok = await call(t.desk, 'POST', `/api/chats/${chat.id}/permission/${item.item.id}`, { decision: 'allow' })
    expect(ok.body).toEqual({ ok: true })
    expect(await decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body).toMatchObject({ status: 'working', pendingCount: 0 })
    const items = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${chat.id}/items`)).body
    expect(items.find((i) => i.id === item.item.id)).toMatchObject({ state: 'allowed' })
  })

  test('restart: the chat returns closed with its items, and a send resumes the stored session', async () => {
    const first = await boot()
    const cwd = temp('desk-cwd-')
    const { body: chat } = await call<ChatSummary>(first.desk, 'POST', '/api/chats', { cwd, prompt: 'What does notes.txt say?' })
    first.last().push(...loadJsonl('basic-turn.jsonl'))
    await untilStatus(first.desk, chat.id, 'idle')
    await call(first.desk, 'PATCH', `/api/chats/${chat.id}`, { title: 'Notes question', pinned: true })
    await servers.splice(servers.indexOf(first.desk), 1)[0]!.stop()
    expect(first.last().calls.close).toBe(1)

    const second = await boot({ home: first.home })
    const { hello } = await listen(second.desk)
    expect(hello.chats).toHaveLength(1)
    expect(hello.chats[0]).toMatchObject({ id: chat.id, status: 'closed', sessionId: FIXTURE_SID, title: 'Notes question', pinned: true })
    const items = (await call<TranscriptItem[]>(second.desk, 'GET', `/api/chats/${chat.id}/items`)).body
    expect(items.find((i) => i.kind === 'user')).toMatchObject({ text: 'What does notes.txt say?' })
    expect(items.some((i) => i.kind === 'assistant_text')).toBe(true)

    // closed: the static lists answer
    expect((await call(second.desk, 'GET', `/api/chats/${chat.id}/commands`)).body).toEqual(STATIC_COMMANDS)
    expect((await call(second.desk, 'GET', '/api/models')).body).toEqual(STATIC_MODELS)

    const sent = await call(second.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: 'and tomorrow?' })
    expect(sent.body).toEqual({ queued: false })
    expect(second.all).toHaveLength(1)
    expect(second.last().options.resume).toBe(FIXTURE_SID)
    expect(second.last().options.cwd).toBe(cwd)

    // running: the live runtime's lists answer
    expect((await call(second.desk, 'GET', `/api/chats/${chat.id}/commands`)).body).toEqual([{ name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' }])
    expect((await call(second.desk, 'GET', '/api/models')).body).toEqual([
      { value: 'claude-opus-5-5', label: 'Opus 5.5' },
      { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ])
    expect((await call(second.desk, 'GET', '/api/folders/recent')).body).toEqual([cwd])
  })

  test('rename, pin, archive, live model/effort/mode, account at next start, delete', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const { chat, fake } = await working(t, temp('desk-cwd-'))

    const p = await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, {
      title: 'Renamed',
      pinned: true,
      model: 'claude-sonnet-5-5',
      effort: 'max',
      permissionMode: 'plan',
      accountId: 'default',
    })
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ title: 'Renamed', pinned: true, model: 'claude-sonnet-5-5', effort: 'max', permissionMode: 'plan', account: { id: 'default' } })
    expect(fake.calls.setModel).toEqual(['claude-sonnet-5-5'])
    expect(fake.calls.applyFlagSettings).toEqual([{ effortLevel: 'max' }])
    expect(fake.calls.setPermissionMode).toEqual(['plan'])
    await waitFor(() => chatEvents(events, chat.id).some((c) => c.title === 'Renamed' && c.pinned))

    // 'default' is the account default model
    expect((await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, { model: 'default' })).body.model).toBeNull()

    const badPatch = await call(t.desk, 'PATCH', `/api/chats/${chat.id}`, { status: 'idle' })
    expect(badPatch.status).toBe(400)
    expect(badPatch.body.error).toMatch(/cannot change status/)
    expect((await call(t.desk, 'PATCH', `/api/chats/${chat.id}`, { title: ' ' })).status).toBe(400)

    // archive hides it from the default list
    await call(t.desk, 'PATCH', `/api/chats/${chat.id}`, { archived: true })
    expect((await call<ChatSummary[]>(t.desk, 'GET', '/api/chats')).body).toEqual([])
    expect((await call<ChatSummary[]>(t.desk, 'GET', '/api/chats?archived=1')).body.map((c) => c.id)).toEqual([chat.id])

    const del = await call(t.desk, 'DELETE', `/api/chats/${chat.id}`)
    expect(del.body).toEqual({ ok: true })
    expect(fake.calls.close).toBe(1)
    await waitFor(() => events.some((e) => e.type === 'chat.removed' && e.chatId === chat.id))
    expect((await call(t.desk, 'GET', `/api/chats/${chat.id}`)).status).toBe(404)
    expect((await call(t.desk, 'GET', `/api/chats/${chat.id}/items`)).status).toBe(404)
  })

  test('an account change takes effect at the next runtime start', async () => {
    const t = await boot()
    const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), accountId: ACCOUNT_68.id })
    expect(chat.account.id).toBe(ACCOUNT_68.id)
    await call(t.desk, 'PATCH', `/api/chats/${chat.id}`, { accountId: 'default' })
    await call(t.desk, 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi' })
    expect('CLAUDE_CONFIG_DIR' in (t.last().options.env ?? {})).toBe(false)
  })

  test('import adopts an outside session: closed, its history shown, the next send resumes it', async () => {
    const outsideCwd = temp('desk-outside-')
    const history: TranscriptItem[] = [
      { kind: 'user', id: 'u1', ts: 1, text: 'from the desktop app' },
      { kind: 'assistant_text', id: 'a1', ts: 2, text: 'hello from elsewhere' },
    ]
    const b = fakeBridge({
      external: [{ id: 'ext-1', title: 'Desktop chat', cwd: outsideCwd, source: 'desktop', instance: '#68', status: 'idle', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null }],
      items: { 'ext-1': history },
    })
    const t = await boot({ bridge: b })
    const { events } = await listen(t.desk)

    const res = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'ext-1', configDir: ACCOUNT_68.configDir })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sessionId: 'ext-1', cwd: outsideCwd, title: 'Desktop chat', status: 'closed', account: { id: ACCOUNT_68.id } })
    await waitFor(() => chatEvents(events, res.body.id).length === 1)
    expect((await call(t.desk, 'GET', `/api/chats/${res.body.id}/items`)).body).toEqual(history)
    // our own chats are left out of "Elsewhere"
    expect([...(await b.state.excluded())]).toEqual(['ext-1'])

    // importing the same session again answers the same chat
    expect((await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'ext-1' })).body.id).toBe(res.body.id)

    // No folder on this machine has 'ext-1': the send says so instead of starting a resume that fails. A
    // resume in place and one as a copy are in continue-outside.test.ts and the test below.
    const refused = await call(t.desk, 'POST', `/api/chats/${res.body.id}/messages`, { text: 'carry on' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('No folder on this machine has session ext-1, so it cannot be resumed.')
    expect(t.all).toHaveLength(0)

    const noCwd = await call(t.desk, 'POST', '/api/chats/import', { sessionId: 'ext-unknown' })
    expect(noCwd.status).toBe(400)
    expect(noCwd.body.error).toMatch(/cwd is required/)
    expect((await call(t.desk, 'POST', '/api/chats/import', {})).body.error).toBe('sessionId is required')
  })

  test('the next send copies a session its account lacks into that account folder, then resumes it', async () => {
    const cwd = temp('desk-outside-')
    const sid = '11111111-2222-4333-8444-555555555555'
    const slug = encodeProjectDir(cwd)
    const source = temp('desk-source-config-')
    mkdirSync(join(source, 'projects', slug), { recursive: true })
    writeFileSync(join(source, 'projects', slug, `${sid}.jsonl`), '{"type":"user","message":{"role":"user","content":"hi"}}\n')
    const account = temp('desk-account-config-')
    const t = await boot({ bridge: fakeBridge({ items: { [sid]: [] }, roots: [join(source, 'projects')] }) })

    const imported = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: sid, cwd, title: 'From Desktop', configDir: account })
    const copy = join(account, 'projects', slug, `${sid}.jsonl`)
    expect(existsSync(copy)).toBe(false) // importing only adopts it

    await call(t.desk, 'POST', `/api/chats/${imported.body.id}/messages`, { text: 'carry on' })
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(join(source, 'projects', slug, `${sid}.jsonl`), 'utf8'))
    expect(t.last().options.resume).toBe(sid)
    expect(t.last().options.env?.CLAUDE_CONFIG_DIR).toBe(account)
    const items = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${imported.body.id}/items`)).body
    expect(items.some((i) => i.kind === 'system' && /Copied this session/.test(i.text))).toBe(true)
  })

  test('climayteActive counts active workers dispatched by the chat', async () => {
    const b = fakeBridge()
    const t = await boot({ bridge: b })
    const { events } = await listen(t.desk)
    const res = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'origin-1', cwd: temp('desk-cwd-'), title: 'Orchestrator', configDir: null })
    b.state.workers = [
      worker({ id: 'w1', originSessionId: 'origin-1' }),
      worker({ id: 'w2', originSessionId: 'origin-1', status: 'done', active: false }),
      worker({ id: 'w3', originSessionId: 'someone-else' }),
      worker({ id: 'w4', originSessionId: 'origin-1', status: 'queued' }),
    ]
    await waitFor(() => chatEvents(events, res.body.id).at(-1)?.climayteActive === 2)
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${res.body.id}`)).body.climayteActive).toBe(2)
    b.state.workers = []
    await waitFor(() => chatEvents(events, res.body.id).at(-1)?.climayteActive === 0)
  })

  test('an idle chat whose background work finishes becomes unread again', async () => {
    const b = fakeBridge()
    const t = await boot({ bridge: b })
    const { events } = await listen(t.desk)
    const res = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'origin-2', cwd: temp('desk-cwd-'), title: 'Orchestrator', configDir: null })
    b.state.workers = [worker({ id: 'w1', originSessionId: 'origin-2' })]
    await waitFor(() => chatEvents(events, res.body.id).at(-1)?.climayteActive === 1)
    await call(t.desk, 'PATCH', `/api/chats/${res.body.id}`, { unread: false })
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${res.body.id}`)).body.unread).toBe(false)
    b.state.workers = []
    await waitFor(() => chatEvents(events, res.body.id).at(-1)?.climayteActive === 0)
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${res.body.id}`)).body.unread).toBe(true)
  })
})

describe('POST /api/sessions/:sessionId/ping (AgentHydra\'s CliMayte note to the dispatching chat)', () => {
  const stored = (id: string, over: Record<string, unknown>) => ({
    id,
    sessionId: null,
    title: 'Orchestrator',
    cwd: '/',
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    contextPct: null,
    ranIn: null,
    ...over,
  })

  async function bootWith(rows: Record<string, unknown>[]) {
    const home = temp('desk-ping-home-')
    writeFileSync(join(home, 'chats.json'), JSON.stringify(rows))
    return boot({ home })
  }

  test('finds the chat by its current or a past session, resumes the closed chat and sends the note without naming it', async () => {
    const cwd = temp('desk-cwd-')
    const t = await bootWith([
      stored('c-current', { sessionId: 'sess-now', cwd, title: 'New session' }),
      stored('c-past', { sessionId: 'sess-new', pastSessions: ['sess-old'], cwd }),
    ])
    const note = '[AgentHydra · CliMayte] Not from the user. Ping 1, 1 update since 09:00:'
    const now = await call(t.desk, 'POST', '/api/sessions/sess-now/ping', { text: note })
    expect(now.status).toBe(200)
    expect(now.body).toMatchObject({ ok: true, chatId: 'c-current' })
    await waitFor(() => t.all.length === 1)
    expect(t.last().options.resume).toBe('sess-now')
    await waitFor(() => t.last().sent.length === 1)
    expect((await call<ChatSummary>(t.desk, 'GET', '/api/chats/c-current')).body.title).toBe('New session')

    const past = await call(t.desk, 'POST', '/api/sessions/sess-old/ping', { text: note })
    expect(past.body).toMatchObject({ ok: true, chatId: 'c-past' })
  })

  test('the window gets the ping as a note the moment it is sent, never as a message of the person', async () => {
    const t = await bootWith([stored('c-live', { sessionId: 'sess-live', cwd: temp('desk-cwd-') })])
    const { events } = await listen(t.desk)
    const note = '[AgentHydra · CliMayte] Not from the user. Ping 2, 1 update since 09:00:\n• w-1 "Example task": done, check passed.'
    await call(t.desk, 'POST', '/api/sessions/sess-live/ping', { text: note })
    const live = () => events.filter((e): e is Extract<ServerEvent, { type: 'item.upsert' }> => e.type === 'item.upsert' && e.chatId === 'c-live')
    await waitFor(() => live().length > 0)
    expect(live().map((e) => e.item.kind)).not.toContain('user')
    expect(live()[0]!.item).toMatchObject({ kind: 'note', from: 'AgentHydra · CliMayte', text: 'Ping 2, 1 update since 09:00:\n• w-1 "Example task": done, check passed.' })
  })

  test('404 for an unknown session, an archived chat and a CliMayte worker chat', async () => {
    const t = await bootWith([stored('c-arch', { sessionId: 'sess-arch', archived: true }), stored('c-work', { sessionId: 'sess-work', workerId: 'w1' })])
    for (const sid of ['sess-unknown', 'sess-arch', 'sess-work']) {
      const res = await call(t.desk, 'POST', `/api/sessions/${sid}/ping`, { text: 'hello' })
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/no chat here/)
    }
    expect(t.all).toHaveLength(0)
  })
})

describe('the row menu routes', () => {
  test('fork: a closed copy with the history; its first message resumes the session forked', async () => {
    const t = await boot()
    const { events } = await listen(t.desk)
    const cwd = temp('desk-cwd-')
    const { body: src } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd, prompt: 'What does notes.txt say?' })
    t.last().push(...loadJsonl('basic-turn.jsonl'))
    await untilStatus(t.desk, src.id, 'idle')
    await call(t.desk, 'PATCH', `/api/chats/${src.id}`, { group: 'Research', pinned: true })

    const res = await call<ChatSummary>(t.desk, 'POST', `/api/chats/${src.id}/fork`)
    expect(res.status).toBe(200)
    const fork = res.body
    expect(fork.id).not.toBe(src.id)
    expect(fork).toMatchObject({ title: `${src.title} (fork)`, sessionId: null, forkedFrom: FIXTURE_SID, status: 'closed', cwd, account: src.account, group: 'Research', pinned: false })
    await waitFor(() => chatEvents(events, fork.id).length > 0)
    const srcItems = (await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${src.id}/items`)).body
    expect((await call<TranscriptItem[]>(t.desk, 'GET', `/api/chats/${fork.id}/items`)).body).toEqual(srcItems)

    const runs = t.all.length
    await call(t.desk, 'POST', `/api/chats/${fork.id}/messages`, { text: 'branch off' })
    expect(t.all).toHaveLength(runs + 1)
    expect(t.last().options.resume).toBe(FIXTURE_SID)
    expect(t.last().options.forkSession).toBe(true)
    expect(t.last().options.cwd).toBe(cwd)
    // the SDK names the fork's own session; from then on it resumes that one
    t.last().push({ ...(init() as object), session_id: 'fork-session-0001' } as SDKMessage)
    await waitFor(() => chatEvents(events, fork.id).some((c) => c.sessionId === 'fork-session-0001'))
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${src.id}`)).body.sessionId).toBe(FIXTURE_SID)

    // nothing to fork before a session exists
    const fresh = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd, accountId: 'default' })
    const none = await call(t.desk, 'POST', `/api/chats/${fresh.body.id}/fork`)
    expect(none.status).toBe(409)
    expect(none.body.error).toMatch(/no Claude Code session/)
    expect((await call(t.desk, 'POST', '/api/chats/nope/fork')).status).toBe(404)
    // at a message (fork-at.test.ts): only one of the owner's
    const notYours = await call(t.desk, 'POST', `/api/chats/${src.id}/fork`, { at: srcItems.find((i) => i.kind !== 'user')!.id })
    expect(notYours.status).toBe(400)
    expect(notYours.body.error).toMatch(/no message .* of yours/)
  })

  test('fork: its first message takes the source as it stood when forked, also after a restart', async () => {
    const root = join(temp('desk-claude-'), 'projects')
    const account = { id: 'acct-t', label: 'T', configDir: temp('desk-account-') }
    const first = await boot({ bridge: fakeBridge({ picked: account, roots: [root] }) })
    const cwd = temp('desk-cwd-')
    const { body: src } = await call<ChatSummary>(first.desk, 'POST', '/api/chats', { cwd, prompt: 'What does notes.txt say?', accountId: account.id })
    first.last().push(...loadJsonl('basic-turn.jsonl'))
    await untilStatus(first.desk, src.id, 'idle')
    const file = join(root, encodeProjectDir(cwd), `${FIXTURE_SID}.jsonl`)
    mkdirSync(join(root, encodeProjectDir(cwd)), { recursive: true })
    const entry = (uuid: string, parentUuid: string | null) => JSON.stringify({ type: 'assistant', uuid, parentUuid }) + '\n'
    writeFileSync(file, entry('u-1', null) + entry('a-1', 'u-1'))

    const { body: fork } = await call<ChatSummary>(first.desk, 'POST', `/api/chats/${src.id}/fork`)
    // the cut is the server's own: not on the wire
    expect(fork).not.toHaveProperty('forkAt')
    // the source runs on after the fork
    writeFileSync(file, entry('u-1', null) + entry('a-1', 'u-1') + entry('u-2', 'a-1') + entry('a-2', 'u-2'))

    await servers.splice(servers.indexOf(first.desk), 1)[0]!.stop()
    const second = await boot({ home: first.home, bridge: fakeBridge({ picked: account, roots: [root] }) })
    await call(second.desk, 'POST', `/api/chats/${fork.id}/messages`, { text: 'branch off' })
    expect(second.last().options).toMatchObject({ resume: FIXTURE_SID, forkSession: true, resumeSessionAt: 'a-1' })
  })

  test('group: trimmed, 1-60 chars, or null back to the folder', async () => {
    const t = await boot()
    const { body: chat } = await call<ChatSummary>(t.desk, 'POST', '/api/chats', { cwd: temp('desk-cwd-'), accountId: 'default' })
    expect(chat.group).toBeNull()
    expect((await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, { group: '  Launch  ' })).body.group).toBe('Launch')
    for (const bad of ['', '   ', 'x'.repeat(61), 7]) {
      const res = await call(t.desk, 'PATCH', `/api/chats/${chat.id}`, { group: bad })
      expect(res.status).toBe(400)
    }
    expect((await call<ChatSummary>(t.desk, 'GET', `/api/chats/${chat.id}`)).body.group).toBe('Launch')
    expect((await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, { group: 'x'.repeat(60) })).body.group).toBe('x'.repeat(60))
    expect((await call<ChatSummary>(t.desk, 'PATCH', `/api/chats/${chat.id}`, { group: null })).body.group).toBeNull()
  })

  test('outside sessions: the marks live in Hydra Desk home, are applied to the list and survive a restart', async () => {
    const outsideCwd = temp('desk-outside-')
    const ext: ExternalSession = { id: 'ext-1', title: 'Desktop chat', cwd: outsideCwd, source: 'desktop', instance: '#68', status: 'idle', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null }
    const first = await boot({ bridge: fakeBridge({ external: [ext], items: { 'ext-1': [] } }) })

    const res = await call<SessionMeta>(first.desk, 'PATCH', '/api/external/sessions/ext-1/meta', { title: ' Renamed here ', pinned: true, group: ' Ops ' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ title: 'Renamed here', pinned: true, archived: false, unread: false, group: 'Ops' })
    expect((await first.bridge.externalSessions())[0]).toEqual({ ...ext, title: 'Renamed here', pinned: true, group: 'Ops' })
    const metaFile = join(first.home, 'session-meta.json')
    const landedBy = Date.now() + 5000
    while (!existsSync(metaFile)) {
      if (Date.now() > landedBy) throw new Error('session-meta.json was never written')
      await Bun.sleep(5)
    }

    expect((await call(first.desk, 'PATCH', '/api/external/sessions/ext-1/meta', { group: '' })).status).toBe(400)
    expect((await call(first.desk, 'PATCH', '/api/external/sessions/ext-1/meta', { status: 'idle' })).status).toBe(400)
    expect((await call(first.desk, 'PATCH', '/api/external/sessions/bad.id/meta', { pinned: true })).status).toBe(400)

    await servers.splice(servers.indexOf(first.desk), 1)[0]!.stop()
    const second = await boot({ home: first.home, bridge: fakeBridge({ external: [ext], items: { 'ext-1': [] } }) })
    expect((await second.bridge.externalSessions())[0]).toMatchObject({ title: 'Renamed here', pinned: true, group: 'Ops' })

    // a null title is the session's own again; with no marks left it is the plain list
    await call(second.desk, 'PATCH', '/api/external/sessions/ext-1/meta', { title: null, pinned: false, group: null })
    expect((await second.bridge.externalSessions())[0]).toEqual(ext)
  })

  test('fork of an outside session: a new chat that forks it, the original still listed', async () => {
    const outsideCwd = temp('desk-outside-')
    const ext: ExternalSession = { id: 'ext-1', title: 'Desktop chat', cwd: outsideCwd, source: 'desktop', instance: '#68', status: 'working', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null }
    const history: TranscriptItem[] = [{ kind: 'user', id: 'u1', ts: 1, text: 'from the desktop app' }]
    const b = fakeBridge({ external: [ext], items: { 'ext-1': history } })
    const t = await boot({ bridge: b })

    const res = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'ext-1', configDir: ACCOUNT_68.configDir, fork: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sessionId: null, forkedFrom: 'ext-1', title: 'Desktop chat (fork)', cwd: outsideCwd, status: 'closed', account: { id: ACCOUNT_68.id } })
    expect((await call(t.desk, 'GET', `/api/chats/${res.body.id}/items`)).body).toEqual(history)
    expect([...(await b.state.excluded())]).toEqual([])
    // a second fork is a second chat
    const again = await call<ChatSummary>(t.desk, 'POST', '/api/chats/import', { sessionId: 'ext-1', configDir: ACCOUNT_68.configDir, fork: true })
    expect(again.body.id).not.toBe(res.body.id)

    // No folder here has 'ext-1' to fork: refused (a fork of one that resumes is in continue-outside.test.ts).
    expect((await call(t.desk, 'POST', `/api/chats/${res.body.id}/messages`, { text: 'take it from here' })).status).toBe(409)
    expect(t.all).toHaveLength(0)
  })

  test('reveal opens an existing folder and refuses anything else', async () => {
    const opened: string[] = []
    const t = await boot({ deps: { openFolder: (dir: string) => opened.push(dir) } })
    const dir = temp('desk-reveal-')
    const ok = await call(t.desk, 'POST', '/api/folders/reveal', { path: dir })
    expect(ok.status).toBe(200)
    expect(opened).toEqual([ok.body.path])
    for (const path of [undefined, '', 'relative/folder', join(dir, 'missing')]) {
      expect((await call(t.desk, 'POST', '/api/folders/reveal', { path })).status).toBe(400)
    }
    // a network or device path is refused before anything asks whether it exists (which would reach that host)
    for (const path of ['\\\\evil-host\\share', '//evil-host/share', '\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows']) {
      const res = await call(t.desk, 'POST', '/api/folders/reveal', { path })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/network or device path/)
    }
    expect(opened).toHaveLength(1)
  })

  test('the folder goes to explorer.exe quoted, so a comma or space cannot split it', () => {
    expect(explorerArg('C:\\Users\\me\\a,b c')).toBe('"C:\\Users\\me\\a,b c"')
    expect(explorerArg('C:\\')).toBe('"C:\\\\"')
  })
})

test('GET /api/diagnostics/failures answers the ledger rows with counts, filtered by cause', async () => {
  const { desk, home } = await boot()
  const ledger = new FailureLedger(home)
  const base = { chatId: 'c1', title: 't', cwd: home, kind: 'sdk' as const, accountId: 'acct-1', accountNumber: 126, model: null, sessionId: null }
  ledger.record({ ...base, message: 'Failed to authenticate: OAuth session expired' })
  ledger.record({ ...base, message: 'fetch failed' })
  await ledger.settled()
  const all = await call(desk, 'GET', '/api/diagnostics/failures')
  expect(all.status).toBe(200)
  expect(all.body).toMatchObject({ total: 2, byCause: { auth_expired: 1, network: 1 }, byAccount: { '#126': 2 } })
  const one = await call(desk, 'GET', '/api/diagnostics/failures?cause=network&limit=5')
  expect(one.body.rows.map((r: { cause: string }) => r.cause)).toEqual(['network'])
})
