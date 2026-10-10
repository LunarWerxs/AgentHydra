// The send queue's dispatcher (SPEC "Send queue") against a fake chat manager and a clock the test moves:
// when a queued message goes, what holds it and what releases it, how new chats wait for a slot and for
// room, the owner's edits and their refusals, and what a restart finds in queue.json.

import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatStatus, ChatSummary, CreateChatRequest, ImageRef, ServerEvent, TranscriptItem } from '@shared/protocol'
import { ChatBusyError, ChatError, type SendOptions } from '../../../src/engine/chat-manager'
import { type QueueChats, QueueManager, REASON } from '../../../src/engine/queue'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SETTLE = 800
const RETRY = 15_000
const FILE_RETRY = 20
/** The 8-byte PNG signature: enough for the media cache to take it as a picture. */
const PNG = 'iVBORw0KGgo='

/** Lets every promise in flight run: the queue's own work is microtasks. */
const settle = () => new Promise((r) => setTimeout(r, 0))

/** Writes to disk are real I/O the fake clock does not drive: waits in real time for the check. */
async function waitFor(check: () => boolean): Promise<void> {
  const by = Date.now() + 5000
  while (!check()) {
    if (Date.now() > by) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

function onDisk(file: string, text: string): Promise<void> {
  return waitFor(() => {
    try {
      return readFileSync(file, 'utf8').includes(text)
    } catch {
      return false
    }
  })
}

/** A clock and timers the test moves by hand. */
function manualClock(idle: () => Promise<void> = async () => {}, start = 1_000_000) {
  let now = start
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      timers.set(++next, { at: now + ms, fn })
      return next
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number)
    },
    /** Moves the clock by ms, running each timer as it comes due and the work it starts. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await settle()
        await idle()
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = end
      await settle()
    },
  }
}

function chat(id: string, status: ChatStatus = 'idle', over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: null,
    title: id,
    cwd: 'C:/work',
    account: { id: 'inst-68', label: '#68', configDir: null },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    status,
    activity: null,
    turnStartedAt: status === 'working' ? 1 : null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over,
  }
}

/** The chat manager as the queue sees it: a send writes the user item under the queue's uuid and starts a turn, as the real one does. */
class FakeChats {
  readonly chats = new Map<string, ChatSummary>()
  readonly items = new Map<string, TranscriptItem[]>()
  readonly sends: { id: string; text: string; images?: ImageRef[]; opts: SendOptions }[] = []
  readonly creates: { req: CreateChatRequest; waitForRoom: boolean }[] = []
  observe: (event: ServerEvent) => void = () => {}
  /** Sends never answer (one cut off mid-flight). */
  hang = false
  /** The chat turns busy between the queue's look and its send. */
  busyOnSend = false
  /** What every send is refused with (a session that cannot resume). */
  refuseSend: ChatError | null = null
  /** What 'auto' finds when a queued chat may wait. */
  room: 'no-room' | 'unreachable' | null = null
  createError: ChatError | null = null
  firstSendError: string | null = null

  add(...list: ChatSummary[]): void {
    for (const c of list) this.chats.set(c.id, c)
  }

  setStatus(id: string, status: ChatStatus, over: Partial<ChatSummary> = {}): void {
    const c = { ...this.chats.get(id)!, status, ...over }
    this.chats.set(id, c)
    this.observe({ type: 'chat.upsert', chat: { ...c } })
  }

  remove(id: string): void {
    this.chats.delete(id)
    this.observe({ type: 'chat.removed', chatId: id })
  }

  private get(id: string): ChatSummary {
    const c = this.chats.get(id)
    if (!c) throw new ChatError(404, `no chat ${id}`)
    return { ...c }
  }

  readonly api: QueueChats = {
    list: () => [...this.chats.values()].map((c) => ({ ...c })),
    get: (id) => this.get(id),
    listItems: (id) => {
      this.get(id)
      return this.items.get(id) ?? []
    },
    send: async (id, text, images, opts = {}) => {
      const c = this.get(id)
      this.sends.push({ id, text, images, opts })
      if (this.refuseSend) throw this.refuseSend
      const busy = this.busyOnSend || c.status === 'working' || c.status === 'needs_you' || (c.status === 'starting' && c.turnStartedAt !== null)
      if (opts.onlyIfReady && busy) throw new ChatBusyError()
      this.items.set(id, [...(this.items.get(id) ?? []), { kind: 'user', id: opts.messageId ?? `u-${this.sends.length}`, ts: 0, text }])
      this.setStatus(id, 'working', { turnStartedAt: 1 })
      if (this.hang) await new Promise(() => {})
      return { queued: busy }
    },
    createFromQueue: async (req, o) => {
      this.creates.push({ req, waitForRoom: o.waitForRoom })
      if (this.createError) throw this.createError
      if (o.waitForRoom && this.room && (!req.accountId || req.accountId === 'auto')) return { waiting: this.room }
      const c = chat(`new-${this.creates.length}`, 'closed', { cwd: req.cwd })
      this.chats.set(c.id, c)
      this.observe({ type: 'chat.upsert', chat: { ...c } })
      this.setStatus(c.id, 'starting', { turnStartedAt: 1 })
      return { chat: { ...c }, firstSend: Promise.resolve(this.firstSendError) }
    },
  }
}

function setup(...chats: ChatSummary[]) {
  const home = mkdtempSync(join(tmpdir(), 'desk-queue-'))
  temps.push(home)
  const clock = manualClock(() => t.q.quiet())
  const fake = new FakeChats()
  fake.add(...chats)
  const events: ServerEvent[] = []
  const open = () =>
    new QueueManager({ home, manager: fake.api, emit: (e) => events.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, settleMs: SETTLE, retryMs: RETRY, fileRetryMs: FILE_RETRY })
  const t = {
    home,
    clock,
    fake,
    events,
    q: open(),
    items: () => t.q.state().items,
    texts: () => fake.sends.map((s) => s.text),
    /** The server stops (the queue's hook first), every chat is 'closed' as a start loads it, and a new queue opens on the same home. */
    restart() {
      t.q.flushSync()
      t.q.stop()
      for (const c of fake.chats.values()) fake.chats.set(c.id, { ...c, status: 'closed', turnStartedAt: null })
      t.q = open()
    },
  }
  fake.observe = (e) => t.q.observe(e)
  return t
}

/** The status of the ChatError fn throws; 0 when it does not throw. */
function refused(fn: () => unknown): number {
  try {
    fn()
  } catch (err) {
    if (err instanceof ChatError) return err.status
    throw err
  }
  return 0
}

async function refusedAsync(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ChatError) return err.status
    throw err
  }
  return 0
}

