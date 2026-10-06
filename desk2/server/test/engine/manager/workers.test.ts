// A new chat is a CliMayte worker (SPEC "Chats are CliMayte workers"): its first message starts the
// worker on a strong model whatever the window asked, a later one is sent to that worker, and the chat
// shows the worker's status, account (a move said in the transcript) and transcript.

import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../../../src/bridge/client'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import type { ServerEvent } from '@shared/protocol'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('a new chat starts a worker, a follow-up goes to that worker, and its status, move and transcript show', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)

  const chat = await m.create({ cwd: home, prompt: 'reply with the word pong', model: 'haiku' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  expect(b.state.started).toEqual([expect.objectContaining({ prompt: 'reply with the word pong', cwd: home, group: 'hydra-desk' })])
  expect(m.get(chat.id)).toMatchObject({ workerId: 'w1', sessionId: 'worker-session-1', model: 'opus' })
  expect(q.all).toEqual([])

  const row = b.state.rows[0]!
  Object.assign(row, { status: 'running', accountId: 'cli-2', account: '#61 acct2' })
  b.state.workerItems['worker-session-1'] = [{ kind: 'assistant_text', id: 'a-1', ts: 10, text: 'pong' }]
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id)).toMatchObject({ status: 'working', account: { id: 'cli-2' } })
  expect(m.listItems(chat.id).find((i) => i.id === 'a-1')).toMatchObject({ text: 'pong' })

  await m.send(chat.id, 'now reply with ping')
  expect(b.state.sentToWorker).toEqual([{ id: 'w1', text: 'now reply with ping' }])
  expect(b.state.started.length).toBe(1)

  Object.assign(row, { status: 'done', accountId: 'cli-3', account: '#62 acct3' })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id)).toMatchObject({ status: 'idle', unread: true, account: { id: 'cli-3' } })
  const moved = m.listItems(chat.id).find((i) => i.kind === 'system' && /moved this chat/.test(i.text))
  expect(moved && 'text' in moved && moved.text).toMatch(/from #61.* to #62/)
})

function newManager(home: string, b: ReturnType<typeof fakeBridge>) {
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)
  return m
}

test('the Desk file keeps every session of the chat in order, once, however often the JSONLs are re-read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'first' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  const row = b.state.rows[0]!
  const old = [{ kind: 'user', id: 'u-1', ts: 1, text: 'first' }, { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'one' }] as const
  b.state.workerItems['worker-session-1'] = [...old]
  await m.syncWorkers(chat.id)

  // CliMayte hands the worker to a fresh session; the old file now repeats its history and goes on.
  Object.assign(row, { sessions: ['worker-session-1'], sessionId: 'worker-session-2' })
  b.state.workerItems['worker-session-2'] = [...old, { kind: 'assistant_text', id: 'a-2', ts: 3, text: 'two' }]
  await m.syncWorkers(chat.id)
  await m.syncWorkers(chat.id)
  // The old JSONL is later gone from every account folder: the record stays.
  delete b.state.workerItems['worker-session-1']
  b.state.workerItems['worker-session-2'] = []
  await m.syncWorkers(chat.id)

  const ids = (): string[] => m.listItems(chat.id).map((i) => i.id)
  expect(ids()).toEqual(['u-1', 'a-1', 'a-2'])
  const lines = readFileSync(join(home, 'chats', `${chat.id}.jsonl`), 'utf8').trim().split('\n')
  expect(lines.filter((l) => l.includes('"u-1"')).length).toBe(1)
  // A torn last line from a crash is tolerated.
  appendFileSync(join(home, 'chats', `${chat.id}.jsonl`), '{"kind":"assist')
  expect(ids()).toEqual(['u-1', 'a-1', 'a-2'])
})

test('an open chat is served from the Desk file without reading any account folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  b.state.workerItems['worker-session-1'] = [{ kind: 'assistant_text', id: 'a-1', ts: 2, text: 'one' }]
  await m.syncWorkers(chat.id)
  await m.closeAll()

  // A restarted server: the chat opens from its file; the scan is not called until the background refresh.
  const b2 = fakeBridge()
  const m2 = newManager(home, b2)
  expect(m2.listItems(chat.id).map((i) => i.id)).toEqual(['a-1'])
  expect(b2.state.workerReads).toBe(0)
})

