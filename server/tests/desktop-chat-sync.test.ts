// server/tests/desktop-chat-sync.test.ts — two PCs share their desktop chats through the login sync's
// store (core/desktop-chat-sync.ts).
//
// The contract: a visible chat one PC shares reaches the other with its transcript byte for byte and
// its origin; later turns travel as new chunks only; a chat archived before it was ever shared is
// never uploaded, and archiving a shared one reaches the other PC; a chat continued on both PCs
// between passes is `diverged` and neither transcript changes; an unfinished last line waits for its
// newline; a PC with another key writes nothing. The store is the real Worker on bun:sqlite
// (login-sync-store.ts); each PC is a fake ChatLocal over a temp folder with its own state file.

import { afterAll, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARCHIVED_KEEP_MS,
  CHAT_MIN_GAP_MS,
  CHAT_PUSH_EVERY_MS,
  chatSyncRows,
  syncChats,
} from '../src/core/desktop-chat-sync'
import type {
  ChatIo,
  ChatLocal,
  ChatSyncRow,
  IncomingChat,
  LandOutcome,
  LocalChat,
} from '../src/core/desktop-chat-types'
import { store } from './login-sync-store'

const key = randomBytes(32)
const pcs = new Set<string>()
const tempDirs = new Set<string>()

// The store is shared by every test file in the process: leave none of this file's chats in it, or
// another file's PC meets rows it cannot open.
afterAll(async () => {
  for (const r of (await store('GET', '/v1/chats')).json.chats)
    if (pcs.has(r.meta?.pc)) await store('DELETE', `/v1/chats/${r.id}?version=${r.version}`)
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true })
    } catch {}
  }
})

interface Pc {
  io: ChatIo
  chats: LocalChat[]
  landed: IncomingChat[]
  appends: Array<[string, number]>
  path: (project: string, sessionId: string) => string
  /** Give the PC a chat with this transcript text. */
  add: (over?: Partial<LocalChat>, text?: string) => LocalChat
  text: (c: { project: string | null; sessionId: string }) => string
  extend: (c: LocalChat, more: string) => void
  setLand: (o: LandOutcome) => void
}

function pc(name: string, useKey = key): Pc {
  const dir = mkdtempSync(join(tmpdir(), 'chat-sync-'))
  tempDirs.add(dir)
  const chats: LocalChat[] = []
  const landed: IncomingChat[] = []
  const appends: Array<[string, number]> = []
  let landOut: LandOutcome = { ok: true }
  const path = (project: string, sessionId: string) => join(dir, project, `${sessionId}.jsonl`)
  const size = (project: string, sessionId: string) =>
    existsSync(path(project, sessionId)) ? statSync(path(project, sessionId)).size : 0
  const local: ChatLocal = {
    list: () => chats.map((c) => ({ ...c, size: c.project ? size(c.project, c.sessionId) : 0 })),
    read: (project, sessionId, from, to) =>
      new Uint8Array(readFileSync(path(project, sessionId)).subarray(from, to)),
    size,
    append(project, sessionId, expected, bytes) {
      if (size(project, sessionId) !== expected) return false
      mkdirSync(join(dir, project), { recursive: true })
      writeFileSync(
        path(project, sessionId),
        Buffer.concat([
          existsSync(path(project, sessionId))
            ? readFileSync(path(project, sessionId))
            : Buffer.alloc(0),
          bytes,
        ]),
      )
      appends.push([sessionId, expected])
      return true
    },
    async land(chat) {
      landed.push(chat)
      if (landOut.ok) {
        const i = chats.findIndex((c) => c.id === chat.id)
        const next: LocalChat = { ...chat, size: 0 }
        if (i >= 0) chats[i] = next
        else chats.push(next)
      }
      return landOut
    },
  }
  const id = randomUUID()
  pcs.add(id)
  const self: Pc = {
    io: {
      call: store,
      key: useKey,
      pc: id,
      name,
      local,
      statePath: join(dir, 'state.json'),
    },
    chats,
    landed,
    appends,
    path,
    add(over = {}, text = '') {
      const c: LocalChat = {
        id: randomUUID(),
        sessionId: randomUUID(),
        project: 'proj',
        account: randomUUID(),
        org: randomUUID(),
        record: { title: 'A chat' },
        archived: false,
        size: 0,
        ...over,
      }
      chats.push(c)
      if (text && c.project) {
        mkdirSync(join(dir, c.project), { recursive: true })
        writeFileSync(path(c.project, c.sessionId), text)
      }
      return c
    },
    text: (c) =>
      c.project && existsSync(path(c.project, c.sessionId))
        ? readFileSync(path(c.project, c.sessionId), 'utf8')
        : '',
    extend(c, more) {
      writeFileSync(path(c.project as string, c.sessionId), self.text(c) + more)
    },
    setLand: (o) => {
      landOut = o
    },
  }
  return self
}