test('a message for an idle chat goes once the chat has stayed ready for the settle time, under its own uuid', async () => {
  const t = setup(chat('c1'))
  const item = t.q.add({ kind: 'message', chatId: 'c1', text: 'next step' })
  expect(item).toMatchObject({ kind: 'message', chatId: 'c1', state: 'waiting', text: 'next step', rev: 1 })
  await t.clock.advance(SETTLE - 1)
  expect(t.fake.sends).toHaveLength(0)
  await t.clock.advance(1)
  expect(t.texts()).toEqual(['next step'])
  const sent = t.fake.sends[0]!
  expect(sent.opts.onlyIfReady).toBe(true)
  expect(sent.opts.now).toBe(false)
  expect(t.fake.items.get('c1')!.map((i) => i.id)).toEqual([sent.opts.messageId!])
  expect(t.items()).toEqual([])
  expect(t.events.at(-1)).toMatchObject({ type: 'queue.update', queue: { items: [] } })
})

test('one per turn: the next message waits for the turn the last one started to finish', async () => {
  const t = setup(chat('c1'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'one' })
  t.q.add({ kind: 'message', chatId: 'c1', text: 'two' })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['one'])
  expect(t.items()).toEqual([expect.objectContaining({ text: 'two', state: 'waiting', reason: REASON.turn })])
  await t.clock.advance(60_000)
  expect(t.texts()).toEqual(['one'])
  t.fake.setStatus('c1', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['one', 'two'])
})

