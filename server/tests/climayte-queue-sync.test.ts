// server/tests/climayte-queue-sync.test.ts — two PCs share their CliMayte queue through the login
// sync's store and do not step on each other.
//
// The contract (core/climayte-queue-sync.ts, climayte-remote.ts, cloud/login-sync-worker/worker.js):
// a queue snapshot opens only under its own PC's id; a snapshot over the store's cap loses its oldest
// finished workers and never an active one; what the other PC has running counts toward an account's
// cap here (a PC not seen lately, by snapshot or by its store polls, counts for nothing); an unchanged
// queue is never uploaded again just to look alive; a queue that cannot sync reports itself in
// `queueError` and leaves the logins' status alone. The store is the real Worker on bun:sqlite
// (login-sync-store.ts); the other PC is played by writing to it with the key from the pairing code;
// an older Worker (no queue routes) is a tiny stand-in server.

import { afterAll, describe, expect, test } from 'bun:test'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { MAX_PER_ACCOUNT, pickAccount } from '../src/climayte'
import { liveByAccount, workers } from '../src/climayte-core'
import {
  buildStatus,
  clearRemote,
  type QueueSnapshot,
  type RemoteSwarmJob,
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
  buildSnapshot,
  fitSnapshot,
  LIVE_GATE_MS,
  openQueue,
  QUEUE_SHAPE_GAP_MS,
  queueUploadPending,
  resetQueueSync,
  SWARM_WAIT_MS,
  sealQueue,
  syncQueue,
  warmOriginTitles,
  warmSwarmJobs,
} from '../src/core/climayte-queue-sync'
import { StoreMirror } from '../src/core/login-sync-mirror'
import { app } from '../src/http-app'
import '../src/routes/climayte'
import { base, store, token } from './login-sync-store'
import './no-chats'

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

  test('still opens a blob of the first format (gzip, JSON inside base64), which an old PC uploaded', () => {
    const pc = randomUUID()
    const snap = snapshot(pc, [rw({ title: 'from an old PC' })])
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`climayte-queue:${pc}`))
    const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(snap))), cipher.final()])
    const old = Buffer.from(
      JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }),
    ).toString('base64')
    expect(openQueue(key, pc, old)).toEqual(snap)
    // The new format is smaller than the old for the same snapshot, and an old reader's JSON parse of
    // it fails (it reports "does not open", it does not throw out of its pass).
    const fresh = sealQueue(key, snap)
    expect(fresh.length).toBeLessThan(old.length)
    expect(() => JSON.parse(Buffer.from(fresh, 'base64').toString('utf8'))).toThrow()
  })

  test('carries the sender’s build through the seal, and an old snapshot without one still opens', () => {
    const pc = randomUUID()
    const build = { version: '1.2.3', commit: 'abc1234', date: '2026-10-02T18:40:00.000Z' }
    expect(openQueue(key, pc, sealQueue(key, { ...snapshot(pc, []), build }))?.build).toEqual(build)
    expect(openQueue(key, pc, sealQueue(key, snapshot(pc, [])))?.build).toBeUndefined()
  })

  test('carries this PC’s HSwarm jobs with only the allowed fields, and an unreachable HSwarm still snapshots the workers', async () => {
    resetQueueSync()
    workers.set('w-swarm-ok', {
      id: 'w-swarm-ok',
      group: 'g-s',
      title: 'a task',
      status: 'running',
      attempts: [],
      createdAt: 1,
      updatedAt: Date.now(),
    } as any)
    const row = (over: Record<string, unknown>) => ({
      job_id: 'j-1',
      label: 'example-job',
      state: 'running',
      tasks: 3,
      counts: { ok: 1, pending: 2, running: 0 },
      created: '2026-10-05T10:00:00+00:00',
      finished: null,
      cost_usd: 0.5,
      dir: 'C:/secret/jobs/j-1',
      cwd: 'C:/secret/cwd',
      prompt: 'the private prompt',
      caller: 'secret-folder:claude:abc',
      caller_ids: {
        session_id: '11111111-2222-3333-4444-555555555555',
        chat_id: 'c-1',
        instance: 'i-1',
        folder: 'Example-repo',
      },
      ...over,
    })
    try {
      await warmSwarmJobs(async () => [
        row({}),
        row({
          job_id: 'j-2',
          state: 'done',
          counts: { ok: 3 },
          finished: '2026-10-05T10:05:00+00:00',
          caller_ids: undefined,
        }),
      ])
      const snap = buildSnapshot(randomUUID(), 'T')
      expect(snap.jobs).toEqual([
        {
          id: 'j-1',
          label: 'example-job',
          state: 'running',
          tasks: 3,
          counts: { ok: 1 },
          created: '2026-10-05T10:00:00+00:00',
          finished: null,
          callerSessionId: '11111111-2222-3333-4444-555555555555',
          callerChatId: 'c-1',
          folder: 'Example-repo',
        },
        {
          id: 'j-2',
          label: 'example-job',
          state: 'done',
          tasks: 3,
          counts: { ok: 3 },
          created: '2026-10-05T10:00:00+00:00',
          finished: '2026-10-05T10:05:00+00:00',
          callerSessionId: null,
          callerChatId: null,
          folder: null,
        },
      ])
      expect(JSON.stringify(snap.jobs)).not.toContain('secret')
      expect(JSON.stringify(snap.jobs)).not.toContain('private prompt')

      // Many finished jobs: every running one stays, only the 20 newest finished do.
      await warmSwarmJobs(async () => [
        row({}),
        ...Array.from({ length: 30 }, (_, i) =>
          row({
            job_id: `j-f${i}`,
            state: 'done',
            finished: `2026-10-05T11:${String(i).padStart(2, '0')}:00+00:00`,
          }),
        ),
      ])
      const capped = buildSnapshot(randomUUID(), 'T').jobs!
      expect(capped).toHaveLength(21)
      expect(capped[0].id).toBe('j-1')
      expect(capped[1].id).toBe('j-f29')

      // HSwarm down, then HSwarm that never answers: no jobs, the workers' snapshot still builds.
      await warmSwarmJobs(async () => {
        throw new Error('connection refused')
      })
      expect(buildSnapshot(randomUUID(), 'T').jobs).toEqual([])
      const t0 = Date.now()
      await warmSwarmJobs(() => new Promise(() => {}))
      expect(Date.now() - t0).toBeLessThan(SWARM_WAIT_MS + 1_500)
      const down = buildSnapshot(randomUUID(), 'T')
      expect(down.jobs).toEqual([])
      expect(down.workers.map((w) => w.id)).toContain('w-swarm-ok')
    } finally {
      workers.delete('w-swarm-ok')
      resetQueueSync()
    }
    // It waits SWARM_WAIT_MS on purpose (the HSwarm that never answers); 2026-10-06's full gate under
    // load ran it past bun's 5 s default. The bound that matters is the assertion above.
  }, 15_000)

  test('a snapshot with jobs opens with them, and one from an older PC without jobs still opens', () => {
    const pc = randomUUID()
    const job: RemoteSwarmJob = {
      id: 'j-1',
      label: 'example-job',
      state: 'done',
      tasks: 2,
      counts: { ok: 2 },
      created: '2026-10-05T10:00:00+00:00',
      finished: '2026-10-05T10:05:00+00:00',
      callerSessionId: null,
      callerChatId: null,
    }
    const snap = { ...snapshot(pc, []), jobs: [job] }
    expect(openQueue(key, pc, sealQueue(key, snap))?.jobs).toEqual([job])
    expect(openQueue(key, pc, sealQueue(key, snapshot(pc, [])))?.jobs).toBeUndefined()
  })

  test('a chat-dispatched worker carries the chat’s title, its earlier sessions and its folder’s last name, never a path', async () => {
    resetQueueSync()
    const base = {
      cwd: 'C:\\secret\\Example-repo\\',
      prompt: 'the private prompt',
      pending: [],
      model: null,
      effort: null,
      accounts: null,
      status: 'running',
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
      createdAt: 1,
      updatedAt: 2,
    }
    workers.set('w-titled', {
      ...base,
      id: 'w-titled',
      group: 'g-t',
      title: 'a task',
      sessionId: 's-now',
      sessions: ['s-old-1', 's-old-2'],
      origin: {
        kind: 'chat',
        sessionId: 's-chat-title',
        home: 'C:/secret/home',
        transcript: 'C:/secret/home/t.jsonl',
        how: 'binding',
      },
    } as any)
    workers.set('w-by-worker', {
      ...base,
      id: 'w-by-worker',
      group: 'g-t',
      title: 'its task',
      origin: { kind: 'worker', workerId: 'w-titled' },
    } as any)
    try {
      const find = (id: string) =>
        buildSnapshot(randomUUID(), 'T').workers.find((w) => w.id === id)!
      // Before any lookup the title is unknown, not missing.
      expect(find('w-titled')).toMatchObject({
        originTitle: null,
        sessions: ['s-old-1', 's-old-2'],
      })
      await warmOriginTitles(1_000, async (id) =>
        id === 's-chat-title' ? `  Example chat  ` : null,
      )
      const snap = buildSnapshot(randomUUID(), 'T')
      expect(snap.workers.find((w) => w.id === 'w-titled')).toMatchObject({
        originSessionId: 's-chat-title',
        originTitle: 'Example chat',
        sessions: ['s-old-1', 's-old-2'],
        folder: 'Example-repo',
      })
      expect(find('w-by-worker')).toMatchObject({ originTitle: null, sessions: [] })
      expect(JSON.stringify(snap)).not.toContain('secret')
    } finally {
      workers.delete('w-titled')
      workers.delete('w-by-worker')
      resetQueueSync()
    }
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
    expect(s.behindNote).toContain('Update it there in Settings')
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

  test('an old snapshot of a PC the store saw polling still holds the account', async () => {
    clearRemote()
    resetQueueSync()
    const full = Array.from({ length: MAX_PER_ACCOUNT }, () => rw({ status: 'running' }))
    const other = randomUUID()
    const mine = randomUUID()
    // its queue went up 41 minutes ago and has not changed since, so it was not uploaded again
    setRemote(snapshot(other, full, Date.now() - 41 * 60_000), 3)
    const sentPc: Array<string | undefined> = []
    const mirror = new StoreMirror(async (_method, path, headers) => {
      if (path === '/v1/queues')
        return { status: 200, json: { queues: [{ pc: other, version: 3, meta: {} }] }, rev: 5 }
      sentPc.push(headers?.['x-agenthydra-pc'])
      return { status: 304, json: null, seen: { [other]: Date.now() - 60_000 } }
    })
    mirror.pc = mine
    await mirror.refresh({ tables: ['queues'] }) // the first pass: the list
    await mirror.refresh({ tables: ['queues'] }) // the next: a changes poll, answered 304 with x-seen
    expect(sentPc).toEqual([mine])
    const call = async () => ({ status: 200, json: { version: 1 } })
    await syncQueue({ key, pc: mine, name: 'THIS-PC', call, mirror })
    expect(remoteSnapshots().map((s) => [s.pc, s.stale])).toEqual([[other, false]])
    expect(place()).toBeNull()
    clearRemote()
    resetQueueSync()
  })
})