/** A pass far enough after the last one that a chat still growing is sent, not held back. */
const pastHold = () => Date.now() + CHAT_PUSH_EVERY_MS

const rowFor = async (id: string) =>
  (await store('GET', '/v1/chats')).json.chats.find((r: { id: string }) => r.id === id)

test('a visible chat A shares reaches B with its transcript, its origin, and A as the source', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n{"n":2}\n')
  await syncChats(a.io)
  await syncChats(b.io)

  expect(b.text(chat)).toBe(a.text(chat))
  expect(b.landed.filter((l) => l.id === chat.id)).toHaveLength(1)
  expect(b.landed[0].origin).toEqual({ pc: a.io.pc, name: 'PC-A' })
  const row = chatSyncRows(b.io.statePath).find((r) => r.id === chat.id) as ChatSyncRow
  expect(row).toMatchObject({ id: chat.id, fromHere: false, state: 'synced', title: 'A chat' })
  expect(row.origin.name).toBe('PC-A')
  expect(chatSyncRows(a.io.statePath).find((r) => r.id === chat.id)).toMatchObject({
    fromHere: true,
  })

  // B now holds the chat: it is in step, so a further pass changes nothing and never re-shares it.
  const version = (await rowFor(chat.id)).version
  await syncChats(b.io)
  expect((await rowFor(chat.id)).version).toBe(version)
  expect(b.landed.filter((l) => l.id === chat.id)).toHaveLength(1)
})

test('A appends turns and B fetches only the new chunks, appending at the length it had', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(b.appends.filter(([s]) => s === chat.sessionId).map(([, n]) => n)).toEqual([0])

  a.extend(chat, '{"n":2}\n{"n":3}\n')
  await syncChats(a.io, pastHold())
  await syncChats(b.io)

  expect(b.appends.filter(([s]) => s === chat.sessionId).map(([, n]) => n)).toEqual([0, 8])
  expect(b.text(chat)).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
  expect(chatSyncRows(b.io.statePath).find((r) => r.id === chat.id)?.bytes).toBe(24)
})

test('a chat archived before it was shared never goes up; archiving a shared one reaches B and leaves the store three days later', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const old = a.add({ archived: true }, '{"old":1}\n')
  const live = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(await rowFor(old.id)).toBeUndefined()
  expect((await store('GET', `/v1/chats/${old.sessionId}/chunks`)).json.chunks).toEqual([])
  expect(b.landed.filter((l) => l.id === live.id).map((l) => l.archived)).toEqual([false])
  expect(b.landed.some((l) => l.id === old.id)).toBe(false)

  const mine = a.chats.find((c) => c.id === live.id) as LocalChat
  mine.archived = true
  await syncChats(a.io)
  await syncChats(b.io)
  const mineLanded = b.landed.filter((l) => l.id === live.id)
  expect(mineLanded).toHaveLength(2)
  expect(mineLanded[1].archived).toBe(true)

  // Three days on, it leaves the store with its transcript; neither PC lists it, and unarchiving it
  // does not send it again.
  const later = Date.now() + ARCHIVED_KEEP_MS + 3600_000
  await syncChats(a.io, later)
  expect(await rowFor(live.id)).toBeUndefined()
  expect((await store('GET', `/v1/chats/${live.sessionId}/chunks`)).json.chunks).toEqual([])
  await syncChats(b.io, later)
  expect(chatSyncRows(a.io.statePath).some((r) => r.id === live.id)).toBe(false)
  expect(chatSyncRows(b.io.statePath).some((r) => r.id === live.id)).toBe(false)
  mine.archived = false
  await syncChats(a.io, later)
  expect(await rowFor(live.id)).toBeUndefined()
})

test('a chat continued on both PCs between passes is diverged and neither transcript changes', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  const bChat = b.chats.find((c) => c.id === chat.id) as LocalChat

  a.extend(chat, '{"a":1}\n')
  b.extend(bChat, '{"b":1}\n')
  const later = pastHold()
  await syncChats(a.io, later)
  await syncChats(b.io)
  await syncChats(a.io, later)

  expect(chatSyncRows(b.io.statePath).find((r) => r.id === chat.id)?.state).toBe('diverged')
  expect(a.text(chat)).toBe('{"n":1}\n{"a":1}\n')
  expect(b.text(bChat)).toBe('{"n":1}\n{"b":1}\n')
})

