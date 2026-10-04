// server/tests/login-sync-cold-start.test.ts — what the login sync Worker asks D1 when an isolate
// starts cold: a database already at the current schema costs at most 2 statements before the route
// runs, an idle changes poll costs none (the StoreHead Durable Object holds the head), and tombstones
// are pruned by scheduled(), not by a request. Each test loads its own copy of the Worker (the shared
// store remembers its schema per module).

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { d1, headNamespace } from './login-sync-store'

const token = 'cold-start-token'
const tokenHash = createHash('sha256').update(token).digest('hex')
type W = {
  fetch: (r: Request, env: unknown) => Promise<Response>
  scheduled: (e: unknown, env: unknown) => Promise<void>
  forgetIsolate?: () => void
}
const workerPath = join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js')
const load = async (tag: string) => (await import(`${workerPath}?${tag}`)).default as W
type Env = {
  DB: ReturnType<typeof d1>
  TOKEN_SHA256: string
  HEAD: ReturnType<typeof headNamespace>
}
/** The bindings of one store: its D1 and its StoreHead Durable Object, which runs in an isolate of its
 *  own (its own module copy, so its schema check is its own too). */
const storeEnv = async (db: ReturnType<typeof d1>, tag: string): Promise<Env> => {
  const e = { DB: db, TOKEN_SHA256: tokenHash } as Env
  e.HEAD = headNamespace((await import(`${workerPath}?head-${tag}`)).StoreHead, e)
  return e
}
const ask = (w: W, e: Env, path: string, method = 'GET', body?: unknown) =>
  w.fetch(
    new Request(`http://store${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  )

test('a cold isolate on a migrated database runs at most 2 statements before the route', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const e = await storeEnv(db, 'cold')
  expect((await ask(await load('cold-a'), e, '/v1/health')).status).toBe(200)
  // first ever request migrates the empty database
  expect((await ask(await load('cold-a'), e, '/v1/logins')).status).toBe(200)

  // a new isolate (a new module copy) against the migrated database
  const cold = await load('cold-b')
  db.resetRowsRead()
  expect((await ask(cold, e, '/v1/logins')).status).toBe(200)
  const sql = db.statements().map((s) => s.sql)
  console.log('cold first request statements:', sql.length, JSON.stringify(sql))
  const schemaStatements = sql.filter((q) => /PRAGMA|CREATE|ALTER|tombstones/i.test(q))
  expect(schemaStatements.length).toBeLessThanOrEqual(2)
  expect(sql.some((q) => /DELETE FROM tombstones/i.test(q))).toBe(false)
  expect(sql.some((q) => /FROM tombstones WHERE time/i.test(q))).toBe(false)
})

test('scheduled() prunes tombstones older than 30 days, raises floor, by the time index', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const w = await load('cron')
  const e = await storeEnv(db, 'cron')
  await ask(w, e, '/v1/logins') // migrate
  const old = crypto.randomUUID()
  const recent = crypto.randomUUID()
  sqlite.run('UPDATE store_rev SET rev = 9 WHERE id = 1')
  sqlite.run(`INSERT INTO tombstones VALUES ('logins', '${old}', 5, ${Date.now() - 31 * 86400000})`)
  sqlite.run(`INSERT INTO tombstones VALUES ('logins', '${recent}', 8, ${Date.now() - 86400000})`)

  db.resetRowsRead()
  await w.scheduled({}, e)
  expect(sqlite.query('SELECT id FROM tombstones').all()).toEqual([{ id: recent }])
  expect(sqlite.query('SELECT floor FROM store_rev').get()).toEqual({ floor: 5 })
  // one old row read twice (floor, delete), plus the head the batch hands the Durable Object: the
  // index on time keeps the recent row out of it
  expect(db.rowsRead()).toBeLessThanOrEqual(5)
})

// An idle poll of GET /v1/changes. Before the ETag change it was one batch of 5 statements (the head and
// four `WHERE rev > ?` range reads) on every cold isolate; with the per-isolate head, 2 on a cold isolate
// (the head and the schema gate) and 0 on one that still held it; with the StoreHead Durable Object, 0
// on either.
const otherPc = '11111111-1111-4111-8111-111111111111'
const thisPc = '22222222-2222-4222-8222-222222222222'
const poll = (w: W, e: Env, since: number, inm: boolean, pc = thisPc) =>
  w.fetch(
    new Request(`http://store/v1/changes?since=${since}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-agenthydra-pc': pc,
        ...(inm ? { 'if-none-match': `"${since}"` } : {}),
      },
    }),
    e,
  )
