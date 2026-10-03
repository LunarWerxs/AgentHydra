// server/tests/climayte-queue-sync.test.ts — two PCs share their CliMayte queue through the login
// sync's store and do not step on each other.
//
// The contract (core/climayte-queue-sync.ts, climayte-remote.ts, cloud/login-sync-worker/worker.js):
// a queue snapshot opens only under its own PC's id; a snapshot over the store's cap loses its oldest
// finished workers and never an active one; what the other PC has running counts toward an account's
// cap here (a stale snapshot counts for nothing); a queue that cannot sync reports itself in
// `queueError` and leaves the logins' status alone. The store is the real Worker on bun:sqlite
// (login-sync-store.ts); the other PC is played by writing to it with the key from the pairing code;
// an older Worker (no queue routes) is a tiny stand-in server.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { MAX_PER_ACCOUNT, pickAccount } from '../src/climayte'
import { liveByAccount, workers } from '../src/climayte-core'
import {
  buildStatus,
  clearRemote,
  type QueueSnapshot,
  type RemoteWorker,
  remoteSnapshots,
  setRemote,
} from '../src/climayte-remote'
import { tickState } from '../src/climayte-schedule'
import {
  configureLoginSync,
  disconnectLoginSync,
  loginSyncPairingCode,
  loginSyncStatus,
  runLoginSync,
  setQueueSharing,
} from '../src/core/cli-login-sync'
import {
  fitSnapshot,
  HEARTBEAT_MS,
  LIVE_GATE_MS,
  openQueue,
  resetQueueSync,
  sealQueue,
  syncQueue,
} from '../src/core/climayte-queue-sync'
import { app } from '../src/http-app'
import '../src/routes/climayte'
import { base, store, token } from './login-sync-store'

// http-app.ts is ONE object for the whole test process; request through a copy (see
// queue-patch-guard.test.ts) so it stays open for later files.
const http = new Hono().route('/', app)

const key = randomBytes(32)
const rw = (over: Partial<RemoteWorker> = {}): RemoteWorker => ({
  id: `w-${randomBytes(4).toString('hex')}`,
  title: 'a task',
  group: 'g-1',
  status: 'running',
  kind: null,
  model: null,
  effort: null,
  account: { id: 'acct-a', num: 7, name: 'a@example.com' },
  createdAt: 1,
  updatedAt: 1,
  activeS: 0,
  costUsd: 0,
  lastActivity: null,
  error: null,
  verdict: null,
  ...over,
})
const snapshot = (pc: string, list: RemoteWorker[], at = Date.now()): QueueSnapshot => ({
  pc,
  name: 'OTHER-PC',
  at,
  workers: list,
  live: { 'acct-a': { sessionPct: 12, weekPct: 3, at } },
})

describe('the queue snapshot', () => {
  test('opens only under its own PC and key', () => {
    const pc = randomUUID()
    const snap = snapshot(pc, [rw({ title: 'build the thing' })])
    const blob = sealQueue(key, snap)
    expect(openQueue(key, pc, blob)).toEqual(snap)
    // Passed off as another PC's, or opened with another key: refused.
    expect(openQueue(key, randomUUID(), blob)).toBeNull()
    expect(openQueue(randomBytes(32), pc, blob)).toBeNull()
  })

  test('carries the sender’s build through the seal, and an old snapshot without one still opens', () => {
    const pc = randomUUID()
    const build = { version: '1.2.3', commit: 'abc1234', date: '2026-10-02T18:40:00.000Z' }
    expect(openQueue(key, pc, sealQueue(key, { ...snapshot(pc, []), build }))?.build).toEqual(build)
    expect(openQueue(key, pc, sealQueue(key, snapshot(pc, [])))?.build).toBeUndefined()
  })

  test('over the cap the oldest finished workers go first and every active one stays', () => {
    const pc = randomUUID()
    // Random titles do not compress, so the size grows with the count.
    const noise = () => randomBytes(150).toString('hex')
    const active = ['queued', 'running', 'waiting', 'checking'].map((status, i) =>
      rw({ status, title: noise(), updatedAt: 10 + i }),
    )
    const finished = Array.from({ length: 200 }, (_, i) =>
      rw({ status: 'done', title: noise(), updatedAt: 1_000 + 200 - i }),
    )
    // Newest first, as buildSnapshot hands them over; the actives are the oldest of all.
    const all = [...finished, ...active].sort((a, b) => b.updatedAt - a.updatedAt)
    const max = 40_000
    const out = fitSnapshot(key, snapshot(pc, all), max)
    expect(out.blob.length).toBeLessThanOrEqual(max)
    expect(openQueue(key, pc, out.blob)?.workers.length).toBe(out.snap.workers.length)
    const kept = out.snap.workers
    for (const a of active) expect(kept.map((w) => w.id)).toContain(a.id)
    const keptFinished = kept.filter((w) => w.status === 'done')
    expect(keptFinished.length).toBeGreaterThan(0)
    expect(keptFinished.length).toBeLessThan(finished.length)
    // What stayed is the newest of the finished ones.
    expect(keptFinished.map((w) => w.id)).toEqual(
      finished.slice(0, keptFinished.length).map((w) => w.id),
    )
  })
})

