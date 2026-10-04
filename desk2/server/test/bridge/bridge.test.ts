// The bridge against a fake AgentHydra: reads, writes, AgentHydra down, and the poller's broadcasts.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerEvent } from '@shared/protocol'
import { BridgeError, createBridge } from '../../src/bridge'
import { createClient } from '../../src/bridge/client'
import { createPoller } from '../../src/bridge/poller'
import { deadUrl, type FakeHydra, NOW, startFakeHydra } from './fake-hydra'

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const fakes: FakeHydra[] = []

async function fake(): Promise<FakeHydra> {
  const f = await startFakeHydra()
  fakes.push(f)
  return f
}

afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})

describe('client', () => {
  test('nothing listening is a "down" error, an error status keeps its status', async () => {
    const down = await createClient({ url: deadUrl() }).health().catch((e) => e)
    expect(down).toBeInstanceOf(BridgeError)
    expect(down.kind).toBe('down')
    expect(down.unreachable).toBe(true)

    const f = await fake()
    const missing = await createClient({ url: f.url }).worker('w-nope').catch((e) => e)
    expect(missing).toMatchObject({ kind: 'http', status: 404, unreachable: false })
  })

  test('a daemon that hangs past the timeout is a "timeout" error', async () => {
    const hang = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    try {
      const err = await createClient({ url: `http://127.0.0.1:${hang.port}`, timeoutMs: 100 }).health().catch((e) => e)
      expect(err).toMatchObject({ kind: 'timeout', unreachable: true })
    } finally {
      hang.stop(true)
    }
  })
})

describe('bridge', () => {
  test('lists accounts through AgentHydra; the pick is the default login (CliMayte places chats)', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url, now: () => NOW })
    expect((await b.listAccounts()).length).toBe(6)
    expect((await b.pickAccount()).id).toBe('default')
  })

  test('AgentHydra down: the default login, no sessions, no workers, never a throw', async () => {
    const b = createBridge({ url: deadUrl(), now: () => NOW })
    expect(await b.status()).toEqual({ up: false, url: b.url })
    expect((await b.listAccounts()).map((a) => a.id)).toEqual(['default'])
    expect((await b.pickAccount()).id).toBe('default')
    expect(await b.externalSessions()).toEqual([])
    expect(await b.workers()).toEqual([])
    expect(await b.activeWorkersFor(sid(1))).toEqual([])
  })

  test('external sessions leave out the ids the engine registers', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url, now: () => NOW })
    expect((await b.externalSessions()).length).toBe(7)
    b.setExcludeSessionIds(async () => [sid(3)])
    const ids = (await b.externalSessions()).map((s) => s.id)
    expect(ids).not.toContain(sid(3))
    expect(ids.length).toBe(6)
  })

  test('items come from the tail, a worker falls back to its detail, an unknown id is a 404', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url, now: () => NOW })
    expect((await b.externalItems(sid(1)))[0]).toMatchObject({ kind: 'user', text: 'Run the tests and fix what fails.' })
    const worker = await b.externalItems(sid(500))
    expect(worker[1]).toMatchObject({ kind: 'user', text: 'Build the thing. Done means the tests pass.' })
    expect(await b.externalItems(sid(999)).catch((e) => e)).toMatchObject({ kind: 'http', status: 404 })
  })

  test('workers, activeWorkersFor, cancel and send', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url, now: () => NOW })
    expect((await b.workers()).length).toBe(4)
    expect((await b.activeWorkersFor(sid(1))).map((w) => w.id)).toEqual(['w-00000001', 'w-00000002'])

    await b.sendToWorker('w-00000001', 'also run the lint')
    expect(f.posts.at(-1)).toEqual({ path: '/api/corch/workers/w-00000001/send', body: { text: 'also run the lint' } })
    expect(await b.sendToWorker('w-missing', 'hi').catch((e) => e)).toMatchObject({ status: 404 })
    expect(await b.sendToWorker('w-00000003', 'hi').catch((e) => e)).toMatchObject({ status: 400 })

    await b.cancelWorker('w-00000001')
    expect(f.posts.at(-1)).toEqual({ path: '/api/corch/cancel', body: { id: 'w-00000001' } })
    // cancelled now: a second cancel has nothing to stop
    expect(await b.cancelWorker('w-00000001').catch((e) => e)).toMatchObject({ status: 409 })
    expect((await b.activeWorkersFor(sid(1))).map((w) => w.id)).toEqual(['w-00000002'])
  })
})

