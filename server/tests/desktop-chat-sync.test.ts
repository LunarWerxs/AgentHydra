// server/tests/desktop-chat-sync.test.ts — two PCs show each other their desktop chats through the
// login sync's store, view only (core/desktop-chat-sync.ts).
//
// The contract: a visible chat one PC started reaches the other's viewer with its transcript byte for
// byte and its origin, and never its chat list; later turns travel as new chunks only; a chat archived
// before it was ever shared is never uploaded, and archiving a shared one reaches the other PC; a copy
// of another PC's chat never goes up, however it grows; a chat another PC wrote into goes up again from
// the transcript of the PC it started on; a chat an earlier version took into ~/.claude is taken back
// out once; an unfinished last line waits for its newline; a PC with another key writes
// nothing. The store is the real Worker on bun:sqlite (login-sync-store.ts); each PC is a fake
// ChatLocal over a temp folder with its own state file.

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
  chatsFromElsewhere,
  syncChats,
} from '../src/core/desktop-chat-sync'
import type {
  ChatIo,
  ChatLocal,
  ChatSyncRow,
  LocalChat,
  RetireOutcome,
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
  /** Every write to the viewer: [session, at]. */
  writes: Array<[string, number]>
  /** Every session retire was asked for, in order. */
  retired: string[]
  /** Give the PC a chat of its own with this transcript text. */
  add: (over?: Partial<LocalChat>, text?: string) => LocalChat
  /** A chat's transcript among this PC's own; '' when there is none. */
  text: (c: { project: string | null; sessionId: string }) => string
  /** The viewer's copy of another PC's chat; '' when there is none. */
  view: (c: { project: string | null; sessionId: string }) => string
  extend: (c: LocalChat, more: string) => void
  setRetire: (f: (sessionId: string) => RetireOutcome) => void
}

function pc(name: string, useKey = key): Pc {
  const dir = mkdtempSync(join(tmpdir(), 'chat-sync-'))
  tempDirs.add(dir)
  const chats: LocalChat[] = []
  const writes: Array<[string, number]> = []
  const retired: string[] = []
  let retireOut: (sessionId: string) => RetireOutcome = () => ({ ok: true, kept: false })
  const own = (project: string, sessionId: string) =>
    join(dir, 'own', project, `${sessionId}.jsonl`)
  const viewed = (project: string, sessionId: string) =>
    join(dir, 'view', project, `${sessionId}.jsonl`)
  const sizeAt = (path: string) => (existsSync(path) ? statSync(path).size : 0)
  const textAt = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const local: ChatLocal = {
    list: () =>
      chats.map((c) => ({ ...c, size: c.project ? sizeAt(own(c.project, c.sessionId)) : 0 })),
    read: (project, sessionId, from, to) =>
      new Uint8Array(readFileSync(own(project, sessionId)).subarray(from, to)),
    viewSize: (project, sessionId) => sizeAt(viewed(project, sessionId)),
    viewWrite(project, sessionId, at, bytes) {
      const path = viewed(project, sessionId)
      if (at !== 0 && sizeAt(path) !== at) return false
      mkdirSync(join(dir, 'view', project), { recursive: true })
      const before = at === 0 ? Buffer.alloc(0) : readFileSync(path)
      writeFileSync(path, Buffer.concat([before, bytes]))
      writes.push([sessionId, at])
      return true
    },
    async retire(sessionId) {
      retired.push(sessionId)
      return retireOut(sessionId)
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
    writes,
    retired,
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
        mkdirSync(join(dir, 'own', c.project), { recursive: true })
        writeFileSync(own(c.project, c.sessionId), text)
      }
      return c
    },
    text: (c) => (c.project ? textAt(own(c.project, c.sessionId)) : ''),
    view: (c) => (c.project ? textAt(viewed(c.project, c.sessionId)) : ''),
    extend(c, more) {
      writeFileSync(own(c.project as string, c.sessionId), self.text(c) + more)
    },
    setRetire: (f) => {
      retireOut = f
    },
  }
  return self
}

/** A pass far enough after the last one that a chat still growing is sent, not held back. */
const pastHold = () => Date.now() + CHAT_PUSH_EVERY_MS

const rowFor = async (id: string) =>
  (await store('GET', '/v1/chats')).json.chats.find((r: { id: string }) => r.id === id)