test('a turn that starts inside the settle window wins; a dispatch that finds the chat busy waits again, not failed', async () => {
  const t = setup(chat('c1'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'queued' })
  await t.clock.advance(SETTLE / 2)
  // the owner sent one himself
  t.fake.setStatus('c1', 'working', { turnStartedAt: 1 })
  await t.clock.advance(SETTLE)
  expect(t.fake.sends).toHaveLength(0)
  expect(t.items()[0]).toMatchObject({ state: 'waiting', reason: REASON.turn })

  t.fake.busyOnSend = true
  t.fake.setStatus('c1', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.fake.sends).toHaveLength(1)
  expect(t.items()).toEqual([expect.objectContaining({ text: 'queued', state: 'waiting' })])

  t.fake.busyOnSend = false
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['queued', 'queued'])
  expect(t.items()).toEqual([])
})

test('a send the chat refuses for good fails the item once, where a busy chat only puts it back to wait', async () => {
  const t = setup(chat('c1'))
  const why = 'No folder on this machine has session s1, so it cannot be resumed.'
  t.fake.refuseSend = new ChatError(409, why)
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  await t.clock.advance(SETTLE * 4)
  expect(t.fake.sends).toHaveLength(1)
  expect(t.items()[0]).toMatchObject({ state: 'failed', reason: why })
})

test('a stopped chat holds its queue until resumed, through the leftover turn the stop did not cancel', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'after the stop' })
  t.fake.setStatus('c1', 'stopped', { turnStartedAt: null })
  await t.clock.advance(0)
  expect(t.q.state().held).toEqual({ c1: 'stopped' })
  expect(t.items()[0]).toMatchObject({ state: 'held', reason: REASON.stopped })

  // the CLI still runs what was queued in it: working, then idle; the hold stays
  t.fake.setStatus('c1', 'working', { turnStartedAt: 3 })
  t.fake.setStatus('c1', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE * 5)
  expect(t.fake.sends).toHaveLength(0)

  expect(t.q.resume('c1').items[0]).toMatchObject({ state: 'waiting', reason: null })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['after the stop'])
})

test('queued for a chat already stopped: held; resumed, the stopped chat sends, and what is added next is not held again', async () => {
  const t = setup(chat('c1', 'stopped'))
  expect(t.q.add({ kind: 'message', chatId: 'c1', text: 'a' })).toMatchObject({ state: 'held', reason: REASON.stopped })
  t.q.resume('c1')
  expect(t.q.add({ kind: 'message', chatId: 'c1', text: 'b' }).state).toBe('waiting')
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['a'])
})

test('a failed turn holds the queue with the chat error, and the chat closing after it idles does not release it', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  t.fake.setStatus('c1', 'error', { lastError: 'API Error: 500', turnStartedAt: null })
  await t.clock.advance(0)
  expect(t.items()[0]).toMatchObject({ state: 'held', reason: 'API Error: 500' })
  t.fake.setStatus('c1', 'closed')
  await t.clock.advance(SETTLE * 3)
  expect(t.fake.sends).toHaveLength(0)
  expect(t.q.state().held).toEqual({ c1: 'error' })
})

test('a limited chat waits for its reset, then sends', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  t.fake.setStatus('c1', 'limited', { limitResetsAt: t.clock.now() + 60_000, turnStartedAt: null })
  await t.clock.advance(59_000)
  expect(t.fake.sends).toHaveLength(0)
  expect(t.items()[0]!.reason).toBe(REASON.limit)
  await t.clock.advance(1_000 + SETTLE)
  expect(t.texts()).toEqual(['x'])
})

test('a limit with no known reset does not wait: the send goes, and the manager moves the chat to an account with room', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  t.fake.setStatus('c1', 'limited', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['x'])
})

test('a deleted chat fails its queued messages, and they cannot be tried again', async () => {
  const t = setup(chat('c1', 'working'))
  const item = t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  t.fake.remove('c1')
  await t.clock.advance(0)
  expect(t.items()[0]).toMatchObject({ state: 'failed', reason: REASON.deleted })
  expect(refused(() => t.q.retry(item.id))).toBe(409)
})