describe('poller', () => {
  function harness(url: string, clients = 1) {
    const events: ServerEvent[] = []
    let n = clients
    const b = createBridge({ url, now: () => NOW })
    const poller = createPoller({
      bridge: b,
      broadcast: (e) => events.push(e),
      wsClientCount: () => n,
      now: () => NOW,
    })
    return { events, poller, setClients: (k: number) => void (n = k), types: () => events.map((e) => e.type) }
  }

  test('polls nothing while no window is connected', async () => {
    const f = await fake()
    const h = harness(f.url, 0)
    await h.poller.tick()
    expect(h.events).toEqual([])
    expect(f.gets).toEqual([])
  })

  test('broadcasts each list once, then only when it changed', async () => {
    const f = await fake()
    const h = harness(f.url)
    await h.poller.tick()
    expect(h.types().sort()).toEqual(['accounts.update', 'bridge.status', 'climayte.update', 'external.update'])
    expect(h.events.find((e) => e.type === 'bridge.status')).toEqual({ type: 'bridge.status', up: true, url: f.url })

    h.events.length = 0
    await h.poller.tick()
    expect(h.events).toEqual([])

    f.state.workers[1].status = 'running'
    await h.poller.tick()
    // the worker list changed, and with it its session (waiting -> working)
    expect(h.types().sort()).toEqual(['climayte.update', 'external.update'])
    const w = h.events.find((e) => e.type === 'climayte.update') as Extract<ServerEvent, { type: 'climayte.update' }>
    expect(w.workers.find((x) => x.id === 'w-00000002')!.status).toBe('running')
  })

  test('accounts are read every 30 s, not every tick', async () => {
    const f = await fake()
    let t = NOW
    const events: ServerEvent[] = []
    const poller = createPoller({
      bridge: createBridge({ url: f.url, now: () => t }),
      broadcast: (e) => events.push(e),
      wsClientCount: () => 1,
      now: () => t,
    })
    await poller.tick()
    const reads = () => f.gets.filter((g) => g === '/api/cli-instances').length
    expect(reads()).toBe(1)
    t += 3000
    await poller.tick()
    expect(reads()).toBe(1)
    t += 30_000
    await poller.tick()
    expect(reads()).toBe(2)
  })

  test('AgentHydra going down then up: status flips, lists empty then refill', async () => {
    const f = await fake()
    const h = harness(f.url)
    await h.poller.tick()
    h.events.length = 0

    await f.stop()
    await h.poller.tick()
    expect(h.events).toEqual([
      { type: 'bridge.status', up: false, url: f.url },
      { type: 'external.update', sessions: [] },
      { type: 'climayte.update', workers: [] },
      expect.objectContaining({ type: 'accounts.update' }),
    ])
    const acc = h.events[3] as Extract<ServerEvent, { type: 'accounts.update' }>
    expect(acc.accounts.map((a) => a.id)).toEqual(['default'])

    // still down: nothing new to say
    h.events.length = 0
    await h.poller.tick()
    expect(h.events).toEqual([])

    await f.start()
    await h.poller.tick()
    expect(h.events[0]).toEqual({ type: 'bridge.status', up: true, url: f.url })
    const ext = h.events.find((e) => e.type === 'external.update') as Extract<ServerEvent, { type: 'external.update' }>
    expect(ext.sessions.length).toBe(7)
    expect(h.types()).toContain('accounts.update')
  })

  test('a window connecting after none were gets everything again', async () => {
    const f = await fake()
    const h = harness(f.url)
    await h.poller.tick()
    h.setClients(0)
    await h.poller.tick()
    h.events.length = 0
    h.setClients(1)
    await h.poller.tick()
    expect(h.types().sort()).toEqual(['accounts.update', 'bridge.status', 'climayte.update', 'external.update'])
  })
})
