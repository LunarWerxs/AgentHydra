// plugins/72-babysitter.ts through its routes: Desk's chats, the outside sessions, the accounts and the send queue come
// from stand-in routes on the same app (as the orchestrator's test does), and the stand-ins record every continue the
// babysitter sends. Its memory goes to a temp home; nothing outside it is read or written.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ChatSummary, DeskSettings, ExternalLimit, ExternalSession } from '@shared/protocol'
import { BABYSITTER_FROM, type BabysitterStatus } from '@shared/babysitter'
import type { ServerContext } from '../../src/context'
import { QUICK_MS } from '../../src/babysitter/decide'
import plugin from '../../src/plugins/72-babysitter'

const NOW = Date.now()
const STOP = "You've hit your session limit · resets 11:40pm (America/Chicago)"
const LEAD = `[${BABYSITTER_FROM}] Not from the user.\nYour account's usage limit stopped your last turn, and the limit has reset.`
const temps: string[] = []
const stops: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function chat(id: string, fields: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id, sessionId: null, title: id, cwd: '/work/repo', account: { id: 'default', label: '#1', configDir: null }, accountAuto: false,
    model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'idle', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0, ...fields
  }
}
function outside(id: string, fields: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id, title: id, cwd: '/work/other', source: 'desktop', instance: '#2', status: 'idle', activity: null, lastActivityAt: NOW - 3 * 3_600_000, model: null,
    accountId: null, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...fields
  }
}
/** A stop three hours ago whose limit reset five minutes ago. */
const reset: ExternalLimit = { notice: STOP, at: NOW - 3 * 3_600_000, resetsAt: NOW - 5 * 60_000 }

interface World {
  own: ChatSummary[]
  outside: ExternalSession[]
  /** Messages in the send queue, not yet delivered (a test delivers them by emptying it). */
  queued: { chatId: string; text: string }[]
  /** What reached an outside chat. */
  delivered: { id: string; text: string }[]
  /** The status AgentHydra answers a delivery with (409: nothing runs the chat). */
  delivery: number
  /** Every request that would change something. */
  sent: string[]
  home: string
  settings: { babysitter: boolean }
}

function world(own: ChatSummary[], others: ExternalSession[] = []): World {
  const home = mkdtempSync(join(tmpdir(), 'desk-babysitter-'))
  temps.push(home)
  return { own, outside: others, queued: [], delivered: [], delivery: 200, sent: [], home, settings: { babysitter: true } }
}

/** The babysitter over stand-in routes reading `w`. Two calls on one world are a Desk restart. */
function desk(w: World): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.path !== '/api/babysitter') w.sent.push(`${c.req.method} ${c.req.path}`)
    await next()
  })
  app.get('/api/chats', (c) => c.json(w.own))
  app.get('/api/external/sessions', (c) => c.json(w.outside))
  app.get('/api/accounts', (c) => c.json([]))
  app.get('/api/queue', (c) =>
    c.json({
      items: w.queued.map(({ chatId, text }, i) => ({ id: `q${i}`, rev: 1, createdAt: NOW, updatedAt: NOW, state: 'waiting', reason: null, text, kind: 'message', chatId })),
      paused: false, sendMode: 'immediate', maxNewChats: 1, held: {}, rev: 0
    })
  )
  app.post('/api/queue', async (c) => {
    w.queued.push((await c.req.json()) as { chatId: string; text: string })
    return c.json({ id: 'q' })
  })
  app.post('/api/external/sessions/:id/message', async (c) => {
    if (w.delivery !== 200) return c.json({ error: 'no running engine holds this chat' }, w.delivery as 409)
    w.delivered.push({ id: c.req.param('id'), text: ((await c.req.json()) as { text: string }).text })
    return c.json({ ok: true })
  })
  const ctx = {
    home: w.home,
    settings: () => w.settings as unknown as DeskSettings,
    updateSettings: (patch: Partial<DeskSettings>) => Object.assign(w.settings, patch) as unknown as DeskSettings,
    onStop: (fn: () => void | Promise<void>) => stops.push(fn),
    deps: {}
  } as unknown as ServerContext
  plugin(app, ctx)
  return app
}

const look = async (app: Hono): Promise<BabysitterStatus> => (await (await app.request('/api/babysitter?fresh=1')).json()) as BabysitterStatus
const states = (s: BabysitterStatus): Record<string, string> => Object.fromEntries(s.stopped.map((c) => [c.id, c.state]))