describe('whether the other PC runs an older AgentHydra', () => {
  const mine = { version: '1.0.0', commit: 'bbbbbbb', date: '2026-10-03T12:00:00.000Z' }
  const at = (iso: string) => ({ version: '1.0.0', commit: 'abc1234', date: iso })

  test('no build at all reads as behind', () => {
    const s = buildStatus('CornuCopia', null, mine)
    expect(s).toMatchObject({ build: null, behind: true })
    expect(s.behindNote).toContain('CornuCopia runs an older AgentHydra')
  })

  test('an older commit reads behind, naming its commit and date', () => {
    const s = buildStatus('CornuCopia', at('2026-10-02T18:40:00.000Z'), mine)
    expect(s.behind).toBe(true)
    expect(s.behindNote).toContain('abc1234, Oct 2, 18:40 UTC')
    expect(s.behindNote).toContain('Settings -> Update on that PC')
  })

  test('a newer commit says this PC is behind, and the same hour says nothing', () => {
    const newer = buildStatus('CornuCopia', at('2026-10-04T00:00:00.000Z'), mine)
    expect(newer.behind).toBe(false)
    expect(newer.behindNote).toContain('This PC is behind CornuCopia')
    expect(buildStatus('CornuCopia', at('2026-10-03T11:30:00.000Z'), mine)).toMatchObject({
      behind: false,
      behindNote: null,
    })
  })
})

describe('placement beside the other PC', () => {
  const acct = {
    id: 'acct-a',
    num: 7,
    name: 'a@example.com',
    configDir: join(tmpdir(), 'acct-a'),
    sessionPct: 10,
    weekPct: 10,
  }
  const place = () => {
    const s = tickState([acct], Date.now())
    return pickAccount(
      { accounts: null, accountId: null, attempts: [], pending: [] } as any,
      [acct],
      {},
      s.active,
      MAX_PER_ACCOUNT,
      Date.now(),
      new Map(),
    )
  }

  test('what the other PC has running fills the account here; a stale snapshot does not', () => {
    clearRemote()
    expect(place()?.id).toBe('acct-a')
    const full = Array.from({ length: MAX_PER_ACCOUNT }, () => rw({ status: 'running' }))
    const pc = randomUUID()
    setRemote(snapshot(pc, full), 1)
    expect(place()).toBeNull()
    // The other PC went quiet: its workers no longer hold the account.
    setRemote(snapshot(pc, full, Date.now() - 41 * 60_000), 2)
    expect(place()?.id).toBe('acct-a')
    clearRemote()
  })
})