test('a sent message shows at once, before the worker has it, and its worker copy replaces it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const events: ServerEvent[] = []
  const m = new ChatManager({ home, claudeHome: home, emit: (e) => events.push(e), settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))

  // The worker takes its time: the message is on screen while the send is still out.
  let take!: () => void
  b.bridge.sendToWorker = () => new Promise<boolean>((r) => (take = () => r(false)))
  const sending = m.send(chat.id, `two

paragraphs`)
  const shown = events.findLast((e) => e.type === 'item.upsert' && e.item.kind === 'user')
  expect(shown).toMatchObject({ chatId: chat.id, item: { kind: 'user', text: `two

paragraphs` } })
  expect(m.listItems(chat.id).filter((i) => i.kind === 'user').map((i) => 'text' in i && i.text)).toEqual(['hi', `two

paragraphs`])
  take()
  await sending

  // The worker's JSONL now has both messages: each stand-in goes, the worker's copies stay, once.
  b.state.workerItems['worker-session-1'] = [
    { kind: 'user', id: 'u-1', ts: Date.now(), text: 'hi' },
    { kind: 'user', id: 'u-2', ts: Date.now(), text: `two

paragraphs` },
  ]
  await m.syncWorkers(chat.id)
  expect(m.listItems(chat.id).map((i) => i.id)).toEqual(['u-1', 'u-2'])
  const removed = events.filter((e) => e.type === 'item.removed').map((e) => e.type === 'item.removed' && e.itemId)
  expect(removed).toEqual(events.filter((e) => e.type === 'item.upsert' && e.item.id.startsWith('desk-sent:')).map((e) => e.type === 'item.upsert' && e.item.id))
})

test('Send now on a queued message has CliMayte deliver that one now, and its bubble is no longer queued', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  expect(await m.send(chat.id, 'first, check the build')).toEqual({ queued: true })
  expect(await m.send(chat.id, 'stop and do this')).toEqual({ queued: true })
  const queued = () => m.listItems(chat.id).filter((i) => i.kind === 'user' && i.queued).map((i) => i.kind === 'user' && i.text)
  const second = m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === 'stop and do this')!

  expect(await m.sendNow(chat.id, second.id)).toEqual({ ok: true, stopped: true })
  expect(b.state.sentNow).toEqual([{ id: 'w1', text: 'stop and do this' }])
  expect(queued()).toEqual(['first, check the build'])

  // Nothing held any more (it went meanwhile): nothing stops and the bubble stays as it is.
  b.state.nowStops = false
  const first = m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === 'first, check the build')!
  expect(await m.sendNow(chat.id, first.id)).toEqual({ ok: true, stopped: false, message: 'That message is not held any more: it was delivered, or its turn has begun.' })
  expect(queued()).toEqual(['first, check the build'])
  // A bubble that is not a held stand-in names no message: CliMayte takes its oldest.
  await m.sendNow(chat.id, 'u-unknown')
  expect(b.state.sentNow.at(-1)).toEqual({ id: 'w1' })
  expect(b.state.cancelled).toEqual([])

  b.bridge.sendToWorkerNow = async () => {
    throw new Error('this AgentHydra cannot send a held message now yet: it needs its update')
  }
  expect(m.sendNow(chat.id, first.id)).rejects.toThrow(/CliMayte did not send it now: .*needs its update/)
})

