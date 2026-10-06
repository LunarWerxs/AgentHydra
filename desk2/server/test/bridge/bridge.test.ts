// The bridge against a fake AgentHydra: reads, writes, AgentHydra down, and the poller's broadcasts.

import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@shared/protocol'
import { BridgeError, createBridge } from '../../src/bridge'
import { createClient } from '../../src/bridge/client'
import { createPoller } from '../../src/bridge/poller'
import { encodeProjectDir } from '../../src/bridge/session-jsonl'
import { deadUrl, type FakeHydra, NOW, remoteAnswer, startFakeHydra } from './fake-hydra'

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const fakes: FakeHydra[] = []

async function fake(): Promise<FakeHydra> {
  const f = await startFakeHydra()
  fakes.push(f)
  return f
}

const temps: string[] = []

afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
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

  test('overlapping workers() calls each list a missing extra worker once and leave the shared read alone', async () => {
    const f = await fake()
    const done = f.state.workers.find((w) => w.status === 'done')
    // More finished workers than AgentHydra's recent window: the last one is only found by id.
    const many = Array.from({ length: 25 }, (_, i) => ({ ...done, id: `w-many-${String(i).padStart(2, '0')}`, group: 'g-many', sessionId: null }))
    f.state.workers = [...f.state.workers, ...many]
    const extra = many[24].id
    const b = createBridge({ url: f.url, now: () => NOW })
    b.setExtraWorkerIds(() => [extra])
    const [a, c] = await Promise.all([b.workers(), b.workers()])
    for (const list of [a, c]) expect(list.filter((w) => w.id === extra).length).toBe(1)
    const gets = f.gets.filter((g) => g.startsWith('/api/corch/workers') && g.includes('limit='))
    expect(gets.length).toBe(1)
  })

  test('a failed sessions read is not cached: the next read after AgentHydra returns is the good one', async () => {
    const f = await fake()
    let t = NOW
    const b = createBridge({ url: f.url, now: () => t })
    await f.stop()
    expect(await b.externalSessions()).toEqual([])
    await f.start()
    t += 4000 // past the worker list's own 3 s tick; the sessions and chats reads (10 s) are still fresh
    expect((await b.externalSessions()).length).toBe(7)
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

  test('a pinned session stays listed however old; unpinned it ages out again', async () => {
    const f = await fake()
    const old = { ...f.state.sessions[0], session_id: sid(901), source: 'claude', last_activity_at: NOW - 3 * 24 * 3600_000 }
    f.state.sessions.push(old)
    const b = createBridge({ url: f.url, now: () => NOW })
    expect((await b.externalSessions()).map((s) => s.id)).not.toContain(sid(901))
    let pinned = [sid(901)]
    b.setSessionMeta((list) => list, () => pinned)
    expect((await b.externalSessions()).map((s) => s.id)).toContain(sid(901))
    pinned = []
    expect((await b.externalSessions()).map((s) => s.id)).not.toContain(sid(901))
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

  test('deliver-now is asked once per AgentHydra version; without it, an urgent send and a plain refusal', async () => {
    const f = await fake()
    f.state.version = '1.10.0'
    f.state.deliverNow = false
    const b = createBridge({ url: f.url, now: () => NOW })
    const probes = () => f.posts.filter((p) => p.path.endsWith('/deliver-now')).length

    expect(await b.canDeliverNow()).toBe(false)
    expect(await b.canDeliverNow()).toBe(false)
    expect(probes()).toBe(1)
    // An urgent send to the running worker stops its turn: one POST, `urgent: true`.
    expect(await b.sendToWorker('w-00000001', 'stop and fix the build', undefined, true)).toBe(true)
    expect(f.posts.at(-1)).toEqual({ path: '/api/corch/workers/w-00000001/send', body: { text: 'stop and fix the build', urgent: true } })
    // A message it already holds cannot go now: the reason names the version and is never a 404 page.
    const held = await b.sendToWorkerNow('w-00000001', 'stop and fix the build').catch((e) => e)
    expect(held).toMatchObject({ kind: 'http', status: 404 })
    expect(held.message).toMatch(/version 1\.10\.0.*goes when the current task ends.*Update AgentHydra/)

    // Updated: asked again, and deliver-now is used.
    f.state.version = '1.11.0'
    f.state.deliverNow = true
    expect(await b.canDeliverNow()).toBe(true)
    expect(probes()).toBe(3)
    expect(await b.sendToWorkerNow('w-00000001', 'stop and fix the build')).toBe(true)
  })
})

describe('poller', () => {
  function harness(url: string, clients = 1) {
    const events: ServerEvent[] = []
    let n = clients
    let t = NOW
    const b = createBridge({ url, now: () => t })
    const poller = createPoller({
      bridge: b,
      broadcast: (e) => events.push(e),
      wsClientCount: () => n,
      now: () => t,
    })
    return { events, poller, advance: (ms: number) => void (t += ms), setClients: (k: number) => void (n = k), types: () => events.map((e) => e.type) }
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
    expect(h.types().sort()).toEqual(['accounts.update', 'bridge.status', 'climayte.update', 'external.update', 'swarm.update'])
    expect(h.events.find((e) => e.type === 'bridge.status')).toEqual({ type: 'bridge.status', up: true, url: f.url })

    h.events.length = 0
    await h.poller.tick()
    expect(h.events).toEqual([])

    f.state.workers[1].status = 'running'
    h.advance(3000) // the shared worker read is reused for 3 s
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

  test('each tick reads the worker list once; the slow lists wait for their own freshness', async () => {
    const f = await fake()
    let t = NOW
    const poller = createPoller({
      bridge: createBridge({ url: f.url, now: () => t }),
      broadcast: () => {},
      wsClientCount: () => 1,
      now: () => t,
    })
    const reads = (prefix: string) => f.gets.filter((g) => g.startsWith(prefix)).length
    await poller.tick()
    expect(reads('/api/corch/workers?limit=20&lean=1')).toBe(1)
    t += 3000
    await poller.tick()
    t += 3000
    await poller.tick()
    expect(reads('/api/corch/workers?limit=20&lean=1')).toBe(3)
    expect(reads('/api/corch/remote')).toBe(1)
    expect(reads('/api/sessions?')).toBe(1)
    t += 8000
    await poller.tick()
    expect(reads('/api/sessions?')).toBe(2)
    expect(reads('/api/corch/remote')).toBe(1)
    t += 30_000
    await poller.tick()
    expect(reads('/api/corch/remote')).toBe(2)
  })

  test('a remote read that keeps failing is asked again after a wait that doubles, not on every tick', async () => {
    const f = await fake()
    f.state.remote = 'remote queues broke'
    let t = NOW
    const poller = createPoller({
      bridge: createBridge({ url: f.url, now: () => t }),
      broadcast: () => {},
      wsClientCount: () => 1,
      now: () => t,
    })
    const reads = () => f.gets.filter((g) => g.startsWith('/api/corch/remote')).length
    // Nine ticks 3 s apart: asked at 0, then 3 s, 6 s and 12 s after each failure (0, 3, 9 and 21 s).
    for (let at = 0; at <= 24_000; at += 3000) {
      t = NOW + at
      await poller.tick()
    }
    expect(reads()).toBe(4)
    // It answers again: the next read after the wait is kept for the usual 30 s.
    f.state.remote = remoteAnswer()
    t = NOW + 45_000
    await poller.tick()
    t = NOW + 48_000
    await poller.tick()
    expect(reads()).toBe(5)
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

  test('a worker sent to or cancelled from here is read again at once, not at the next interval', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url, now: () => NOW })
    // Intervals far past the test: any read after the first comes from the change alone.
    const poller = createPoller({ bridge: b, broadcast: () => {}, wsClientCount: () => 1, fastMs: 600_000, idleMs: 600_000, now: () => NOW })
    const lists = () => f.gets.filter((g) => g.split('?')[0] === '/api/corch/workers').length
    // Waits until the list has been read past `n` times and the poll that read it is over (it reads more after).
    const readPast = async (n: number) => {
      for (let i = 0; i < 100 && lists() <= n; i++) await Bun.sleep(20)
      await Bun.sleep(150)
      return lists()
    }
    poller.start()
    try {
      const first = await readPast(0)
      expect(first).toBeGreaterThan(0)
      await b.sendToWorker('w-00000001', 'also run the lint')
      const sent = await readPast(first)
      expect(sent).toBeGreaterThan(first)
      await b.cancelWorker('w-00000001')
      expect(await readPast(sent)).toBeGreaterThan(sent)
    } finally {
      poller.stop()
    }
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
    expect(h.types().sort()).toEqual(['accounts.update', 'bridge.status', 'climayte.update', 'external.update', 'swarm.update'])
  })
})

describe('a worker moved to another account', () => {
  const SESSION = sid(77)
  const CWD = 'C:/Users/me/Desktop/Project/Example'
  const line = (kind: 'user' | 'assistant', n: number, text: string) =>
    JSON.stringify(
      kind === 'user'
        ? { type: 'user', uuid: `u${n}`, timestamp: new Date(NOW + n * 1000).toISOString(), message: { role: 'user', content: text } }
        : { type: 'assistant', uuid: `a${n}`, timestamp: new Date(NOW + n * 1000).toISOString(), message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text }] } },
    )

  /** Two CLI instances' folders, `old-acct` listed first; the session written on `old-acct` only. */
  async function moved() {
    const home = mkdtempSync(join(tmpdir(), 'desk-moved-'))
    temps.push(home)
    const dir = (name: string) => join(home, name)
    const file = (name: string) => join(dir(name), 'projects', encodeProjectDir(CWD), `${SESSION}.jsonl`)
    mkdirSync(join(dir('old'), 'projects', encodeProjectDir(CWD)), { recursive: true })
    writeFileSync(file('old'), `${line('user', 1, 'first question')}
${line('assistant', 2, 'first answer')}
`)
    const f = await fake()
    const instance = (id: string, num: number) => ({ num, id, name: `Example ${num}`, configDir: dir(id === 'old-acct' ? 'old' : 'new'), loggedIn: true, lastUsageCheck: null })
    f.state.instances = [instance('old-acct', 1), instance('new-acct', 2)]
    const b = createBridge({ url: f.url, now: () => NOW, home, projectRoots: () => [join(dir('old'), 'projects'), join(dir('new'), 'projects')] })
    /** The move: the session copied into new-acct's folder with the old file's time, as AgentHydra's cpSync leaves it. */
    const copy = () => {
      mkdirSync(join(dir('new'), 'projects', encodeProjectDir(CWD)), { recursive: true })
      cpSync(file('old'), file('new'))
      const { atime, mtime } = statSync(file('old'))
      utimesSync(file('new'), atime, mtime)
    }
    /** The worker answers on new-acct: its file grows, the old account's copy stays as the move left it. */
    const answer = () => writeFileSync(file('new'), `${line('user', 3, 'second question')}
${line('assistant', 4, 'second answer')}
`, { flag: 'a' })
    const read = (accountId: string, rescan = false) => b.workerItems([SESSION], CWD, { rescan, writing: { sessionId: SESSION, accountId } })
    const texts = async (accountId: string, rescan = false) => (await read(accountId, rescan)).filter((i) => i.kind === 'assistant_text').map((i) => (i as { text: string }).text)
    return { copy, answer, texts }
  }

  test("the copy on its new account is read, though the move left both copies the same time", async () => {
    const m = await moved()
    expect(await m.texts('old-acct')).toEqual(['first answer'])
    m.copy()
    // The poll that sees the new account (rescan) while both copies tie on time.
    expect(await m.texts('new-acct', true)).toEqual(['first answer'])
    m.answer()
    expect(await m.texts('new-acct')).toEqual(['first answer', 'second answer'])
  })

  test('a copy that lands after the poll that saw the move is still found', async () => {
    const m = await moved()
    expect(await m.texts('old-acct')).toEqual(['first answer'])
    // AgentHydra names the new account before the copy is on disk: the old copy is all there is.
    expect(await m.texts('new-acct', true)).toEqual(['first answer'])
    m.copy()
    m.answer()
    expect(await m.texts('new-acct')).toEqual(['first answer', 'second answer'])
  })
})