describe('a pass through the store', () => {
  afterAll(() => {
    disconnectLoginSync()
    clearRemote()
    workers.delete('w-mine')
  })

  test('uploads this PC’s queue and reads the other PC’s', async () => {
    clearRemote()
    resetQueueSync()
    workers.set('w-mine', {
      id: 'w-mine',
      group: 'g-mine',
      title: 'my own task',
      cwd: 'C:/secret/path',
      prompt: 'the private prompt',
      pending: [],
      model: null,
      effort: null,
      accounts: null,
      status: 'queued',
      sessionId: null,
      accountId: null,
      attempts: [],
      result: null,
      error: null,
      lastActivity: null,
      costUsd: 0,
      turns: 0,
      moves: 0,
      retries: 0,
      notBefore: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any)
    expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
    expect(loginSyncStatus().shareQueue).toBe(false)
    expect(setQueueSharing(true).ok).toBe(true)
    const pairing = loginSyncPairingCode()!
    const syncKey = Buffer.from(
      JSON.parse(Buffer.from(pairing.slice('ahsync1:'.length), 'base64url').toString()).k,
      'base64',
    )
    // The other PC: one running worker on acct-a.
    const other = randomUUID()
    const theirs = snapshot(other, [rw({ title: 'their task', status: 'running' })])
    const put = await store('PUT', `/v1/queues/${other}`, {
      version: 0,
      blob: sealQueue(syncKey, theirs),
      meta: { name: 'OTHER-PC', at: theirs.at, count: 1 },
    })
    expect(put.status).toBe(200)

    await runLoginSync() // a pass setup started may have begun before sharing was on
    const res = await runLoginSync()
    expect(res.ok).toBe(true)
    const status = loginSyncStatus()
    expect(status.shareQueue).toBe(true)
    expect(status.queueError).toBeNull()
    // (Other test files leave logins in this process's one store; they are not this test's business.)
    expect(status.lastError ?? '').not.toContain('queue')

    // This PC's snapshot is in the store, under its own id, without the prompt or the path.
    const rows = (await store('GET', '/v1/queues')).json.queues as Array<{ pc: string; meta: any }>
    const mine = rows.find((r) => r.pc !== other)!
    expect(mine.meta.name.length).toBeGreaterThan(0)
    const got = (await store('GET', `/v1/queues/${mine.pc}`)).json
    const snap = openQueue(syncKey, mine.pc, got.blob)!
    expect(snap.workers.map((w) => w.title)).toContain('my own task')
    expect(JSON.stringify(snap)).not.toContain('private prompt')
    expect(JSON.stringify(snap)).not.toContain('secret')

    // And it read the other PC's, never its own back.
    expect(remoteSnapshots().map((s) => s.pc)).toEqual([other])
    const answer = (await (await http.request('/api/corch/remote')).json()) as any
    expect(answer.enabled).toBe(true)
    expect(answer.pcs).toHaveLength(1)
    expect(answer.pcs[0]).toMatchObject({ pc: other, name: 'OTHER-PC', stale: false })
    expect(answer.pcs[0].workers[0].title).toBe('their task')
    // Their snapshot shares no build (an AgentHydra from before this field): it reads as behind. Ours does share one.
    expect(answer.pcs[0]).toMatchObject({ build: null, behind: true })
    expect(answer.pcs[0].behindNote).toContain('OTHER-PC runs an older AgentHydra')
    expect(snap.build?.version).toBeTruthy()
    // Nothing of theirs became a worker here (other test files share this process's workers).
    expect(workers.has(answer.pcs[0].workers[0].id)).toBe(false)
    expect(workers.has('w-mine')).toBe(true)

    // Sharing off: the answer is empty.
    setQueueSharing(false)
    const off = await (await http.request('/api/corch/remote')).json()
    expect(off).toEqual({ enabled: false, pcs: [] })
    disconnectLoginSync()
  })

  test('a Worker without the queue routes sets queueError and leaves the logins alone', async () => {
    clearRemote()
    resetQueueSync()
    // An older Worker: it knows the logins and answers 404 to everything else.
    const old = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/v1/logins'
          ? Response.json({ logins: [] })
          : Response.json({ error: 'not found' }, { status: 404 }),
    })
    try {
      const url = `http://127.0.0.1:${old.port}`
      expect((await configureLoginSync({ url, token })).ok).toBe(true)
      setQueueSharing(true)
      await runLoginSync()
      const res = await runLoginSync()
      expect(res.ok).toBe(true)
      const status = loginSyncStatus()
      expect(status.queueError).toContain('no queue routes yet')
      expect(status.lastError).toBeNull()
      expect(status.events.some((e) => e.note.includes('no queue routes yet'))).toBe(true)
    } finally {
      await old.stop(true)
      disconnectLoginSync()
    }
  })
})

