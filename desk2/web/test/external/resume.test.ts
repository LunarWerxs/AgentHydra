import { describe, expect, test } from 'bun:test'
import type { AccountInfo, ExternalSession, ServerEvent, TranscriptItem } from '@shared/protocol'
import { externalChat, externalChatId, isExternalChatId, resumable, sessionOfChatId, whereLabel } from '../../src/components/external/logic'
import { draftImages } from '../../src/components/composer/draft-images'

const session = (over: Partial<ExternalSession> = {}): ExternalSession => ({
  id: 's1',
  title: 'Level editor export bug',
  cwd: 'C:/work/alpha',
  source: 'desktop',
  instance: 'eek',
  status: 'idle',
  activity: null,
  lastActivityAt: 1_000,
  model: 'claude-opus-5-5',
  accountId: null,
  canResume: true,
  fromPc: null,
  pinned: false,
  archived: false,
  unread: false,
  group: null,
  ...over
})

const account = (id: string, number: number): AccountInfo => ({
  id,
  label: `#${number} · Max 20x`,
  configDir: `C:/cli/${id}`,
  number,
  email: null,
  plan: 'Max 20x',
  signedIn: true,
  fiveHourPct: null,
  weeklyPct: null,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false
})

describe('the stand-in chat of a resumable outside session', () => {
  test('ids round-trip and never collide with a chat id', () => {
    expect(externalChatId('s1')).toBe('ext:s1')
    expect(isExternalChatId('ext:s1')).toBe(true)
    expect(isExternalChatId('5b2c-uuid')).toBe(false)
    expect(sessionOfChatId('ext:s1')).toBe('s1')
  })

  test('closed, on its account, with what was changed before the first message', () => {
    const c = externalChat(session({ accountId: 'cli-7' }), [account('cli-7', 7)], { model: 'claude-sonnet-5-5', permissionMode: 'plan' })
    expect(c).toMatchObject({ id: 'ext:s1', sessionId: 's1', status: 'closed', model: 'claude-sonnet-5-5', permissionMode: 'plan', cwd: 'C:/work/alpha' })
    expect(c.account).toEqual({ id: 'cli-7', label: '#7 · Max 20x', configDir: 'C:/cli/cli-7', number: 7 })
    expect(externalChat(session(), []).account).toEqual({ id: 'default', label: 'Default', configDir: null })
    expect(externalChat(session(), []).model).toBe('claude-opus-5-5')
  })

  test('a session no CLI instance holds shows the account it lands on, unless another is picked in the composer', () => {
    const landing = { id: 'cli-9', label: '#9 · Pro', configDir: 'C:/cli/cli-9', number: 9 }
    expect(externalChat(session(), [account('cli-7', 7)], {}, landing).account).toEqual(landing)
    expect(externalChat(session(), [account('cli-7', 7)], { accountId: 'cli-7' }, landing).account.id).toBe('cli-7')
    expect(externalChat(session(), [account('cli-7', 7)], { accountId: 'auto' }, landing).account).toEqual(landing)
    expect(externalChat(session({ accountId: 'cli-7' }), [account('cli-7', 7)], {}, landing).account.id).toBe('cli-7')
  })

  test('resumable: a desktop or terminal session, whatever account holds it', () => {
    expect(resumable(session())).toBe(true)
    expect(resumable(session({ source: 'cli' }))).toBe(true)
    expect(resumable(session({ source: 'climayte', accountId: 'cli-7' }))).toBe(false)
    expect(resumable(session({ source: 'codex' }))).toBe(false)
  })

  test('labels', () => {
    expect(whereLabel(session())).toBe('Claude Desktop (eek)')
    expect(whereLabel(session({ source: 'cli', instance: null }))).toBe('Claude Code CLI')
  })
})

