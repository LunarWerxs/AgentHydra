// server/tests/cli-login-sync-chats.test.ts — the desktop chats ride the login sync's pass behind
// their own switch.
//
// The contract (core/cli-login-sync.ts with core/desktop-chat-sync.ts): with the switch on, a pass
// runs the chat half and the status lists the chats; a chat half that fails (a store without the chat
// routes) sets `chatsError` only, never `lastError`, and the logins still sync; with it off no chat
// request is made and the status lists none. The store is the real Worker (login-sync-store.ts); this
// PC's chats are a fake ChatLocal.

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  chatsIdle,
  configureLoginSync,
  disconnectLoginSync,
  loginSyncStatus,
  runLoginSync,
  setChatLocalForTests,
  setChatSharing,
} from '../src/core/cli-login-sync'
import type { ChatLocal, LocalChat } from '../src/core/desktop-chat-types'
import { base, store, token } from './login-sync-store'

const transcript = new TextEncoder().encode('{"type":"user","message":"hello"}\n')

function fakeLocal(): ChatLocal {
  const chat: LocalChat = {
    id: randomUUID(),
    sessionId: randomUUID(),
    project: 'proj',
    account: randomUUID(),
    org: randomUUID(),
    record: { title: 'A shared chat', cwd: 'work', lastActivityAt: 1 },
    archived: false,
    size: transcript.length,
  }
  return {
    list: () => [chat],
    read: (_p, _s, from, to) => transcript.subarray(from, to),
    size: () => transcript.length,
    append: () => true,
    land: async () => ({ ok: true }),
  }
}

/** One login pass, then the chat pass it started. */
async function pass() {
  const res = await runLoginSync()
  await chatsIdle()
  return res
}

describe('desktop chats in the login sync pass', () => {
  test('on: a pass syncs the chats and the status lists them', async () => {
    setChatLocalForTests(fakeLocal())
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      expect(loginSyncStatus().shareChats).toBe(false)
      expect(setChatSharing(true).ok).toBe(true)
      await pass()
      await pass()
      const status = loginSyncStatus()
      expect(status.shareChats).toBe(true)
      expect(status.chatsError).toBeNull()
      expect(status.chats.map((c) => c.title)).toEqual(['A shared chat'])
      expect(status.chats[0]).toMatchObject({ fromHere: true, state: 'synced' })
      expect((await store('GET', '/v1/chats')).json.chats).toHaveLength(1)
    } finally {
      disconnectLoginSync()
      setChatLocalForTests(null)
    }
  })

  test('a store without chat routes sets chatsError only and the logins still sync', async () => {
    setChatLocalForTests(fakeLocal())
    const old = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/v1/logins'
          ? Response.json({ logins: [] })
          : Response.json({ error: 'not found' }, { status: 404 }),
    })
    try {
      expect((await configureLoginSync({ url: `http://127.0.0.1:${old.port}`, token })).ok).toBe(
        true,
      )
      setChatSharing(true)
      await pass()
      const res = await pass()
      expect(res.ok).toBe(true)
      const status = loginSyncStatus()
      expect(status.chatsError).toBeTruthy()
      expect(status.lastError).toBeNull()
    } finally {
      disconnectLoginSync()
      setChatLocalForTests(null)
      old.stop(true)
    }
  })

  test('off: no chat request is made and no chats are listed', async () => {
    setChatLocalForTests(fakeLocal())
    const paths: string[] = []
    const spy = Bun.serve({
      port: 0,
      fetch: (req) => {
        const p = new URL(req.url).pathname
        paths.push(p)
        return p === '/v1/logins'
          ? Response.json({ logins: [] })
          : Response.json({ error: 'not found' }, { status: 404 })
      },
    })
    try {
      expect((await configureLoginSync({ url: `http://127.0.0.1:${spy.port}`, token })).ok).toBe(
        true,
      )
      await pass()
      await pass()
      expect(paths.some((p) => p.startsWith('/v1/chats'))).toBe(false)
      const status = loginSyncStatus()
      expect(status.shareChats).toBe(false)
      expect(status.chats).toEqual([])
    } finally {
      disconnectLoginSync()
      setChatLocalForTests(null)
      spy.stop(true)
    }
  })
})