describe('a pass through the store', () => {
  afterAll(() => {
    disconnectLoginSync()
    clearRemote()
    workers.delete('w-mine')
    workers.delete('w-mine-kid')
  })

  // Each runs two full login-sync passes (logins, desktop logins, queue), like cli-login-sync.test.ts:
  // on a busy PC that takes more than the default 5 s.
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
      sessionId: 's-mine',
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
      // Dispatched by a chat: its origin also names that chat's Claude home and transcript.
      origin: {
        kind: 'chat',
        sessionId: 's-chat',
        home: 'C:/secret/home',
        transcript: 'C:/secret/home/t.jsonl',
        how: 'binding',
      },
      wave: 'wv-mine',
    } as any)
    // A task the first one dispatched.
    workers.set('w-mine-kid', {
      ...workers.get('w-mine')!,
      id: 'w-mine-kid',
      title: 'its task',
      sessionId: 's-kid',
      origin: { kind: 'worker', workerId: 'w-mine' },
      wave: null,
    })
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
    const theirJob: RemoteSwarmJob = {
      id: 'j-their-1',
      label: 'example-job',
      state: 'running',
      tasks: 4,
      counts: { ok: 1 },
      created: '2026-10-05T10:00:00+00:00',
      finished: null,
      callerSessionId: '11111111-2222-3333-4444-555555555555',
      callerChatId: null,
    }
    const theirs = {
      ...snapshot(other, [rw({ title: 'their task', status: 'running' })]),
      jobs: [theirJob],
    }
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

    // This PC's snapshot is in the store, under its own id, without the prompt or any path (the
    // folder, the origin chat's home and transcript).
    const rows = (await store('GET', '/v1/queues')).json.queues as Array<{ pc: string; meta: any }>
    const mine = rows.find((r) => r.pc !== other)!
    expect(mine.meta.name.length).toBeGreaterThan(0)
    const got = (await store('GET', `/v1/queues/${mine.pc}`)).json
    const snap = openQueue(syncKey, mine.pc, got.blob)!
    expect(snap.workers.map((w) => w.title)).toContain('my own task')
    expect(JSON.stringify(snap)).not.toContain('private prompt')
    expect(JSON.stringify(snap)).not.toContain('secret')
    // Who dispatched each, by id alone: the other PC's Hydra Desk draws it under that chat or worker.
    const shared = (id: string) => snap.workers.find((w) => w.id === id)
    expect(shared('w-mine')).toMatchObject({
      sessionId: 's-mine',
      originSessionId: 's-chat',
      originWorkerId: null,
      wave: 'wv-mine',
    })
    expect(shared('w-mine-kid')).toMatchObject({
      sessionId: 's-kid',
      originSessionId: 's-mine',
      originWorkerId: 'w-mine',
      wave: null,
    })

    // And it read the other PC's, never its own back.
    expect(remoteSnapshots().map((s) => s.pc)).toEqual([other])
    const answer = (await (await http.request('/api/corch/remote')).json()) as any
    expect(answer.enabled).toBe(true)
    expect(answer.pcs).toHaveLength(1)
    expect(answer.pcs[0]).toMatchObject({ pc: other, name: 'OTHER-PC', stale: false })
    expect(answer.pcs[0].workers[0].title).toBe('their task')
    expect(answer.pcs[0].jobs).toEqual([theirJob])
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
  }, 20_000)

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
  }, 20_000)
})