// The store, on a fake socket and fetch.
const calls: { path: string; method: string; body: unknown }[] = []
let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
const g = globalThis as Record<string, unknown>
g.document ??= { title: 'Hydra Desk', hidden: false, createElement: () => ({}) } // vue's runtime-dom makes a <template> when it loads
g.window ??= { location: { protocol: 'http:', host: 'localhost:7801' }, addEventListener() {}, dispatchEvent() {}, focus() {} }
g.location ??= { protocol: 'http:', host: 'localhost:7801' }
g.Notification ??= { permission: 'denied', requestPermission() {} }
g.WebSocket = class {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor() {
    socket = this
  }
  close() {}
}
g.fetch = async (path: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
  const out =
    path === '/api/chats/import'
      ? { id: 'new-1' }
      : path === '/api/accounts/pick'
        ? { id: 'cli-9', label: '#9 · Pro', configDir: 'C:/cli/cli-9', number: 9 }
        : path.endsWith('/messages')
          ? { queued: false }
          : path.endsWith('/fork')
            ? { id: 'fork-1' }
            : path.endsWith('/meta')
              ? { title: 'Renamed here', pinned: true, archived: false, unread: false, group: 'Ops' }
              : path.endsWith('/items')
                ? []
                : { ok: true }
  return new Response(JSON.stringify(out), { status: 200 })
}
const { useDesk } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })

