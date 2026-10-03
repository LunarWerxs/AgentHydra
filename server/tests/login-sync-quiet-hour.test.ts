// server/tests/login-sync-quiet-hour.test.ts — what the login sync store reads in an hour when nothing
// changes, with BOTH PCs polling it: this PC (the changes feed through one StoreMirror) and a PC that
// still runs the older client (it lists the whole logins and queues tables every 30 s, which cannot be
// changed until it updates). D1 bills the rows a statement looks at; the owner's budget is about 1,400
// a day, about 60 an hour. The store is the real Worker on bun:sqlite with D1's row counting
// (login-sync-store.ts); the clock is faked so an hour runs in a second.
//
// Measured on the live store, 2026-10-03 10:00-10:50Z: about 7,100 rows an hour (170,000 a day), of
// which a chat pass fetched 10 unchanged "diverged" chats every 30 s (1,222 rows), the Worker read
// chat_usage and MAX(seq) for chunk uploads that were refused as already stored (1,644), every
// unchanged list cost a 3-row check (1,323), and the same few logins were downloaded again and
// again (539).

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveByAccount, workers } from '../src/climayte-core'
import {
  clearRemote,
  type QueueSnapshot,
  remoteSnapshots,
  remoteVersion,
  setRemote,
} from '../src/climayte-remote'
import { localWorkPending } from '../src/core/cli-login-sync'
import { LIVE_GATE_MS, resetQueueSync, sealQueue, syncQueue } from '../src/core/climayte-queue-sync'
import { syncChats } from '../src/core/desktop-chat-sync'
import type { ChatIo, ChatLocal, LocalChat } from '../src/core/desktop-chat-types'
import { StoreMirror } from '../src/core/login-sync-mirror'
import { IDLE_MAX_MS, SyncPace } from '../src/core/login-sync-pace'
import {
  base,
  dropQueue,
  env,
  freshIsolate,
  type StatementStat,
  store,
  storeDb,
  token,
} from './login-sync-store'

const key = randomBytes(32)
const HOUR = 3_600_000
const TICK = 30_000 // SYNC_EVERY_MS: both PCs poll twice a minute
const dirs: string[] = []
const realNow = Date.now
let clock = realNow()

const made = { logins: [] as string[], chats: [] as string[], queues: [] as string[] }