describe('downloading the other PC’s queue', () => {
  test('goes through the mirror: one GET per remote version, none when the same version is read again', async () => {
    clearRemote()
    resetQueueSync()
    const other = randomUUID()
    let version = 1
    let blob = sealQueue(key, snapshot(other, [rw({ title: 'their task' })]))
    let gets = 0
    const call = async (_method: string, path: string) => {
      if (path === '/v1/queues')
        return { status: 200, json: { queues: [{ pc: other, version, updatedAt: version }] } }
      if (path === `/v1/queues/${other}`) {
        gets++
        return { status: 200, json: { pc: other, version, blob, updatedAt: version } }
      }
      return { status: 200, json: { version: 1 } }
    }
    const mirror = new StoreMirror(call)
    const io = { mirror, call, key, pc: randomUUID(), name: 'THIS-PC' }
    const pass = async () => {
      await mirror.refresh({ tables: ['queues'], full: true })
      await syncQueue(io)
    }
    try {
      await pass()
      expect(gets).toBe(1)
      expect(remoteSnapshots()[0].workers[0].title).toBe('their task')
      // Remembered remote state gone (as when the other PC's snapshot is dropped): the version is read
      // again, and the mirror answers it without asking the store.
      clearRemote()
      await pass()
      expect(gets).toBe(1)
      expect(remoteSnapshots()).toHaveLength(1)
      // A new version costs exactly one more GET.
      version = 2
      blob = sealQueue(key, snapshot(other, [rw({ title: 'their next task' })]))
      await pass()
      expect(gets).toBe(2)
      expect(remoteSnapshots()[0].workers[0].title).toBe('their next task')
    } finally {
      clearRemote()
      resetQueueSync()
    }
  })
})