describe('the first message imports the session and resumes it', () => {
  test('imports under the account folder, applies the early change, sends and opens the chat', async () => {
    push({ type: 'accounts.update', accounts: [account('cli-7', 7)] })
    push({ type: 'external.update', sessions: [session({ id: 'r1', accountId: 'cli-7', source: 'cli' })] })
    const changed = await desk.updateChat('ext:r1', { model: 'claude-sonnet-5-5' })
    expect(changed.model).toBe('claude-sonnet-5-5')
    expect(desk.externalPatch('r1')).toEqual({ model: 'claude-sonnet-5-5' })
    calls.length = 0

    await desk.send('ext:r1', { text: 'carry on' })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/chats/import', 'GET /api/chats/new-1/items', 'PATCH /api/chats/new-1', 'POST /api/chats/new-1/messages'])
    expect(calls[0]!.body).toEqual({ sessionId: 'r1', cwd: 'C:/work/alpha', title: 'Level editor export bug', configDir: 'C:/cli/cli-7' })
    expect(calls[2]!.body).toEqual({ model: 'claude-sonnet-5-5' })
    expect(calls[3]!.body).toEqual({ text: 'carry on' })
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'new-1' })
    expect(desk.externalPatch('r1')).toEqual({})
  })

  test('a session no CLI instance holds shows where it lands, but the server places it at the import (fresh, and Auto stays Auto)', async () => {
    push({ type: 'external.update', sessions: [session({ id: 'd1' })] })
    await desk.ensureLanding('d1')
    expect(desk.landingOf('d1')).toMatchObject({ id: 'cli-9', configDir: 'C:/cli/cli-9' })
    expect(desk.standInOf('d1')?.account).toMatchObject({ id: 'cli-9' })
    calls.length = 0
    await desk.send('ext:d1', { text: 'hi' })
    expect(calls[0]!.body).toEqual({ sessionId: 'd1', cwd: 'C:/work/alpha', title: 'Level editor export bug' })
    expect(calls.map((c) => c.path)).toEqual(['/api/chats/import', '/api/chats/new-1/items', '/api/chats/new-1/messages'])
  })

  test('an account picked in the title bar is where it continues: the import names its folder', async () => {
    push({ type: 'accounts.update', accounts: [account('cli-7', 7), account('cli-8', 8)] })
    push({ type: 'external.update', sessions: [session({ id: 'p1', accountId: 'cli-7' })] })
    expect(desk.standInOf('p1')?.account.id).toBe('cli-7')
    await desk.updateChat('ext:p1', { accountId: 'cli-8' })
    expect(desk.standInOf('p1')?.account.id).toBe('cli-8')
    calls.length = 0
    await desk.send('ext:p1', { text: 'over there' })
    expect(calls[0]!.body).toMatchObject({ sessionId: 'p1', configDir: 'C:/cli/cli-8' })
    expect(calls.map((c) => c.path)).toEqual(['/api/chats/import', '/api/chats/new-1/items', '/api/chats/new-1', '/api/chats/new-1/messages'])
  })

  test('a refused send still opens the imported chat, the message kept as its draft to send again', async () => {
    push({ type: 'external.update', sessions: [session({ id: 'x1' })] })
    const drafts = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => drafts.get(k) ?? null, setItem: (k: string, v: string) => void drafts.set(k, v), removeItem: (k: string) => void drafts.delete(k) }
    const ok = g.fetch as (path: string, init?: RequestInit) => Promise<Response>
    const why = 'No folder on this machine has session x1, so it cannot be resumed.'
    // The server wrote its refusal into the transcript too.
    const serverLine = { kind: 'system', id: 'seed:1', ts: 1, level: 'warn', text: why }
    g.fetch = async (path: string, init?: RequestInit) =>
      path.endsWith('/messages')
        ? new Response(JSON.stringify({ error: why }), { status: 409 })
        : path.endsWith('/items')
          ? new Response(JSON.stringify([serverLine]), { status: 200 })
          : ok(path, init)
    try {
      desk.select({ kind: 'external', id: 'x1' })
      // the server's sentence, not its JSON body
      await expect(desk.send('ext:x1', { text: 'carry on' })).rejects.toThrow(new Error(why))
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'new-1' })
      expect(drafts.get('hydra-desk:draft:new-1')).toBe('carry on')
      // said once: the window adds no second line for what the server's line already says
      expect(await desk.loadItems('new-1')).toEqual([serverLine as TranscriptItem])
    } finally {
      g.fetch = ok
      delete g.localStorage
    }
  })

  test("a refusal only the window saw is written into the new chat's transcript, the dropped images named", async () => {
    push({ type: 'external.update', sessions: [session({ id: 'x2' })] })
    const ok = g.fetch as (path: string, init?: RequestInit) => Promise<Response>
    const why = '#7 is signed out: sign it in again or pick another account.'
    const earlier = { kind: 'user', id: 'u1', ts: 1, text: 'from Desktop' }
    g.fetch = async (path: string, init?: RequestInit) =>
      path === '/api/chats/import'
        ? new Response(JSON.stringify({ id: 'new-2' }), { status: 200 })
        : path.endsWith('/messages')
          ? new Response(JSON.stringify({ error: why }), { status: 409 })
          : path.endsWith('/items')
            ? new Response(JSON.stringify([earlier]), { status: 200 })
            : ok(path, init)
    try {
      const image = { mediaType: 'image/png', dataBase64: 'AAAA', name: 'shot.png' }
      await expect(desk.send('ext:x2', { text: 'carry on', images: [image, image] })).rejects.toThrow(new Error(why))
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'new-2' })
      // the chat's history loads from the server and keeps the window's line after it
      const items = await desk.loadItems('new-2')
      expect(items[0]).toEqual(earlier as TranscriptItem)
      expect(items[1]).toMatchObject({
        kind: 'system',
        level: 'warn',
        text: `Not sent: ${why} Your message is back in the box. The 2 attached images were dropped: attach them again.`
      })
      expect(items).toHaveLength(2)
    } finally {
      g.fetch = ok
    }
  })

  test('only a session the composer can carry on now has a stand-in', () => {
    push({ type: 'external.update', sessions: [session({ id: 'busy', status: 'working', canResume: false }), session({ id: 'cdx', source: 'codex', canResume: false })] })
    expect(desk.standInOf('busy')).toBeNull()
    expect(desk.standInOf('cdx')).toBeNull()
  })

  test('a session working there is refused before anything is sent', async () => {
    push({ type: 'external.update', sessions: [session({ id: 'w1', status: 'working', canResume: false })] })
    calls.length = 0
    await expect(desk.send('ext:w1', { text: 'x' })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('the row menu through the store', () => {
  test('Fork of an outside session takes the same import path as a fork, even while it works there, and opens it', async () => {
    push({ type: 'accounts.update', accounts: [account('cli-7', 7)] })
    push({ type: 'external.update', sessions: [session({ id: 'f1', accountId: 'cli-7', status: 'working', canResume: false })] })
    calls.length = 0
    await desk.forkExternal('f1')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/chats/import'])
    expect(calls[0]!.body).toEqual({ sessionId: 'f1', cwd: 'C:/work/alpha', title: 'Level editor export bug', configDir: 'C:/cli/cli-7', fork: true })
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'new-1' })
  })

  test('Fork of a chat posts to its fork route and opens the new chat', async () => {
    calls.length = 0
    await desk.forkChat('c1')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/chats/c1/fork'])
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'fork-1' })
  })

  test("Fork at a message of a chat sends that message's id and opens the new chat with the message waiting in its box", async () => {
    const drafts = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => drafts.get(k) ?? null, setItem: (k: string, v: string) => void drafts.set(k, v), removeItem: (k: string) => void drafts.delete(k) }
    try {
      const picture = { id: 'p1', name: 'shot.png', mediaType: 'image/png', dataBase64: 'AAAA', url: 'data:image/png;base64,AAAA' }
      calls.length = 0
      await desk.forkAt('c1', 'u-7:0', { text: 'try the other way', images: [picture] })
      expect(calls).toEqual([{ path: '/api/chats/c1/fork', method: 'POST', body: { at: 'u-7:0' } }])
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'fork-1' })
      expect(drafts.get('hydra-desk:draft:fork-1')).toBe('try the other way')
      expect(draftImages('fork-1')).toEqual([picture])
    } finally {
      delete g.localStorage
    }
  })

  test('Fork at a message of an outside session imports it as a fork cut there, by its session id or its stand-in id', async () => {
    push({ type: 'accounts.update', accounts: [account('cli-7', 7)] })
    push({ type: 'external.update', sessions: [session({ id: 'f2', accountId: 'cli-7' })] })
    for (const id of ['f2', 'ext:f2']) {
      calls.length = 0
      await desk.forkAt(id, 'u-3:0', { text: 'again from here' })
      expect(calls).toEqual([
        {
          path: '/api/chats/import',
          method: 'POST',
          body: { sessionId: 'f2', cwd: 'C:/work/alpha', title: 'Level editor export bug', configDir: 'C:/cli/cli-7', fork: true, at: 'u-3:0' }
        }
      ])
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'new-1' })
    }
    await expect(desk.forkAt('ext:gone', 'u-1:0', { text: 'x' })).rejects.toThrow('This session is no longer listed.')
  })

  test('Send now on a queued message posts its id to the send-now route', async () => {
    calls.length = 0
    await desk.sendNow('c1', 'u-9:0')
    await desk.sendNow('c1')
    expect(calls).toEqual([
      { path: '/api/chats/c1/send-now', method: 'POST', body: { itemId: 'u-9:0' } },
      { path: '/api/chats/c1/send-now', method: 'POST', body: {} }
    ])
  })

  test("an outside session's marks go to its meta route and show at once", async () => {
    push({ type: 'external.update', sessions: [session({ id: 'm1' })] })
    calls.length = 0
    await desk.updateSessionMeta('m1', { pinned: true, group: 'Ops', title: 'Renamed here' })
    expect(calls).toEqual([{ path: '/api/external/sessions/m1/meta', method: 'PATCH', body: { pinned: true, group: 'Ops', title: 'Renamed here' } }])
    expect(desk.external.value.find((s) => s.id === 'm1')).toMatchObject({ title: 'Renamed here', pinned: true, group: 'Ops', archived: false })
  })
})