beforeAll(() => {
  Date.now = () => clock
})
afterAll(async () => {
  Date.now = realNow
  for (const id of made.logins) await store('DELETE', `/v1/logins/${id}?version=1`)
  for (const r of (await store('GET', '/v1/chats')).json.chats)
    if (made.chats.includes(r.id)) await store('DELETE', `/v1/chats/${r.id}?version=${r.version}`)
  for (const pc of made.queues) await dropQueue(pc)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A PC's chats: a fake ChatLocal over a temp folder, with its own state file. */
function pcChats(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-hour-'))
  dirs.push(dir)
  const chats: LocalChat[] = []
  const file = (project: string, sessionId: string) => join(dir, project, `${sessionId}.jsonl`)
  const size = (project: string, sessionId: string) => {
    try {
      return statSync(file(project, sessionId)).size
    } catch {
      return 0
    }
  }
  const local: ChatLocal = {
    list: () => chats.map((c) => ({ ...c, size: c.project ? size(c.project, c.sessionId) : 0 })),
    read: (project, sessionId, from, to) =>
      new Uint8Array(readFileSync(file(project, sessionId)).subarray(from, to)),
    size,
    append(project, sessionId, expected, bytes) {
      if (size(project, sessionId) !== expected) return false
      mkdirSync(join(dir, project), { recursive: true })
      const old = size(project, sessionId)
        ? readFileSync(file(project, sessionId))
        : Buffer.alloc(0)
      writeFileSync(file(project, sessionId), Buffer.concat([old, bytes]))
      return true
    },
    async land(chat) {
      chats.push({ ...chat, size: 0 })
      return { ok: true }
    },
  }
  const id = randomUUID()
  made.queues.push(id)
  const io: ChatIo = {
    call: store,
    key,
    pc: id,
    name,
    local,
    statePath: join(dir, 'state.json'),
  }
  return {
    io,
    chats,
    add(text: string, sessionId = randomUUID()) {
      const c: LocalChat = {
        id: randomUUID(),
        sessionId,
        project: 'proj',
        account: randomUUID(),
        org: randomUUID(),
        record: { title: 'A chat' },
        archived: false,
        size: 0,
      }
      mkdirSync(join(dir, 'proj'), { recursive: true })
      writeFileSync(file('proj', c.sessionId), text)
      chats.push(c)
      made.chats.push(c.id)
      return c
    },
    extend(c: LocalChat, more: string) {
      writeFileSync(file('proj', c.sessionId), readFileSync(file('proj', c.sessionId)) + more)
    },
  }
}

const table = (stats: StatementStat[]) =>
  stats
    .map(
      (s) =>
        `${String(s.rows).padStart(6)} rows / ${String(s.calls).padStart(5)} calls  ${s.sql.slice(0, 100)}`,
    )
    .join('\n')
const reads = (stats: StatementStat[]) =>
  stats.filter((s) => !s.write).reduce((n, s) => n + s.rows, 0)

type Hour = { stats: StatementStat[]; reads: number }

/** The sim: a store holding 55 logins and 18 chats (10 of them continued on both PCs, so `diverged`
 *  on this one, the live store's shape), and one hour of both PCs polling it. `busy` adds the changes a
 *  working hour brings: another PC refreshing a login a few times, a queue that changes, a chat that
 *  keeps growing. */
/** The store as another test file left it may hold rows sealed under another key; this hour starts
 *  with no queues and no chats of anyone else's. */
async function sweep() {
  for (const q of (await store('GET', '/v1/queues')).json.queues) await dropQueue(q.pc)
  for (const c of (await store('GET', '/v1/chats')).json.chats)
    await store('DELETE', `/v1/chats/${c.id}?version=${c.version}`)
}

async function runHour(busy: boolean, beats: boolean): Promise<Hour> {
  resetQueueSync()
  await sweep()
  clock = realNow()
  const logins: string[] = []
  for (let i = 0; i < 55; i++) {
    const id = randomUUID()
    await store('PUT', `/v1/logins/${id}`, { version: 0, blob: 'b', meta: { num: i } })
    logins.push(id)
    made.logins.push(id)
  }
  const oList = new Map<string, number>(logins.map((id) => [id, 1]))
  const busyLogins = new Set<string>()
  const stuck = logins.slice(0, 4) // logins a PC downloads and cannot land yet (a session runs on them)

  // This PC (N): 8 chats shared with the other side, 10 continued on both and so diverged.
  const n = pcChats('PC-N')
  const other = pcChats('PC-X')
  const forked: Array<{ n: LocalChat; x: LocalChat }> = []
  for (let i = 0; i < 18; i++) n.add(`{"n":${i}}\n`)
  // Six chats here share a session with a record the other side shares, and differ from it: this PC
  // cannot take that record (diverged) and its own record's first chunk is already stored.
  for (let i = 0; i < 6; i++) {
    const twin = other.add(`{"x":${i}}
`)
    n.add(
      `{"mine":${i}}
`,
      twin.sessionId as ReturnType<typeof randomUUID>,
    )
  }
  await syncChats(other.io, clock)
  await syncChats(n.io, clock)
  await syncChats(other.io, clock)
  for (const c of n.chats.slice(0, 10))
    forked.push({ n: c, x: other.chats.find((o) => o.id === c.id) as LocalChat })
  for (const f of forked) {
    n.extend(f.n, '{"on":"n"}\n')
    other.extend(f.x, '{"on":"x"}\n')
  }
  clock += CHAT_PUSH
  await syncChats(other.io, clock)
  const frozen = clock // a PC that does not heartbeat sees the clock stand still
  const mirror = new StoreMirror((m, p) => store(m, p) as never)
  const nIo = (): ChatIo => ({ ...n.io, mirror })
  const pass = async () => {
    await mirror.refresh({ tables: ['logins', 'queues', 'chats'] })
    await syncChats(nIo(), clock)
  }
  await pass() // N meets the forked chats: diverged
  clock += TICK
  await pass()

  // The other PC (O, the old client): lists the logins and queues tables every 30 s, heartbeats its
  // queue every 60 s, downloads a queue when its version moved.
  const oPc = randomUUID()
  made.queues.push(oPc)
  let oVersion = 0
  let oSeenN = 0
  const oBeat = async () => {
    const r = await store('PUT', `/v1/queues/${oPc}`, {
      version: oVersion,
      blob: sealQueue(key, { pc: oPc, name: 'PC-O', at: clock, workers: [], live: {} }),
      meta: { name: 'PC-O', at: clock },
    })
    if (r.status === 200) oVersion = r.json.version
  }
  await oBeat()

  storeDb.resetRowsRead()
  const start = clock
  let tick = 0
  const pcN = n.io.pc
  while (clock - start < HOUR) {
    clock += TICK
    tick++
    // ---- PC O, older client
    const list = await store('GET', '/v1/logins')
    expect(list.status).toBe(200)
    const queues = await store('GET', '/v1/queues')
    for (const q of queues.json.queues)
      if (q.pc === pcN && q.version !== oSeenN) {
        oSeenN = q.version
        await store('GET', `/v1/queues/${pcN}`)
      }
    for (const id of stuck) await store('GET', `/v1/logins/${id}`)
    if (beats && tick % 2 === 0) await oBeat()
    // ---- PC N, this client
    if (busy && tick % 11 === 0) {
      // the other PC refreshes a login; this PC downloads it once, when its list shows the new version
      const id = logins[10 + ((tick / 11) % 40)]
      const put = await store('PUT', `/v1/logins/${id}`, {
        version: oList.get(id) ?? 1,
        blob: 'again',
        meta: { num: 1 },
      })
      if (put.status === 200) oList.set(id, put.json.version)
      busyLogins.add(id)
    }
    // a chat being worked in: it is re-sent every 5 minutes, not every poll
    if (busy) n.extend(n.chats[10], '{"more":true}\n')
    await pass()
    await syncQueue({ call: store, mirror, key, pc: pcN, name: 'PC-N' }, beats ? clock : frozen)
    for (const id of [...stuck, ...busyLogins]) await mirror.getItem('logins', id)
  }
  const stats = storeDb.statements()
  return { stats, reads: reads(stats) }
}
const CHAT_PUSH = 5 * 60_000

const report = (label: string, hour: Hour) =>
  console.log(`${label}: ${hour.reads} rows read in the hour (${hour.reads * 24} a day)
${table(hour.stats)}`)

// With nothing changing, a poll costs the Worker's head row once its trust window is up, not a row per
// stored login, chat or queue: about 60 an hour, 1,400 a day.
test('a quiet hour of both PCs, no heartbeats, reads about 60 rows', async () => {
  const hour = await runHour(false, false)
  report('quiet hour, no heartbeats', hour)
  expect(hour.reads).toBeLessThanOrEqual(65) // measured 61: the head every 90 s, six refused first chunks an hour, start-up reads
})

// The older client still writes its queue every 60 s, and this PC's heartbeat is 60 s too: each write
// moves the store, so each PC reads the head, the changed queue row and the queue itself after it.
// That is the floor until the older client updates or heartbeats less often.
test('a quiet hour with both PCs heartbeating reads a few hundred rows', async () => {
  const hour = await runHour(false, true)
  report('quiet hour, heartbeats every 60 s', hour)
  expect(hour.reads).toBeLessThanOrEqual(420)
})

const writes = (stats: StatementStat[]) =>
  stats.filter((s) => s.write).reduce((n, s) => n + s.rows, 0)

// Measured 2026-10-03, two PCs idle: the queue was uploaded ~231 times an hour because each account's
// usage reading (every few minutes, `at` inside the fingerprint) changed it, plus a 60 s heartbeat; each
// upload cost writes, a store_rev bump, a changes read and the other PC downloading the blob. Both PCs
// here run the real syncQueue: six accounts' readings refresh every 3 minutes (staggered) and move 1-3
// points inside their 5-point bucket, no worker changes.
test('a quiet hour of two CliMayte PCs with usage readings refreshing stays a handful of rows', async () => {
  resetQueueSync()
  await sweep()
  const savedLive = new Map(liveByAccount)
  liveByAccount.clear()
  clock = realNow()
  const pcs = [randomUUID(), randomUUID()].map((pc, i) => {
    made.queues.push(pc)
    return {
      io: {
        call: store,
        mirror: new StoreMirror((m, p) => store(m, p) as never),
        key,
        pc,
        name: `PC-${i}`,
      },
    }
  })
  const accounts = Array.from({ length: 6 }, (_, i) => `acct-${i}`)
  const reading = (i: number, n: number) => {
    const p = 11 + 5 * i // 11, 16, ... : +0..3 stays in the same 5-point bucket
    liveByAccount.set(accounts[i], {
      sessionPct: p + (n % 4),
      sessionResetsAt: null,
      weekPct: p + ((n + 1) % 3),
      weekResetsAt: null,
      overageAllowed: false,
      at: clock,
    })
  }
  try {
    // Both PCs run in this process, so they upload the same queue under their own ids.
    for (const [i] of accounts.entries()) reading(i, 0)
    for (const p of pcs) await syncQueue(p.io, clock)
    storeDb.resetRowsRead()
    const start = clock
    let tick = 0
    while (clock - start < HOUR) {
      clock += TICK
      tick++
      // an account's reading is refreshed every 6 ticks (3 minutes), one account per tick
      if (tick % 6 < accounts.length) reading(tick % 6, tick)
      for (const p of pcs) await syncQueue(p.io, clock)
    }
    const stats = storeDb.statements()
    console.log(
      `two CliMayte PCs, usage refreshing: ${reads(stats)} rows read, ${writes(stats)} rows written in the hour\n${table(stats)}`,
    )
    expect(reads(stats)).toBeLessThanOrEqual(90) // measured 68: the head every 30 s, 4 heartbeats each
    expect(writes(stats)).toBeLessThanOrEqual(20) // measured 16: 8 uploads (2 PCs x 4 heartbeats)
  } finally {
    liveByAccount.clear()
    for (const [k, v] of savedLive) liveByAccount.set(k, v)
  }
})

// Measured 2026-10-03 19:00-20:00Z: 171 queue uploads an hour (one per ~21 s) with a few CliMayte workers
// running, because their lastActivity, cost and clocks changed on every pass and each change uploaded
// at once. Now only the gate (LIVE_GATE_MS) lets them up: one PC, two running workers whose activity
// and cost change on every 30 s pass.
test('an hour with two running workers whose activity changes every pass uploads about once per gate', async () => {
  resetQueueSync()
  await sweep()
  const savedLive = new Map(liveByAccount)
  const savedWorkers = new Map(workers)
  liveByAccount.clear()
  workers.clear()
  clock = realNow()
  const pc = randomUUID()
  made.queues.push(pc)
  let puts = 0
  const io = {
    call: (method: string, path: string, body?: unknown) => {
      if (method === 'PUT' && path === `/v1/queues/${pc}`) puts++
      return store(method, path, body)
    },
    mirror: new StoreMirror((m, p) => store(m, p) as never),
    key,
    pc,
    name: 'PC-W',
  }
  const t0 = clock
  const touch = (n: number) => {
    for (const id of ['w-a', 'w-b'])
      workers.set(id, {
        id,
        group: 'g-q',
        title: id,
        status: 'running',
        attempts: [{ account: { id: 'acct-a', num: 7, name: 'a' }, startedAt: t0, endedAt: null }],
        accountId: 'acct-a',
        lastActivity: `tool call ${n}`,
        error: null,
        costUsd: n / 100,
        createdAt: t0,
        updatedAt: clock,
      } as any)
  }
  try {
    touch(0)
    await syncQueue(io, clock)
    const first = puts
    storeDb.resetRowsRead()
    let tick = 0
    while (clock - t0 < HOUR) {
      clock += TICK
      touch(++tick)
      await syncQueue(io, clock)
    }
    const stats = storeDb.statements()
    const uploads = puts - first
    console.log(
      `two running workers, activity changing every pass: ${uploads} uploads, ${reads(stats)} rows read in the hour`,
    )
    // the 10-minute gate: 6 an hour (the 15-minute heartbeat never comes first), plus one for the hour's edge
    expect(uploads).toBeLessThanOrEqual(Math.ceil(HOUR / LIVE_GATE_MS) + 1)
    expect(uploads).toBeGreaterThanOrEqual(1)
  } finally {
    workers.clear()
    for (const [k, v] of savedWorkers) workers.set(k, v)
    liveByAccount.clear()
    for (const [k, v] of savedLive) liveByAccount.set(k, v)
  }
})

test('a busy hour: logins refreshed, a chat growing, both PCs heartbeating', async () => {
  const hour = await runHour(true, true)
  report('busy hour', hour)
  expect(hour.reads).toBeLessThanOrEqual(900)
})

// THE ADAPTIVE POLL (owner, 2026-10-03: ~2,300 rows an hour with both PCs idle). The Worker is on
// *.workers.dev, where the Cache API is a no-op and free-plan isolates are short-lived, so every pass
// reads the one-row head from D1: modelled here with HEAD_CACHE_S=0 and a fresh isolate per request.
// Both PCs run the real syncQueue and the real SyncPace: a pass only when one is due, and a quiet
// pass (nothing moved) doubles the wait from 30 s up to IDLE_MAX_MS.
/** The store call the daemon makes (cli-login-sync.ts `call`): the reply with its x-store-rev, which
 *  is what lets the mirror use the changes feed instead of listing the tables. */
const storeWithRev = async (method: string, path: string) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  const h = res.headers.get('x-store-rev')
  return { status: res.status, json: await res.json(), rev: h !== null ? Number(h) : undefined }
}

function pacedPc(i: number) {
  const pc = randomUUID()
  made.queues.push(pc)
  return {
    io: {
      call: store,
      mirror: new StoreMirror(storeWithRev),
      key,
      pc,
      name: `PC-${i}`,
    },
    pace: new SyncPace(),
    passes: 0,
    remote: [] as Array<[QueueSnapshot, number]>,
  }
}
type PacedPc = ReturnType<typeof pacedPc>

/** One tick of a PC's loop (cli-login-sync.ts startLoginSync): a pass when one is due. Returns whether
 *  this tick uploaded this PC's queue. */
async function tickPc(p: PacedPc, now: number, local = false): Promise<boolean> {
  if (local && localWorkPending()) p.pace.nudge()
  if (!p.pace.due(now)) return false
  p.passes++ // a free-plan isolate that never saw the head
  freshIsolate() // a free-plan isolate that never saw the head
  const before = p.io.mirror.changesIn(['logins', 'chats'])
  await p.io.mirror.refresh({ tables: ['logins', 'queues'] })
  // Both PCs share this process's remote-queue map, which one PC per process never does: each keeps
  // its own copy of what it downloaded.
  clearRemote()
  for (const [snap, v] of p.remote) setRemote(snap, v)
  const moved = await syncQueue(p.io, now)
  p.remote = remoteSnapshots().map((s) => [s, remoteVersion(s.pc) ?? 0])
  p.pace.afterPass(!moved && p.io.mirror.changesIn(['logins', 'chats']) === before, now)
  return moved
}

async function pacedHour(paced: boolean) {
  resetQueueSync()
  await sweep()
  clock = realNow()
  for (let i = 0; i < 55; i++) {
    const id = randomUUID()
    await store('PUT', `/v1/logins/${id}`, { version: 0, blob: 'b', meta: { num: i } })
    made.logins.push(id)
  }
  env.HEAD_CACHE_S = '0'
  const pcs = [pacedPc(0), pacedPc(1)]
  try {
    for (const p of pcs) await tickPc(p, clock) // start-up reads: the full lists, once
    storeDb.resetRowsRead()
    const start = clock
    while (clock - start < HOUR) {
      clock += TICK
      for (const p of pcs) {
        if (!paced) p.pace.nudge() // the old loop: a pass on every tick
        await tickPc(p, clock)
      }
    }
    return { reads: reads(storeDb.statements()), passes: pcs.map((p) => p.passes) }
  } finally {
    delete env.HEAD_CACHE_S
  }
}

// Measured (uncached Worker, two idle PCs): polling every 30 s read 272 rows an hour (120 passes each,
// the head every time, plus the heartbeats); with the backoff each PC makes 16-17 passes and the hour
// reads 59 rows: about 34 for the head, the rest the heartbeats (a PC's every-15-minute upload moves the
// store, so the other reads the change and the queue once). Ceiling 75 leaves room for the heartbeat
// landing a pass later; 1,400 a day is 58 an hour.
test('a quiet hour of two PCs on an uncached Worker polls adaptively and reads about 60 rows', async () => {
  const fixed = await pacedHour(false)
  const hour = await pacedHour(true)
  console.log(
    `uncached Worker, quiet hour: fixed 30 s ${fixed.reads} rows (passes ${fixed.passes}); backoff ${hour.reads} rows (passes ${hour.passes})`,
  )
  expect(hour.reads).toBeLessThanOrEqual(75)
  expect(hour.reads).toBeLessThan(fixed.reads / 3)
  for (const n of hour.passes) expect(n).toBeLessThanOrEqual(20) // not 120
  expect(IDLE_MAX_MS).toBeLessThan(15 * 60_000) // the queue heartbeat still goes up in time
})

test('a worker queued mid-hour on a backed-off PC is uploaded within one 30 s tick', async () => {
  resetQueueSync()
  await sweep()
  clock = realNow()
  env.HEAD_CACHE_S = '0'
  const savedWorkers = new Map(workers)
  workers.clear()
  const a = pacedPc(0)
  const b = pacedPc(1)
  try {
    const start = clock
    // 30 quiet minutes: the backoff reaches its ceiling
    while (clock - start < 30 * 60_000) {
      clock += TICK
      await tickPc(a, clock, true)
      await tickPc(b, clock)
    }
    expect(a.passes).toBeLessThan(20)
    const passesBefore = a.passes
    workers.set('w-new', {
      id: 'w-new',
      group: 'g-new',
      title: 'queued mid-hour',
      pending: [],
      status: 'queued',
      attempts: [],
      createdAt: clock,
      updatedAt: clock,
    } as any)
    const changedAt = clock
    let uploadedAt = 0
    while (!uploadedAt && clock - changedAt <= 5 * 60_000) {
      clock += TICK
      if (await tickPc(a, clock, true)) uploadedAt = clock
      await tickPc(b, clock)
    }
    expect(uploadedAt).toBeGreaterThan(0)
    expect(uploadedAt - changedAt).toBeLessThanOrEqual(TICK)
    expect(a.passes).toBe(passesBefore + 1)
  } finally {
    delete env.HEAD_CACHE_S
    workers.clear()
    for (const [k, v] of savedWorkers) workers.set(k, v)
  }
})