test('nothing goes while the queue is paused', async () => {
  const t = setup(chat('c1'))
  t.q.configure({ paused: true })
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  await t.clock.advance(SETTLE * 3)
  expect(t.fake.sends).toHaveLength(0)
  expect(t.items()[0]!.reason).toBe(REASON.paused)
  t.q.configure({ paused: false })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['x'])
})

test('new chats start in order, one at a time, while fewer than maxNewChats of those the queue started run', async () => {
  const t = setup()
  for (const prompt of ['one', 'two', 'three']) t.q.add({ kind: 'chat', cwd: t.home, prompt })
  await t.clock.advance(0)
  expect(t.fake.creates.map((c) => [c.req.prompt, c.waitForRoom])).toEqual([
    ['one', true],
    ['two', true],
  ])
  expect(t.items()).toEqual([expect.objectContaining({ kind: 'chat', text: 'three', state: 'waiting', reason: REASON.slot(2) })])
  t.fake.setStatus('new-1', 'idle', { turnStartedAt: null })
  await t.clock.advance(0)
  expect(t.fake.creates.map((c) => c.req.prompt)).toEqual(['one', 'two', 'three'])
  expect(t.items()).toEqual([])
})

test('an auto chat that finds no room waits and keeps the auto chats behind it waiting, not a named one; it tries again every retryMs', async () => {
  const t = setup()
  t.q.configure({ maxNewChats: 8 })
  t.fake.room = 'no-room'
  t.q.add({ kind: 'chat', cwd: t.home, prompt: 'auto one' })
  t.q.add({ kind: 'chat', cwd: t.home, prompt: 'auto two', accountId: 'auto' })
  t.q.add({ kind: 'chat', cwd: t.home, prompt: 'named', accountId: 'inst-68' })
  await t.clock.advance(0)
  expect(t.fake.creates.map((c) => c.req.prompt)).toEqual(['auto one', 'named'])
  expect(t.items().map((i) => [i.text, i.state, i.reason])).toEqual([
    ['auto one', 'waiting', REASON.room],
    ['auto two', 'waiting', REASON.room],
  ])
  t.fake.room = null
  await t.clock.advance(RETRY)
  expect(t.fake.creates.map((c) => c.req.prompt)).toEqual(['auto one', 'named', 'auto one', 'auto two'])
  expect(t.items()).toEqual([])
})

test('a create the manager refuses fails with its reason; a failed first message fails with the chat to open, and a retry sends it there', async () => {
  const t = setup()
  t.fake.createError = new ChatError(409, '#68 eek (Max 20x) is signed out')
  const a = t.q.add({ kind: 'chat', cwd: t.home, prompt: 'one', accountId: 'inst-68' })
  await t.clock.advance(0)
  expect(t.items()[0]).toMatchObject({ id: a.id, state: 'failed', reason: '#68 eek (Max 20x) is signed out', startedChatId: null })

  t.fake.createError = null
  t.q.remove(a.id)
  t.fake.firstSendError = 'the CLI could not start'
  const b = t.q.add({ kind: 'chat', cwd: t.home, prompt: 'two' })
  await t.clock.advance(0)
  const failed = t.items()[0]!
  expect(failed).toMatchObject({ id: b.id, kind: 'chat', state: 'failed', startedChatId: 'new-2' })
  expect(failed.reason).toContain('the CLI could not start')

  expect(t.q.retry(b.id)).toMatchObject({ id: b.id, kind: 'message', chatId: 'new-2', state: 'waiting', text: 'two' })
  t.fake.setStatus('new-2', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.fake.sends.at(-1)).toMatchObject({ id: 'new-2', text: 'two' })
})