test('a last line with no newline yet is not sent until it ends', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n{"n":2')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(b.text(chat)).toBe('{"n":1}\n')

  a.extend(chat, '}\n')
  await syncChats(a.io, pastHold())
  await syncChats(b.io)
  expect(b.text(chat)).toBe('{"n":1}\n{"n":2}\n')
})

test('a chat still being written in goes up when it stops growing or every few minutes; an archive at once', async () => {
  const a = pc('PC-A')
  const chat = a.add({}, '{"n":1}\n')
  const t = Date.now()
  await syncChats(a.io, t)
  const version = (await rowFor(chat.id)).version

  // Growing on every pass: held until CHAT_PUSH_EVERY_MS after the last send.
  a.extend(chat, '{"n":2}\n')
  await syncChats(a.io, t + 30_000)
  a.extend(chat, '{"n":3}\n')
  await syncChats(a.io, t + 60_000)
  expect(await rowFor(chat.id)).toMatchObject({ version, meta: { b: 8 } })
  a.extend(chat, '{"n":4}\n')
  await syncChats(a.io, t + CHAT_PUSH_EVERY_MS)
  expect((await rowFor(chat.id)).meta.b).toBe(32)

  // A turn that ends goes on the first pass at least CHAT_MIN_GAP_MS after the last send, without
  // waiting out the longer interval.
  a.extend(chat, '{"n":5}\n')
  await syncChats(a.io, t + CHAT_PUSH_EVERY_MS + 30_000)
  await syncChats(a.io, t + CHAT_PUSH_EVERY_MS + 60_000)
  expect((await rowFor(chat.id)).meta.b).toBe(32)
  await syncChats(a.io, t + CHAT_PUSH_EVERY_MS + CHAT_MIN_GAP_MS)
  expect((await rowFor(chat.id)).meta.b).toBe(40)

  // A clock set back an hour since that send does not hold the chat for the hour.
  a.extend(chat, '{"n":6}\n')
  await syncChats(a.io, t - 3600_000)
  expect((await rowFor(chat.id)).meta.b).toBe(48)

  a.extend(chat, '{"n":7}\n')
  ;(a.chats.find((c) => c.id === chat.id) as LocalChat).archived = true
  await syncChats(a.io, t - 3600_000 + 30_000)
  expect((await rowFor(chat.id)).meta.a).toBe(1)
})

test('one session filed under two visible records goes up once, through the most recently active', async () => {
  // A chat moved between profiles keeps its session id; the second record restarted the stream
  // at chunk 0 and stopped on 'taken' on every pass.
  const a = pc('PC-A')
  const older = a.add({ record: { title: 'Moved', lastActivityAt: 1 } }, '{"n":1}\n')
  const newer = a.add({ sessionId: older.sessionId, record: { title: 'Moved', lastActivityAt: 2 } })
  await syncChats(a.io)
  await syncChats(a.io)
  expect(await rowFor(older.id)).toBeUndefined()
  expect((await rowFor(newer.id))?.meta.b).toBe(8)
})

test('a PC with a different key reports it and writes nothing', async () => {
  const a = pc('PC-A')
  const chat = a.add({}, '{"n":1}\n')
  await syncChats(a.io)

  const other = pc('PC-C', randomBytes(32))
  const own = other.add({}, '{"mine":1}\n')
  await expect(syncChats(other.io)).rejects.toThrow('does not open with this PC’s key')
  expect(other.landed).toEqual([])
  expect(other.chats.map((c) => c.id)).toEqual([own.id])
  expect(other.text(chat)).toBe('')
  expect(existsSync(other.io.statePath)).toBe(false)
  expect(await rowFor(own.id)).toBeUndefined()
})

test('a burst of edits to one chat within two minutes goes up once, and the last change is not lost', async () => {
  const a = pc('PC-A')
  const chat = a.add({}, '{"n":0}\n')
  const t = Date.now()
  await syncChats(a.io, t)
  const first = (await rowFor(chat.id)).version

  // ten edits, one per pass, 10 s apart: some stop growing for a pass, none is sent
  for (let i = 1; i <= 10; i++) {
    if (i % 3 !== 0) a.extend(chat, `{"n":${i}}\n`)
    await syncChats(a.io, t + i * 10_000)
  }
  expect((await rowFor(chat.id)).version).toBe(first)

  // the first pass past the gap sends everything the burst wrote, in one record write
  await syncChats(a.io, t + CHAT_MIN_GAP_MS)
  const sent = await rowFor(chat.id)
  expect(sent.version).toBe(first + 1)
  expect(sent.meta.b).toBe(a.text(chat).length)
})
