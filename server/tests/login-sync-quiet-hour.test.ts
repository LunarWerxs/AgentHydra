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
import { resetQueueSync, sealQueue, syncQueue } from '../src/core/climayte-queue-sync'
import { syncChats } from '../src/core/desktop-chat-sync'
import type { ChatIo, ChatLocal, LocalChat } from '../src/core/desktop-chat-types'
import { StoreMirror } from '../src/core/login-sync-mirror'
import { dropQueue, type StatementStat, store, storeDb } from './login-sync-store'

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

test('a busy hour: logins refreshed, a chat growing, both PCs heartbeating', async () => {
  const hour = await runHour(true, true)
  report('busy hour', hour)
  expect(hour.reads).toBeLessThanOrEqual(900)
})