test('the owner edits, reorders and removes; a stale rev, a wrong order and an unknown id are refused', async () => {
  const t = setup(chat('c1', 'working'))
  const a = t.q.add({ kind: 'message', chatId: 'c1', text: 'a' })
  const b = t.q.add({ kind: 'message', chatId: 'c1', text: 'b' })
  expect(refused(() => t.q.edit(a.id, { text: 'a2', ifRev: a.rev + 1 }))).toBe(409)
  expect(t.q.edit(a.id, { text: 'a2', ifRev: a.rev })).toMatchObject({ text: 'a2', rev: a.rev + 1 })
  expect(refused(() => t.q.edit(a.id, { text: '  ' }))).toBe(400)

  const rev = t.q.state().rev
  expect(refused(() => t.q.reorder({ ids: [b.id, a.id], ifRev: rev - 1 }))).toBe(409)
  expect(refused(() => t.q.reorder({ ids: [b.id] }))).toBe(409)
  expect(refused(() => t.q.reorder({ ids: [b.id, b.id] }))).toBe(409)
  expect(t.q.reorder({ ids: [b.id, a.id], ifRev: rev }).items.map((i) => i.text)).toEqual(['b', 'a2'])

  expect(refused(() => t.q.remove('nope'))).toBe(404)
  t.q.remove(b.id)
  expect(t.items().map((i) => i.text)).toEqual(['a2'])
  expect(refused(() => t.q.retry(a.id))).toBe(409)
})

test('editing a failed item puts it back in line', async () => {
  const t = setup()
  t.fake.createError = new ChatError(400, 'the folder C:\\gone does not exist')
  const a = t.q.add({ kind: 'chat', cwd: t.home, prompt: 'one' })
  await t.clock.advance(0)
  expect(t.items()[0]!.state).toBe('failed')
  t.fake.createError = null
  expect(t.q.edit(a.id, { text: 'one, again' })).toMatchObject({ state: 'waiting', reason: null })
  await t.clock.advance(0)
  expect(t.fake.creates.at(-1)!.req.prompt).toBe('one, again')
})

test('a sending item cannot be edited, removed or sent again', async () => {
  const t = setup(chat('c1'))
  t.fake.hang = true
  const a = t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  await t.clock.advance(SETTLE)
  expect(t.items()[0]!.state).toBe('sending')
  expect(refused(() => t.q.edit(a.id, { text: 'y' }))).toBe(409)
  expect(refused(() => t.q.remove(a.id))).toBe(409)
  expect(await refusedAsync(() => t.q.sendNow(a.id))).toBe(409)
})

test('send-now goes past the hold and the running turn, as a plain send does, and releases the hold', async () => {
  const t = setup(chat('c1', 'stopped'))
  const a = t.q.add({ kind: 'message', chatId: 'c1', text: 'now' })
  t.q.add({ kind: 'message', chatId: 'c1', text: 'later' })
  expect(t.q.state().held).toEqual({ c1: 'stopped' })
  t.fake.setStatus('c1', 'working', { turnStartedAt: 5 })
  expect(await t.q.sendNow(a.id)).toEqual({ ok: true, chatId: 'c1', queued: true })
  expect(t.fake.sends[0]!.opts.onlyIfReady).toBe(false)
  // A person's Send now: a running CliMayte worker takes it now, not after its whole task.
  expect(t.fake.sends[0]!.opts.now).toBe(true)
  expect(t.q.state().held).toEqual({})
  expect(t.items()).toEqual([expect.objectContaining({ text: 'later', state: 'waiting' })])
})

test('send-now starts a queued chat at once, past the pause, the slots and the wait for room', async () => {
  const t = setup()
  t.q.configure({ paused: true })
  t.fake.room = 'no-room'
  const a = t.q.add({ kind: 'chat', cwd: t.home, prompt: 'go' })
  expect(await t.q.sendNow(a.id)).toEqual({ ok: true, chatId: 'new-1', queued: false })
  expect(t.fake.creates).toEqual([{ req: expect.objectContaining({ cwd: t.home, prompt: 'go' }), waitForRoom: false }])
  expect(t.items()).toEqual([])
})