test('a chat A started reaches B’s viewer with its transcript and origin, and never B’s chat list', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n{"n":2}\n')
  await syncChats(a.io)
  await syncChats(b.io)

  expect(b.view(chat)).toBe(a.text(chat))
  expect(b.text(chat)).toBe('')
  expect(b.chats).toEqual([])
  const row = chatSyncRows(b.io.statePath).find((r) => r.id === chat.id) as ChatSyncRow
  expect(row).toMatchObject({ id: chat.id, fromHere: false, state: 'synced', title: 'A chat' })
  expect(row.origin).toEqual({ pc: a.io.pc, name: 'PC-A' })
  expect(chatsFromElsewhere(b.io.statePath).get(chat.sessionId)).toEqual({
    pc: 'PC-A',
    title: 'A chat',
    archived: false,
  })
  expect(chatSyncRows(a.io.statePath).find((r) => r.id === chat.id)).toMatchObject({
    fromHere: true,
  })

  // B is in step: a further pass changes nothing and never shares it from B.
  const version = (await rowFor(chat.id)).version
  await syncChats(b.io)
  expect((await rowFor(chat.id)).version).toBe(version)
  expect(b.writes.filter(([s]) => s === chat.sessionId)).toHaveLength(1)
})

test('A appends turns and B fetches only the new chunks, writing at the length it had', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(b.writes.filter(([s]) => s === chat.sessionId).map(([, n]) => n)).toEqual([0])

  a.extend(chat, '{"n":2}\n{"n":3}\n')
  await syncChats(a.io, pastHold())
  await syncChats(b.io)

  expect(b.writes.filter(([s]) => s === chat.sessionId).map(([, n]) => n)).toEqual([0, 8])
  expect(b.view(chat)).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
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
  expect(chatsFromElsewhere(b.io.statePath).get(live.sessionId)?.archived).toBe(false)
  expect(chatsFromElsewhere(b.io.statePath).has(old.sessionId)).toBe(false)

  const mine = a.chats.find((c) => c.id === live.id) as LocalChat
  mine.archived = true
  await syncChats(a.io)
  await syncChats(b.io)
  expect(chatsFromElsewhere(b.io.statePath).get(live.sessionId)?.archived).toBe(true)

  // Three days on, it leaves the store with its transcript; neither PC lists it, B's viewer keeps
  // its copy as A's, and unarchiving it does not send it again.
  const later = Date.now() + ARCHIVED_KEEP_MS + 3600_000
  await syncChats(a.io, later)
  expect(await rowFor(live.id)).toBeUndefined()
  expect((await store('GET', `/v1/chats/${live.sessionId}/chunks`)).json.chunks).toEqual([])
  await syncChats(b.io, later)
  expect(chatSyncRows(a.io.statePath).some((r) => r.id === live.id)).toBe(false)
  expect(chatSyncRows(b.io.statePath).some((r) => r.id === live.id)).toBe(false)
  expect(b.view(live)).toBe('{"n":1}\n')
  expect(chatsFromElsewhere(b.io.statePath).get(live.sessionId)?.pc).toBe('PC-A')
  mine.archived = false
  await syncChats(a.io, later)
  expect(await rowFor(live.id)).toBeUndefined()
})

test('a chat held back (a Hydra Desk chat idle over a week) never goes up first; a shared one it marks still sends its rename', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const idle = a.add({ holdBack: true }, '{"n":1}\n')
  const live = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(await rowFor(idle.id)).toBeUndefined()
  expect(chatsFromElsewhere(b.io.statePath).has(idle.sessionId)).toBe(false)
  expect(chatsFromElsewhere(b.io.statePath).get(live.sessionId)?.title).toBe('A chat')

  Object.assign(a.chats.find((c) => c.id === live.id) as LocalChat, {
    holdBack: true,
    record: { title: 'Renamed' },
  })
  await syncChats(a.io, pastHold())
  await syncChats(b.io)
  expect(chatsFromElsewhere(b.io.statePath).get(live.sessionId)?.title).toBe('Renamed')
})