const putLogin = (w: W, e: Env, id: string) =>
  ask(w, e, `/v1/logins/${id}`, 'PUT', { version: 0, blob: 'x', meta: {} })
const HEAD_READ = 'SELECT rev, floor, logins_rev, queues_rev, chats_rev FROM store_rev WHERE id = 1'

test('an idle changes poll from a cold isolate runs no D1 statement and answers 304 with the other PCs in x-seen', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const e = await storeEnv(db, 'idle')
  const first = await load('idle-a')
  await putLogin(first, e, crypto.randomUUID()) // migrates; the head is at rev 1
  await poll(first, e, 1, true, otherPc) // the other PC polls: stamped seen

  // a cold Worker isolate, and the Durable Object evicted: it comes back with its head from its storage
  const cold = await load('idle-b')
  e.HEAD.evict()
  db.resetRowsRead()
  const before = Date.now()
  const res = await poll(cold, e, 1, true)
  console.log('idle poll, cold isolate: D1 statements', db.statements().length)
  expect(res.status).toBe(304)
  expect(res.headers.get('etag')).toBe('"1"')
  expect(db.statements()).toEqual([])
  const seen = Object.fromEntries(
    (res.headers.get('x-seen') ?? '').split(',').map((p) => p.split('=')),
  )
  expect(Object.keys(seen)).toEqual([otherPc]) // never the asking PC itself
  expect(Number(seen[otherPc])).toBeLessThanOrEqual(before)

  // an old client sends no If-None-Match: the same 200 body as before, still no D1
  const old = await poll(cold, e, 1, false)
  expect(old.status).toBe(200)
  expect(await old.json()).toEqual({ rev: 1, logins: [], queues: [], chats: [], gone: [] })
  expect(db.statements()).toEqual([])
})

test('a write is in the next poll, from another isolate', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const e = await storeEnv(db, 'write')
  const w = await load('write-a')
  await ask(w, e, '/v1/logins')
  const id = crypto.randomUUID()
  db.resetRowsRead()
  expect((await putLogin(w, e, id)).status).toBe(200)
  console.log('one write: D1 statements', JSON.stringify(db.statements().map((s) => s.sql)))
  const res = await poll(await load('write-b'), e, 0, true)
  expect(res.status).toBe(200)
  expect(res.headers.get('etag')).toBe('"1"')
  const body = (await res.json()) as { rev: number; logins: Array<{ id: string }> }
  expect(body.rev).toBe(1)
  expect(body.logins.map((l) => l.id)).toEqual([id])
})

test('a write whose head update is lost is still in the next poll, and idle polls are free again after PENDING_MAX_MS', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const e = await storeEnv(db, 'lost')
  const w = await load('lost-a')
  await ask(w, e, '/v1/logins')
  expect((await poll(w, e, 0, true)).status).toBe(304)

  // the batch commits, the call that hands the Durable Object its new head is lost
  e.HEAD.fail = (op) => op === 'end'
  const id = crypto.randomUUID()
  expect((await putLogin(w, e, id)).status).toBe(200)
  e.HEAD.fail = null
  e.HEAD.evict() // and the Durable Object is evicted on top: its pending token is in its storage

  const res = await poll(w, e, 0, true)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { logins: Array<{ id: string }> }
  expect(body.logins.map((l) => l.id)).toEqual([id])
  // while the token is pending each poll reads the head from D1 (one statement), never a stale copy
  db.resetRowsRead()
  expect((await poll(w, e, 1, true)).status).toBe(304)
  expect(db.statements().map((s) => s.sql)).toEqual([HEAD_READ])

  // past PENDING_MAX_MS (2 min) the token clears on that read, and the next idle poll is free
  const realNow = Date.now
  Date.now = () => realNow() + 3 * 60_000
  try {
    await poll(w, e, 1, true)
    db.resetRowsRead()
    expect((await poll(w, e, 1, true)).status).toBe(304)
    expect(db.statements()).toEqual([])
  } finally {
    Date.now = realNow
  }
})