test('pictures are kept in the media cache and read back as bytes when the message goes; one that cannot be kept is refused', async () => {
  const t = setup(chat('c1'))
  const notAPicture = Buffer.from('not a picture').toString('base64')
  expect(refused(() => t.q.add({ kind: 'message', chatId: 'c1', text: '', images: [{ mediaType: 'image/png', dataBase64: notAPicture }] }))).toBe(400)
  expect(refused(() => t.q.add({ kind: 'message', chatId: 'c1', text: ' ' }))).toBe(400)
  expect(t.items()).toEqual([])

  const item = t.q.add({ kind: 'message', chatId: 'c1', text: 'see', images: [{ mediaType: 'image/png', dataBase64: PNG, name: 'shot.png' }] })
  expect(item.images).toEqual([{ mediaType: 'image/png', url: expect.stringMatching(/^\/api\/media\/[0-9a-f]{64}\.png$/), bytes: 8, name: 'shot.png' }])
  await onDisk(join(t.home, 'queue.json'), 'shot.png')
  expect(readFileSync(join(t.home, 'queue.json'), 'utf8')).not.toContain(PNG)
  await t.clock.advance(SETTLE)
  expect(t.fake.sends[0]!.images).toEqual([expect.objectContaining({ mediaType: 'image/png', dataBase64: PNG, name: 'shot.png' })])
})

test('the queue survives a restart as it was; a chat that was working is held until resumed', async () => {
  const t = setup(chat('c1', 'stopped'), chat('c2', 'working'))
  t.q.configure({ paused: true, sendMode: 'queue', maxNewChats: 3 })
  t.q.add({ kind: 'message', chatId: 'c1', text: 'held before' })
  t.q.add({ kind: 'message', chatId: 'c2', text: 'was waiting' })
  t.q.add({ kind: 'chat', cwd: t.home, prompt: 'a new chat', title: 'Later' })
  const before = t.q.state()
  t.restart()
  const after = t.q.state()
  expect(after).toMatchObject({ paused: true, sendMode: 'queue', maxNewChats: 3, held: { c1: 'stopped', c2: 'restart' } })
  expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
  expect(after.items[1]).toMatchObject({ state: 'held', reason: REASON.restart })
  expect(after.items[2]).toMatchObject({ kind: 'chat', state: 'waiting', title: 'Later', startedChatId: null })
})

test('a send cut off by the server ending is dropped when the transcript has its uuid, else it is queued again', async () => {
  const t = setup(chat('c1'), chat('c2'))
  t.fake.hang = true
  t.q.add({ kind: 'message', chatId: 'c1', text: 'delivered' })
  t.q.add({ kind: 'message', chatId: 'c2', text: 'lost' })
  await t.clock.advance(SETTLE)
  expect(t.items().map((i) => i.state)).toEqual(['sending', 'sending'])
  // c2's send never reached its chat
  t.fake.items.set('c2', [])
  t.restart()
  // both chats were working when it ended: what is left waits for the owner
  expect(t.items()).toEqual([expect.objectContaining({ chatId: 'c2', text: 'lost', state: 'held', reason: REASON.restart })])
  t.q.flushSync()
  expect(readFileSync(join(t.home, 'queue.json'), 'utf8')).not.toContain('sentUuid')
})

test('the chats closing after the queue stopped do not clear what the next start holds', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  t.q.stop()
  // closeAll, after the queue's stop hook
  t.fake.setStatus('c1', 'closed', { turnStartedAt: null })
  t.restart()
  expect(t.q.state().held).toEqual({ c1: 'restart' })
})

test('a chat held by the restart that turns out still working is released; its message waits for that turn', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'after this turn' })
  t.restart()
  expect(t.q.state().held).toEqual({ c1: 'restart' })
  // the host took the chat over: its turn kept running through the restart
  t.fake.setStatus('c1', 'working', { turnStartedAt: 1 })
  expect(t.q.state().held).toEqual({})
  await t.clock.advance(0)
  expect(t.items()[0]).toMatchObject({ state: 'waiting', reason: REASON.turn })
  t.fake.setStatus('c1', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['after this turn'])
})

test('a CliMayte chat working at the restart is not held: its worker runs on, and the message waits for it', async () => {
  const t = setup(chat('c1', 'working', { workerId: 'w-1' }))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'for the worker' })
  t.restart()
  expect(t.q.state().held).toEqual({})
  t.fake.setStatus('c1', 'working', { turnStartedAt: 1 })
  expect(t.items()[0]).toMatchObject({ state: 'waiting' })
  t.fake.setStatus('c1', 'idle', { turnStartedAt: null })
  await t.clock.advance(SETTLE)
  expect(t.texts()).toEqual(['for the worker'])
})

