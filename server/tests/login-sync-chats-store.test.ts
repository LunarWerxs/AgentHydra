// server/tests/login-sync-chats-store.test.ts — the chat and chunk routes of the real login sync Worker.

import { expect, test } from 'bun:test'
import { base, store } from './login-sync-store'

const newId = () => crypto.randomUUID()
const chunk = (id: string, seq: number, blob: string, by = 'pc-a') =>
  store('PUT', `/v1/chats/${id}/chunks/${seq}`, { blob, by })

test('a chat row is written by compare-and-swap and listed without its blob', async () => {
  const id = newId()
  expect(
    (await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'one', meta: { t: 1 } })).json,
  ).toEqual({
    version: 1,
  })
  const stale = await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'two', meta: {} })
  expect(stale.status).toBe(409)
  expect(stale.json.current.version).toBe(1)
  expect(
    (await store('PUT', `/v1/chats/${id}`, { version: 1, blob: 'two', meta: {} })).json,
  ).toEqual({
    version: 2,
  })
  const listed = (await store('GET', '/v1/chats')).json.chats.find((c: any) => c.id === id)
  expect(listed.version).toBe(2)
  expect(listed.blob).toBeUndefined()
  expect((await store('GET', `/v1/chats/${id}`)).json.blob).toBe('two')
  expect((await store('GET', `/v1/chats/${newId()}`)).status).toBe(404)
})

test('a chunk seq is written once, lists in order from `from`, and a page stops past the budget', async () => {
  const id = newId()
  expect((await chunk(id, 1, 'b')).json).toEqual({ seq: 1 })
  expect((await chunk(id, 0, 'a')).json).toEqual({ seq: 0 })
  const taken = await chunk(id, 1, 'changed')
  expect(taken.status).toBe(409)
  expect(taken.json).toEqual({ error: 'taken', next: 2 })
  const all = (await store('GET', `/v1/chats/${id}/chunks`)).json
  expect(all.chunks.map((c: any) => [c.seq, c.blob, c.by])).toEqual([
    [0, 'a', 'pc-a'],
    [1, 'b', 'pc-a'],
  ])
  expect(all).toMatchObject({ next: 2, more: false })
  const tail = (await store('GET', `/v1/chats/${id}/chunks?from=1`)).json
  expect(tail.chunks.map((c: any) => c.seq)).toEqual([1])
  expect((await store('GET', `/v1/chats/${id}/chunks?from=5`)).json).toEqual({
    chunks: [],
    next: 5,
    more: false,
  })

  const big = newId()
  const blob = 'x'.repeat(1_048_576)
  for (let seq = 0; seq < 9; seq++) expect((await chunk(big, seq, blob)).status).toBe(200)
  const page = (await store('GET', `/v1/chats/${big}/chunks`)).json
  expect(page.chunks).toHaveLength(8)
  expect(page).toMatchObject({ next: 8, more: true })
  const rest = (await store('GET', `/v1/chats/${big}/chunks?from=${page.next}`)).json
  expect(rest.chunks.map((c: any) => c.seq)).toEqual([8])
  expect(rest.more).toBe(false)
})

test('caps: an oversize blob and a bad id are 400, a missing token is 401', async () => {
  const id = newId()
  expect((await chunk(id, 0, 'x'.repeat(1_048_577))).status).toBe(400)
  expect((await chunk(id, 0, '')).status).toBe(400)
  expect((await chunk(id, 1_000_001, 'a')).status).toBe(400)
  expect((await chunk('not-a-uuid', 0, 'a')).status).toBe(400)
  expect(
    (await store('PUT', '/v1/chats/not-a-uuid', { version: 0, blob: 'a', meta: {} })).status,
  ).toBe(400)
  expect((await fetch(`${base}/v1/chats`)).status).toBe(401)
})

test('deleting a chat at its current version removes its chunks; a stale version removes nothing', async () => {
  const id = newId()
  await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'one', meta: {} })
  await chunk(id, 0, 'a')
  expect((await store('DELETE', `/v1/chats/${id}?version=9`)).status).toBe(409)
  expect((await store('GET', `/v1/chats/${id}`)).status).toBe(200)
  expect((await store('GET', `/v1/chats/${id}/chunks`)).json.chunks).toHaveLength(1)
  expect((await store('DELETE', `/v1/chats/${id}?version=1`)).json).toEqual({ ok: true })
  expect((await store('GET', `/v1/chats/${id}`)).status).toBe(404)
  expect((await store('GET', `/v1/chats/${id}/chunks`)).json.chunks).toEqual([])
})