// 2026-10-06: a worker that handed off waited 36 minutes for an account; its held message's Send now went
// "Sending…" and back to "Send now" each click, saying nothing, under a "Starting…" that never said why.
test('Send now while the worker waits for an account says no turn runs and why; the chat shows the wait, not Starting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  expect(await m.send(chat.id, 'and add the totals row')).toEqual({ queued: true })
  const held = m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === 'and add the totals row')!

  const why = 'Every eligible account is at its usage limit, past the 85% stop line, or signed out; the first frees up at 11:19.'
  Object.assign(b.state.rows[0]!, { status: 'waiting', error: why })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id)).toMatchObject({ status: 'starting', activity: `Waiting for an account: ${why}` })

  const r = await m.sendNow(chat.id, held.id)
  expect(r).toMatchObject({ ok: true, stopped: false })
  expect(r.message).toBe(`No turn is running to stop: Waiting for an account: ${why}. This message goes first when it starts.`)
  // Still held: it leads the worker's next turn.
  expect(m.listItems(chat.id).find((i) => i.id === held.id)).toMatchObject({ queued: true })
  expect(b.state.cancelled).toEqual([])

  // CliMayte's own "Waiting for ..." reason is shown as it is, not prefixed twice.
  Object.assign(b.state.rows[0]!, { error: 'Waiting for an account nobody else is using: #35 (other sessions running).' })
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).activity).toBe('Waiting for an account nobody else is using: #35 (other sessions running).')
})

test("a person's plain send to a running worker goes now; the queue's own dispatch and a failed deliver-now stay held", async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  const bubble = (text: string) => m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === text)!

  expect(await m.send(chat.id, 'look at the other file instead', undefined, { now: true })).toEqual({ queued: false })
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'look at the other file instead' })
  expect(b.state.sentNow).toEqual([{ id: 'w1', text: 'look at the other file instead' }])
  expect(bubble('look at the other file instead')).not.toHaveProperty('queued')

  // Without `now` (the queue dispatching on its own) it waits for the turn, as before.
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  expect(await m.send(chat.id, 'after that, run the tests')).toEqual({ queued: true })
  expect(b.state.sentNow).toHaveLength(1)
  expect(bubble('after that, run the tests')).toMatchObject({ queued: true })

  // CliMayte could not stop the turn: the message is held all the same, and its bubble keeps Send now.
  b.bridge.sendToWorkerNow = async () => {
    throw new Error('AgentHydra did not answer in time')
  }
  expect(await m.send(chat.id, 'and then commit', undefined, { now: true })).toEqual({ queued: true })
  expect(bubble('and then commit')).toMatchObject({ queued: true })
  // ...and the chat says why, not only the server log
  expect(m.listItems(chat.id).filter((i) => i.kind === 'system')).toEqual([expect.objectContaining({ level: 'warn', text: expect.stringMatching(/waits for the current task.*did not answer in time/s) })])
})

test('an AgentHydra without deliver-now takes a plain send to a running worker as one urgent message, sent once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  b.state.deliverNow = false
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'hi' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  const bubble = (text: string) => m.listItems(chat.id).find((i) => i.kind === 'user' && i.text === text)!

  expect(await m.send(chat.id, 'use the other port', undefined, { now: true })).toEqual({ queued: false })
  // One send, urgent: never a plain send that CliMayte holds plus a second copy.
  expect(b.state.sentToWorker).toEqual([{ id: 'w1', text: 'use the other port', urgent: true }])
  expect(b.state.sentNow).toEqual([])
  expect(bubble('use the other port')).not.toHaveProperty('queued')
  expect(m.listItems(chat.id).filter((i) => i.kind === 'system')).toEqual([])

  // The queue's own dispatch still waits for the turn, and is no urgent message.
  Object.assign(b.state.rows[0]!, { status: 'running' })
  await m.syncWorkers(chat.id)
  expect(await m.send(chat.id, 'then rerun the tests')).toEqual({ queued: true })
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'then rerun the tests' })
  expect(bubble('then rerun the tests')).toMatchObject({ queued: true })

  // It had just finished on its own: nothing stopped, so the bubble stays as sent until the worker's copy replaces it.
  b.state.nowStops = false
  expect(await m.send(chat.id, 'and update the notes', undefined, { now: true })).toEqual({ queued: true })
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'and update the notes', urgent: true })
  expect(b.state.sentNow).toEqual([])
})

