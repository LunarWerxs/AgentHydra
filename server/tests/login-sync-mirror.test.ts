// server/tests/login-sync-mirror.test.ts — two PCs keep a mirror of the login sync's store from its
// changes feed (core/login-sync-mirror.ts).
//
// The contract: after the first pass (the full lists) a pass with nothing changed asks the store ONE
// thing, GET /v1/changes, and no list; a login one PC writes reaches the other through the feed; a
// login one PC deletes leaves the other's mirror through `gone`. The store is the real Worker on
// bun:sqlite (login-sync-store.ts).

import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { StoreMirror } from '../src/core/login-sync-mirror'
import { base, store, token } from './login-sync-store'

const ids = new Set<string>()
const ALL = { tables: ['logins' as const, 'queues' as const, 'chats' as const] }
afterAll(async () => {
  for (const r of (await store('GET', '/v1/logins')).json.logins)
    if (ids.has(r.id)) await store('DELETE', `/v1/logins/${r.id}?version=${r.version}`)
})

/** A PC: its mirror, and every request the mirror made to the store. */
function pc() {
  const requests: string[] = []
  const mirror = new StoreMirror(async (method, path) => {
    requests.push(`${method} ${path.split('?')[0]}`)
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    })
    const header = res.headers.get('x-store-rev')
    return { status: res.status, json: await res.json(), rev: header ? Number(header) : undefined }
  })
  const logins = () => {
    const v = mirror.view('logins')
    if (!v.ok) throw new Error('logins list failed')
    return v.rows.map((r) => r.id).filter((id) => ids.has(id))
  }
  return { mirror, requests, logins }
}

test('an idle pass asks only for changes, and a write and a delete on one PC reach the other', async () => {
  const a = pc()
  const b = pc()
  const id = randomUUID()
  ids.add(id)
  const put = await store('PUT', `/v1/logins/${id}`, { version: 0, blob: 'x', meta: { at: 1 } })
  expect(put.status).toBe(200)

  // First pass: the full lists, one per table.
  await a.mirror.refresh(ALL)
  await b.mirror.refresh(ALL)
  expect(a.requests.sort()).toEqual(['GET /v1/chats', 'GET /v1/logins', 'GET /v1/queues'])
  expect(a.logins()).toEqual([id])

  // A PC that asks for logins only never lists the other tables.
  const c = pc()
  await c.mirror.refresh()
  expect(c.requests).toEqual(['GET /v1/logins'])

  // Nothing changed: exactly one request, the feed, and no list.
  a.requests.length = 0
  await a.mirror.refresh(ALL)
  expect(a.requests).toEqual(['GET /v1/changes'])

  // A login written elsewhere reaches B through the feed.
  const id2 = randomUUID()
  ids.add(id2)
  await store('PUT', `/v1/logins/${id2}`, { version: 0, blob: 'y', meta: { at: 2 } })
  b.requests.length = 0
  await b.mirror.refresh(ALL)
  expect(b.requests).toEqual(['GET /v1/changes'])
  expect(b.logins().sort()).toEqual([id, id2].sort())

  // A delete reaches B as `gone`.
  await store('DELETE', `/v1/logins/${id}?version=1`)
  b.requests.length = 0
  await b.mirror.refresh(ALL)
  expect(b.requests).toEqual(['GET /v1/changes'])
  expect(b.logins()).toEqual([id2])

  // A refresh younger than the reuse window asks nothing.
  b.requests.length = 0
  await b.mirror.refresh({ maxAgeMs: 20_000 })
  expect(b.requests).toEqual([])
})