test('a copy of A’s chat in B’s chat list never goes up from B, however it grows', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  const shared = await rowFor(chat.id)

  // The two-way sync put A's chat into B's chat list under its own record id, and someone on B went
  // on in it: B's passes leave A's chat as A sent it, and A takes nothing.
  b.add({ id: chat.id, sessionId: chat.sessionId }, '{"n":1}\n{"b":1}\n')
  await syncChats(b.io, pastHold())
  await syncChats(b.io, pastHold() + CHAT_PUSH_EVERY_MS)
  expect(await rowFor(chat.id)).toMatchObject({ version: shared.version, meta: { b: 8 } })
  await syncChats(a.io, pastHold())
  expect(a.text(chat)).toBe('{"n":1}\n')
  expect(a.writes.some(([s]) => s === chat.sessionId)).toBe(false)
})

test('A’s chat another PC wrote into under the two-way sync goes up again from A’s transcript', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const diverged = a.add({}, '{"d":1}\n')
  const written = a.add({}, '{"w":1}\n')
  await syncChats(a.io)

  // `diverged` was continued on both PCs, and a PC still on that version appended its own turn to
  // `written` and moved its row on.
  const s = JSON.parse(readFileSync(a.io.statePath, 'utf8'))
  s.chats[diverged.id].state = 'diverged'
  writeFileSync(a.io.statePath, JSON.stringify(s))
  const row = (await store('GET', `/v1/chats/${written.id}`)).json
  await store('PUT', `/v1/chats/${written.sessionId}/chunks/1`, { blob: 'x', by: 'elsewhere' })
  await store('PUT', `/v1/chats/${written.id}`, {
    version: row.version,
    blob: row.blob,
    meta: { ...row.meta, b: 99 },
  })

  a.extend(diverged, '{"d":2}\n')
  a.extend(written, '{"w":2}\n')
  await syncChats(a.io, pastHold())
  await syncChats(b.io)
  for (const c of [diverged, written]) {
    expect(b.view(c)).toBe(a.text(c))
    expect((await rowFor(c.id)).meta.b).toBe(16)
    expect(chatSyncRows(a.io.statePath).find((r) => r.id === c.id)?.state).toBe('synced')
  }
})

test('chats an earlier version took into B’s ~/.claude are taken out once, and the viewer holds them', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const moved = a.add({}, '{"m":1}\n')
  const kept = a.add({}, '{"k":1}\n')
  await syncChats(a.io)
  await syncChats(b.io)
  // As the two-way sync left B's state: no chat marked as being in the viewer.
  const s = JSON.parse(readFileSync(b.io.statePath, 'utf8'))
  for (const c of Object.values<{ viewer?: boolean }>(s.chats)) delete c.viewer
  writeFileSync(b.io.statePath, JSON.stringify(s))
  b.writes.length = 0

  // The first try is refused (the app did not confirm the archive): it waits and is tried again.
  b.setRetire(() => ({ ok: false, reason: 'the archive was not confirmed', retry: true }))
  await syncChats(b.io)
  expect(chatSyncRows(b.io.statePath).find((r) => r.id === moved.id)).toMatchObject({
    state: 'waiting',
    note: 'the archive was not confirmed',
  })

  // Someone on B went on in `kept`, so it stays in B's chat list and the viewer starts its own copy.
  b.setRetire((id) => ({ ok: true, kept: id === kept.sessionId }))
  await syncChats(b.io)
  await syncChats(b.io)
  expect(b.retired.filter((id) => id === moved.sessionId)).toHaveLength(2)
  expect(b.retired.filter((id) => id === kept.sessionId)).toHaveLength(2)
  expect(b.writes).toEqual([[kept.sessionId, 0]])
  expect(b.view(kept)).toBe('{"k":1}\n')
  for (const c of [moved, kept])
    expect(chatSyncRows(b.io.statePath).find((r) => r.id === c.id)?.state).toBe('synced')
})

test('a last line with no newline yet is not sent until it ends', async () => {
  const a = pc('PC-A')
  const b = pc('PC-B')
  const chat = a.add({}, '{"n":1}\n{"n":2')
  await syncChats(a.io)
  await syncChats(b.io)
  expect(b.view(chat)).toBe('{"n":1}\n')

  a.extend(chat, '}\n')
  await syncChats(a.io, pastHold())
  await syncChats(b.io)
  expect(b.view(chat)).toBe('{"n":1}\n{"n":2}\n')
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
  expect(other.writes).toEqual([])
  expect(other.view(chat)).toBe('')
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