test('a missing or unreadable queue.json is an empty queue with the defaults; items of chats gone are dropped', async () => {
  const t = setup(chat('c1'))
  expect(t.q.state()).toEqual({ items: [], paused: false, sendMode: 'immediate', maxNewChats: 2, held: {}, rev: 0 })
  writeFileSync(join(t.home, 'queue.json'), '{ not json')
  t.restart()
  expect(t.q.state()).toEqual({ items: [], paused: false, sendMode: 'immediate', maxNewChats: 2, held: {}, rev: 0 })

  t.q.configure({ paused: true })
  t.q.add({ kind: 'message', chatId: 'c1', text: 'kept' })
  t.fake.add(chat('c2'))
  t.q.add({ kind: 'message', chatId: 'c2', text: 'its chat goes' })
  t.fake.chats.delete('c2')
  t.restart()
  expect(t.items().map((i) => i.text)).toEqual(['kept'])
})

test('an unreadable queue.json is kept as queue.json.bad-<time> before the queue starts empty', async () => {
  const t = setup(chat('c1'))
  const torn = '{ "items": [ { "id": "a", "text": "a prompt worth'
  writeFileSync(join(t.home, 'queue.json'), torn)
  t.restart()
  expect(t.items()).toEqual([])
  t.q.add({ kind: 'message', chatId: 'c1', text: 'new' })
  expect(readFileSync(join(t.home, `queue.json.bad-${t.clock.now()}`), 'utf8')).toBe(torn)
})

test('a queue.json that cannot be written strands nothing and sends nothing: the items wait and go once it can be', async () => {
  const t = setup(chat('c1'))
  const file = join(t.home, 'queue.json')
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  await onDisk(file, '"text":"x"')
  // a folder where queue.json goes: every rename onto it fails, as onto a file an antivirus scan holds
  rmSync(file)
  mkdirSync(file)
  const failed = spyOn(console, 'error').mockImplementation(() => {})
  const c = t.q.add({ kind: 'chat', cwd: t.home, prompt: 'go' })
  await t.q.quiet()
  expect(failed.mock.calls.filter((c) => String(c[0]).includes(file)).length).toBe(1)
  await t.clock.advance(SETTLE)
  expect(t.fake.sends).toHaveLength(0)
  expect(t.fake.creates).toHaveLength(0)
  expect(t.items().map((i) => i.state)).toEqual(['waiting', 'waiting'])
  expect(await refusedAsync(() => t.q.sendNow(c.id))).toBe(409)
  expect(t.items()[1]!.state).toBe('waiting')

  failed.mockRestore()
  rmSync(file, { recursive: true })
  await onDisk(file, '"text":"go"')
  await t.clock.advance(RETRY)
  expect(t.texts()).toEqual(['x'])
  expect(t.fake.creates).toHaveLength(1)
  expect(t.items()).toEqual([])
}, 20_000)

test('the chat manager is not sent a message until queue.json on disk names its uuid, so a restart can tell whether it went', async () => {
  const t = setup(chat('c1'))
  const file = join(t.home, 'queue.json')
  const namedOnDisk: boolean[] = []
  const send = t.fake.api.send
  t.fake.api.send = async (id, text, images, opts) => {
    namedOnDisk.push(readFileSync(file, 'utf8').includes(`"sentUuid":"${opts?.messageId}"`))
    return send(id, text, images, opts)
  }
  t.q.add({ kind: 'message', chatId: 'c1', text: 'next step' })
  await t.clock.advance(SETTLE)
  await waitFor(() => t.texts().length === 1)
  expect(namedOnDisk).toEqual([true])
}, 10_000)

test('nothing the queue throws reaches the chat manager that told it of a change', async () => {
  const t = setup(chat('c1', 'working'))
  t.q.add({ kind: 'message', chatId: 'c1', text: 'x' })
  // the window cannot be told
  t.events.push = () => {
    throw new Error('the socket closed')
  }
  expect(() => t.fake.setStatus('c1', 'stopped', { turnStartedAt: null })).not.toThrow()
  expect(t.q.state().held).toEqual({ c1: 'stopped' })
})