test('a new worker chat asks for chat mode and forces no model or effort', async () => {
  const bodies: { path: string; body: unknown }[] = []
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    bodies.push({ path: new URL(url).pathname, body: JSON.parse(init?.body ?? '{}') })
    return new Response(JSON.stringify({ group: 'g', workers: [] }), { status: 200 })
  }) as unknown as typeof fetch
  const client = createClient({ url: 'http://127.0.0.1:1', fetch: fetchImpl })
  await client.startWorker({ prompt: 'hi', cwd: 'C:/x', title: 't', group: 'hydra-desk' })
  const body = bodies[0]!.body as { tasks: Record<string, unknown>[] } & Record<string, unknown>
  expect(bodies[0]!.path).toBe('/api/corch/workers')
  expect(body.tasks[0]).toMatchObject({ prompt: 'hi', chat: true })
  for (const k of ['model', 'effort', 'modelWhy']) expect(k in body || k in body.tasks[0]!).toBe(false)

  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'go', model: 'haiku', effort: 'low' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  expect(b.state.started[0]!.model).toBeUndefined()
  expect(b.state.started[0]!.effort).toBeUndefined()
})

test('a send after the chat moved folders passes the new folder to the worker, once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const base = mkdtempSync(join(tmpdir(), 'desk-wmove-'))
  temps.push(base)
  const cwd = join(base, 'A')
  const other = join(base, 'X')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(other, { recursive: true })
  const root = join(base, 'projects')
  const file = join(root, encodeProjectDir(cwd), 'worker-session-1.jsonl')
  mkdirSync(join(root, encodeProjectDir(cwd)), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u', cwd: other, message: { role: 'user', content: 'x' } })}
`)
  const b = fakeBridge({ roots: [root] })
  const m = newManager(home, b)
  const chat = await m.create({ cwd, prompt: 'go' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  await m.send(chat.id, 'same folder')
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'same folder' })

  await m.patch(chat.id, { cwd: other })
  expect(m.get(chat.id).cwd).toBe(other)
  await m.send(chat.id, 'now here')
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'now here', cwd: other })
  await m.send(chat.id, 'and again')
  expect(b.state.sentToWorker.at(-1)).toEqual({ id: 'w1', text: 'and again' })
})

test('a worker chat takes a picture as a saved file named in the message, and a refused first message says why', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const chat = await m.create({ cwd: home, prompt: 'what is this?', images: [{ mediaType: 'image/png', dataBase64: png, name: 'shot.png' }] })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  const sent = b.state.started[0]!.prompt
  expect(sent).toStartWith('what is this?\n[Image: source: ')
  const path = /\[Image: source: (.+)\]/.exec(sent)![1]!
  expect(readFileSync(path).length).toBeGreaterThan(0)

  const failing = fakeBridge()
  failing.bridge.startWorker = async () => {
    throw new Error('AgentHydra is not running')
  }
  const m2 = newManager(home, failing)
  const c2 = await m2.create({ cwd: home, prompt: 'keep these words' })
  while (m2.get(c2.id).status !== 'error') await new Promise((r) => setTimeout(r, 5))
  const note = m2.listItems(c2.id).find((i) => i.kind === 'system' && /was not sent/.test(i.text))
  expect(note && 'text' in note && note.text).toContain('keep these words')
})

test('Stop on a CliMayte task stops its worker (a worker takes no control message) and settles the task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-workers-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = newManager(home, b)
  const chat = await m.create({ cwd: home, prompt: 'watch the build' })
  while (!m.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  Object.assign(b.state.rows[0]!, { status: 'running', accountId: 'cli-2', account: '#61 acct2' })
  b.state.workerItems['worker-session-1'] = [{ kind: 'task', id: 'task:b1', ts: 10, taskId: 'b1', description: 'Watch the build', status: 'running', taskKind: 'bash' }]
  await m.syncWorkers(chat.id)
  expect(m.get(chat.id).backgroundActive).toBe(1)

  const item = await m.stopTask(chat.id, 'b1')
  expect(b.state.cancelled).toEqual(['w1'])
  expect(item).toMatchObject({ taskId: 'b1', status: 'stopped' })
  expect(m.listItems(chat.id).find((i) => i.id === 'task:b1')).toMatchObject({ status: 'stopped' })
  expect(m.get(chat.id).backgroundActive).toBe(0)
})