test('it waits for each reset, then continues every stopped chat once through its own channel, and a restart sends nothing twice', async () => {
  const w = world(
    [
      chat('due', { status: 'limited', limitResetsAt: NOW - 5 * 60_000 }),
      chat('later', { status: 'limited', limitResetsAt: NOW + 3_600_000 }),
      chat('fine'),
      chat('archived', { status: 'limited', limitResetsAt: NOW - 5 * 60_000, archived: true })
    ],
    [
      outside('d-due', { limit: reset }),
      outside('d-later', { instance: '#3', limit: { notice: STOP, at: NOW - 600_000, resetsAt: NOW + 3_600_000 } }),
      // only its own terminal can continue a CLI session; Codex, and a chat another PC runs, are not the babysitter's
      outside('term', { source: 'cli', limit: reset }),
      outside('codex', { source: 'codex', limit: reset }),
      outside('synced', { fromPc: 'OTHER-PC', limit: reset })
    ]
  )
  const app = desk(w)
  const first = await look(app)
  expect(w.sent).toEqual(['POST /api/queue', 'POST /api/external/sessions/d-due/message'])
  expect(w.queued.map((q) => q.chatId)).toEqual(['due'])
  expect(w.queued[0].text).toStartWith(LEAD)
  expect(w.delivered).toEqual([{ id: 'd-due', text: w.queued[0].text }])
  expect(states(first)).toEqual({ due: 'resumed', later: 'waiting', 'd-due': 'resumed', 'd-later': 'waiting', term: 'no-engine' })
  // How many each account has stopped, and when the soonest of them resets.
  expect(first.accounts.map((a) => [a.account, a.stopped, a.resetsAt])).toEqual([
    ['#2', 2, NOW - 5 * 60_000],
    ['#1', 2, NOW - 5 * 60_000],
    ['#3', 1, NOW + 3_600_000]
  ])
  expect(first.acts.map((a) => [a.id, a.did])).toEqual([['d-due', 'resumed'], ['due', 'resumed']])
  expect(first.nextCheckAt).toBeLessThanOrEqual(Date.now() + first.everyMs)

  // The next look sends nothing: both continues are on their way.
  await look(app)
  expect(w.sent).toHaveLength(2)
  // The queue delivers its message (the chat has not moved yet), and Desk restarts: its memory holds both continues.
  w.queued.splice(0)
  for (const s of stops.splice(0)) await s()
  const again = await look(desk(w))
  expect(w.sent).toHaveLength(2)
  expect(again.stopped.find((c) => c.id === 'due')).toMatchObject({ state: 'resumed', tries: 1 })
})

test('a Desktop chat nothing runs is not counted and is continued once something does', async () => {
  const w = world([], [outside('d', { limit: reset })])
  w.delivery = 409
  const app = desk(w)
  const first = await look(app)
  expect(first.stopped[0]).toMatchObject({ id: 'd', state: 'no-engine', tries: 0 })
  expect(first.acts.map((a) => a.did)).toEqual(['no-engine'])
  // Still unreachable: tried again, but noted once.
  expect((await look(app)).acts).toHaveLength(1)
  w.delivery = 200
  const later = await look(app)
  expect(w.delivered.map((d) => d.id)).toEqual(['d'])
  expect(later.stopped[0]).toMatchObject({ state: 'resumed', tries: 1 })
})

test('a chat that stops again at once after each continue is left to a person after three; one that later stops anew is continued', async () => {
  const w = world([chat('loop', { status: 'limited', limitResetsAt: NOW - 5 * 60_000 })])
  const app = desk(w)
  for (const n of [1, 2, 3]) {
    await look(app)
    expect(w.queued.map((q) => q.chatId)).toEqual(['loop'])
    // Delivered; it ran and stopped again at once.
    w.queued.splice(0)
    w.own[0] = { ...w.own[0], updatedAt: Date.now() + n }
  }
  const fourth = await look(app)
  expect(w.queued).toEqual([])
  expect(fourth.stopped[0]).toMatchObject({ state: 'gave-up', tries: 3 })
  expect(fourth.acts[0]).toMatchObject({ id: 'loop', did: 'gave-up' })
  await look(app)
  expect([w.queued, w.sent.length]).toEqual([[], 3])
  // A person sends in it and it works a while before the limit stops it again: a new stop, counted afresh.
  w.own[0] = { ...w.own[0], updatedAt: Date.now() + QUICK_MS + 60_000 }
  const fresh = await look(app)
  expect(w.queued.map((q) => q.chatId)).toEqual(['loop'])
  expect(fresh.stopped[0]).toMatchObject({ state: 'resumed', tries: 1 })
})

test('switched off it sends nothing and says why; switched on it continues at once', async () => {
  const w = world([chat('due', { status: 'limited', limitResetsAt: NOW - 5 * 60_000 })], [outside('d-due', { limit: reset })])
  const app = desk(w)
  const post = async (body: unknown): Promise<BabysitterStatus> =>
    (await (await app.request('/api/babysitter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as BabysitterStatus
  const off = await post({ enabled: false, check: true })
  expect([off.enabled, w.settings.babysitter, w.sent]).toEqual([false, false, []])
  expect(off.stopped.map((c) => [c.id, c.state, c.reason])).toEqual([
    ['d-due', 'waiting', 'its limit has reset; the babysitter is off, so it waits'],
    ['due', 'waiting', 'its limit has reset; the babysitter is off, so it waits']
  ])
  const on = await post({ enabled: true })
  expect(w.sent).toEqual(['POST /api/queue', 'POST /api/external/sessions/d-due/message'])
  expect(states(on)).toEqual({ due: 'resumed', 'd-due': 'resumed' })
})
