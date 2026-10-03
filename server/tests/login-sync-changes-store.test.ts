// server/tests/login-sync-changes-store.test.ts — the changes feed of the real login sync Worker:
// the store rev, the tombstones and GET /v1/changes. Rows made here are removed again, because the
// store is one per test process.

import { afterAll, expect, test } from 'bun:test'
import { base, store, storeDb, token } from './login-sync-store'

const newId = () => crypto.randomUUID()
const made = {
  logins: new Map<string, number>(),
  chats: new Map<string, number>(),
  queues: [] as string[],
}

afterAll(async () => {
  for (const [id, v] of made.logins) await store('DELETE', `/v1/logins/${id}?version=${v}`)
  for (const [id, v] of made.chats) await store('DELETE', `/v1/chats/${id}?version=${v}`)
  for (const pc of made.queues)
    await storeDb.prepare('DELETE FROM queues WHERE pc = ?').bind(pc).run()
})

/** PUT a new row and remember it for the clean-up. */
async function put(kind: 'logins' | 'chats' | 'queues', id = newId(), meta: object = {}) {
  const r = await store('PUT', `/v1/${kind}/${id}`, { version: 0, blob: 'b', meta })
  expect(r.json).toEqual({ version: 1 })
  if (kind === 'queues') made.queues.push(id)
  else made[kind].set(id, 1)
  return id
}

/** The store rev as a list route reports it. */
async function listRev(kind = 'logins') {
  const r = await fetch(`${base}/v1/${kind}`, { headers: { authorization: `Bearer ${token}` } })
  return Number(r.headers.get('x-store-rev'))
}

const changes = async (since: number) => (await store('GET', `/v1/changes?since=${since}`)).json

test('a write after the cursor shows up exactly once, with no blob; then the feed is idle', async () => {
  const cursor = await listRev()
  const login = await put('logins', undefined, { pc: 'a' })
  const queue = await put('queues')
  const chat = await put('chats', undefined, { s: newId() })

  const c = await changes(cursor)
  expect(c.rev).toBe(cursor + 3)
  expect(c.logins).toEqual([
    { id: login, version: 1, meta: { pc: 'a' }, updatedAt: expect.any(Number) },
  ])
  expect(c.queues.map((r: { pc: string }) => r.pc)).toEqual([queue])
  expect(c.chats.map((r: { id: string }) => r.id)).toEqual([chat])
  expect(c.gone).toEqual([])
  expect(JSON.stringify(c)).not.toContain('"blob"')

  expect(await changes(c.rev)).toEqual({ rev: c.rev, logins: [], queues: [], chats: [], gone: [] })
})

test('an update shows up once under its new version', async () => {
  const id = await put('chats', undefined, { s: newId() })
  const cursor = await listRev('chats')
  expect(
    (await store('PUT', `/v1/chats/${id}`, { version: 1, blob: 'x', meta: { n: 2 } })).json,
  ).toEqual({ version: 2 })
  made.chats.set(id, 2)
  const c = await changes(cursor)
  expect(c.chats).toEqual([{ id, version: 2, meta: { n: 2 }, updatedAt: expect.any(Number) }])
  expect(c.rev).toBe(cursor + 1)
})

test('a delete arrives as gone, and a re-created id is not gone', async () => {
  const cursor = await listRev()
  const dead = await put('logins')
  const chat = await put('chats', undefined, { s: newId() })
  const back = await put('logins')
  expect((await store('DELETE', `/v1/logins/${dead}?version=1`)).json).toEqual({ ok: true })
  expect((await store('DELETE', `/v1/chats/${chat}?version=1`)).json).toEqual({ ok: true })
  made.logins.delete(dead)
  made.chats.delete(chat)
  expect((await store('DELETE', `/v1/logins/${back}?version=1`)).json).toEqual({ ok: true })
  expect(
    (await store('PUT', `/v1/logins/${back}`, { version: 0, blob: 'again', meta: {} })).json,
  ).toEqual({ version: 1 })
  made.logins.set(back, 1)

  const c = await changes(cursor)
  expect(c.gone).toEqual(
    expect.arrayContaining([
      { table: 'logins', id: dead },
      { table: 'chats', id: chat },
    ]),
  )
  expect(c.gone).not.toContainEqual({ table: 'logins', id: back })
  expect(c.logins.map((r: { id: string }) => r.id)).toContain(back)
  expect(c.logins.map((r: { id: string }) => r.id)).not.toContain(dead)
})

test('a refused write changes nothing, rev included', async () => {
  const id = await put('logins')
  const rev = await listRev()
  const refused = [
    await store('PUT', `/v1/logins/${id}`, { version: 0, blob: 'other', meta: {} }),
    await store('PUT', `/v1/logins/${id}`, { version: 7, blob: 'other', meta: {} }),
    await store('PUT', `/v1/logins/${newId()}`, { version: 3, blob: 'other', meta: {} }),
    await store('DELETE', `/v1/logins/${id}?version=9`),
    await store('DELETE', `/v1/chats/${newId()}?version=1`),
    await store('PUT', `/v1/logins/${id}`, { version: 1, blob: '', meta: {} }),
  ]
  expect(refused.map((r) => r.status)).toEqual([409, 409, 409, 409, 409, 400])
  expect(await listRev()).toBe(rev)
  expect(await changes(rev)).toEqual({ rev, logins: [], queues: [], chats: [], gone: [] })
})

test('a cursor from the future (the store was reset) gets full: true', async () => {
  const rev = await listRev()
  expect(await changes(rev + 1000)).toEqual({ rev, full: true })
})

test('the list header gives a cursor that misses nothing', async () => {
  const before = await listRev()
  const first = await put('logins')
  const cursor = await listRev()
  const second = await put('logins')
  expect(cursor).toBe(before + 1)
  const ids = (await changes(cursor)).logins.map((r: { id: string }) => r.id)
  expect(ids).toEqual([second])
  expect((await changes(before)).logins.map((r: { id: string }) => r.id).sort()).toEqual(
    [first, second].sort(),
  )
})

test('a bad since is a 400', async () => {
  expect((await store('GET', '/v1/changes?since=nope')).status).toBe(400)
  expect((await store('GET', '/v1/changes')).status).toBe(400)
})

test('rows read: an idle changes call against one full set of list calls', async () => {
  for (let i = 0; i < 10; i++) await put('logins')
  for (let i = 0; i < 10; i++) await put('chats', undefined, { s: newId() })
  for (let i = 0; i < 2; i++) await put('queues')
  const cursor = await listRev()

  storeDb.resetRowsRead()
  expect(await changes(cursor)).toEqual({
    rev: cursor,
    logins: [],
    queues: [],
    chats: [],
    gone: [],
  })
  const idle = storeDb.rowsRead()

  storeDb.resetRowsRead()
  for (const kind of ['logins', 'queues', 'chats']) await store('GET', `/v1/${kind}`)
  const lists = storeDb.rowsRead()

  console.log(`rows_read: idle /v1/changes = ${idle}; one full set of list calls = ${lists}`)
  expect(idle).toBe(1)
  expect(lists).toBeGreaterThanOrEqual(22)
  expect(idle).toBeLessThanOrEqual(lists * 0.05)
})