describe('when this PC uploads', () => {
  test('a worker change at once, a live bucket change after the gate, else the heartbeat', async () => {
    resetQueueSync()
    const saved = new Map(liveByAccount)
    liveByAccount.clear()
    const puts: number[] = []
    const pc = randomUUID()
    const io = {
      key,
      pc,
      name: 'THIS-PC',
      call: async (method: string, path: string) => {
        if (method === 'PUT') puts.push(1)
        return path === '/v1/queues'
          ? { status: 200, json: { queues: [] } }
          : { status: 200, json: { version: 1 } }
      },
    }
    const reading = (sessionPct: number, at: number) =>
      liveByAccount.set('acct-q', {
        sessionPct,
        sessionResetsAt: null,
        weekPct: 3,
        weekResetsAt: null,
        overageAllowed: false,
        at,
      })
    try {
      let t = Date.now()
      reading(11, t)
      await syncQueue(io, t)
      expect(puts).toHaveLength(1)
      // 11 -> 13 (same bucket) and a newer `at`: nothing, even long after the live gate.
      t += LIVE_GATE_MS + 1
      reading(13, t)
      await syncQueue(io, t)
      expect(puts).toHaveLength(1)
      // 13 -> 16 crosses a bucket: held until the gate, which has passed since the last upload.
      reading(16, t)
      await syncQueue(io, t)
      expect(puts).toHaveLength(2)
      // Another bucket right after: waits for the gate.
      t += 60_000
      reading(21, t)
      await syncQueue(io, t)
      expect(puts).toHaveLength(2)
      t += LIVE_GATE_MS
      await syncQueue(io, t)
      expect(puts).toHaveLength(3)
      // A worker change goes at once, gate or not.
      workers.set('w-gate', {
        id: 'w-gate',
        group: 'g-gate',
        title: 'gate',
        status: 'queued',
        attempts: [],
        accountId: null,
        costUsd: 0,
        createdAt: t,
        updatedAt: t,
      } as any)
      t += 1000
      await syncQueue(io, t)
      expect(puts).toHaveLength(4)
      // Nothing changed: the heartbeat, not before.
      t += HEARTBEAT_MS - 1000
      await syncQueue(io, t)
      expect(puts).toHaveLength(4)
      t += 1000
      await syncQueue(io, t)
      expect(puts).toHaveLength(5)
    } finally {
      workers.delete('w-gate')
      liveByAccount.clear()
      for (const [k, v] of saved) liveByAccount.set(k, v)
      resetQueueSync()
    }
  })
  // Measured 2026-10-03: a few running workers made an upload every ~21 s (171 an hour) because their
  // lastActivity, cost and clocks moved on every tool call; each one moved the store's revision and
  // made the other PC download, and the sync pace never backed off.
  describe('a running worker whose activity and cost keep moving', () => {
    const t0 = 1_800_000_000_000
    const puts: number[] = []
    const pc = randomUUID()
    const io = {
      key,
      pc,
      name: 'THIS-PC',
      call: async (method: string, path: string) => {
        if (method === 'PUT') puts.push(1)
        return path === '/v1/queues'
          ? { status: 200, json: { queues: [] } }
          : { status: 200, json: { version: 1 } }
      },
    }
    const saved = new Map(liveByAccount)
    const run = (over: Record<string, unknown>) =>
      workers.set('w-busy', {
        id: 'w-busy',
        group: 'g-busy',
        title: 'busy',
        status: 'running',
        attempts: [
          {
            account: { id: 'acct-a', num: 7, name: 'a@example.com' },
            startedAt: t0,
            endedAt: null,
          },
        ],
        accountId: 'acct-a',
        lastActivity: 'Read a.ts',
        error: null,
        costUsd: 0.1,
        createdAt: t0,
        updatedAt: t0,
        ...over,
      } as any)
    const begin = () => {
      resetQueueSync()
      puts.length = 0
      liveByAccount.clear()
    }
    const end = () => {
      workers.delete('w-busy')
      for (const [k, v] of saved) liveByAccount.set(k, v)
      resetQueueSync()
    }

    test('goes up once a gate, is no news in between, and its current values ride the gated upload', async () => {
      begin()
      try {
        run({})
        expect(await syncQueue(io, t0)).toBe(true)
        expect(puts).toHaveLength(1)
        // A minute on: activity, cost and the clock moved, nothing else.
        run({ lastActivity: 'Edit b.ts', costUsd: 0.25, updatedAt: t0 + 60_000 })
        expect(await syncQueue(io, t0 + 60_000)).toBe(false)
        expect(puts).toHaveLength(1)
        // Past the gate it goes up, still no news, and carries the values of now.
        run({ lastActivity: 'Bash test', costUsd: 0.4, updatedAt: t0 + LIVE_GATE_MS })
        expect(await syncQueue(io, t0 + LIVE_GATE_MS)).toBe(false)
        expect(puts).toHaveLength(2)
      } finally {
        end()
      }
    })

    test('finishing goes up at once', async () => {
      begin()
      try {
        run({})
        await syncQueue(io, t0)
        run({ status: 'done', lastActivity: 'Edit b.ts', costUsd: 0.25, updatedAt: t0 + 60_000 })
        expect(await syncQueue(io, t0 + 60_000)).toBe(true)
        expect(puts).toHaveLength(2)
      } finally {
        end()
      }
    })
  })
})