describe('when this PC uploads', () => {
  test('a worker change at once, a live bucket change after the gate, an unchanged queue never', async () => {
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
      // A worker change right after an upload waits for the shape gap, then goes up (below).
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
      expect(puts).toHaveLength(3)
      t += QUEUE_SHAPE_GAP_MS
      await syncQueue(io, t)
      expect(puts).toHaveLength(4)
      // Nothing changed: no upload, however long (the 15-minute heartbeat is gone).
      t += 16 * 60_000
      await syncQueue(io, t)
      t += 60 * 60_000
      await syncQueue(io, t)
      expect(puts).toHaveLength(4)
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

    // Measured 2026-10-03: the list is newest-updated first, so two running workers swapping places
    // changed the fingerprints with no worker's content changing: an upload at once, and news.
    test('two workers swapping places in the list is no news and waits for the gate', async () => {
      begin()
      const two = (a: number, b: number) => {
        for (const [id, at] of [
          ['w-busy', a],
          ['w-busy2', b],
        ] as const)
          workers.set(id, {
            id,
            group: `g-${id}`,
            title: id,
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
            updatedAt: at,
          } as any)
      }
      try {
        two(t0 + 10, t0 + 20)
        expect(await syncQueue(io, t0)).toBe(true)
        expect(puts).toHaveLength(1)
        // Only the update order swapped (the timestamps are the volatile part).
        two(t0 + 40, t0 + 30)
        expect(await syncQueue(io, t0 + 30_000)).toBe(false)
        two(t0 + 50, t0 + 60)
        expect(await syncQueue(io, t0 + 31_000)).toBe(false)
        expect(puts).toHaveLength(1)
      } finally {
        workers.delete('w-busy2')
        end()
      }
    })

    test('finishing goes up at once after a quiet spell, and inside the shape gap waits for it', async () => {
      begin()
      try {
        run({})
        await syncQueue(io, t0)
        run({ status: 'done', lastActivity: 'Edit b.ts', costUsd: 0.25, updatedAt: t0 + 60_000 })
        expect(await syncQueue(io, t0 + 60_000)).toBe(false)
        expect(queueUploadPending(pc, t0 + 60_000)).toBe(false)
        expect(puts).toHaveLength(1)
        expect(queueUploadPending(pc, t0 + QUEUE_SHAPE_GAP_MS)).toBe(true)
        expect(await syncQueue(io, t0 + QUEUE_SHAPE_GAP_MS)).toBe(true)
        expect(puts).toHaveLength(2)
      } finally {
        end()
      }
    })
  })
})
