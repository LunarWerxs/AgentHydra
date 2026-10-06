import { describe, expect, test } from 'bun:test'
import type { ChatSummary, ServerEvent, TranscriptItem } from '@shared/protocol'
import { wantsDesktopNotice } from '../../src/stores/notify'

// A socket reconnect (hello) clears the items cache: the chat open in the window is fetched again, so its
// history and a docked request come back without switching chats. The store runs on a fake socket and fetch.
function summary(id: string): ChatSummary {
  return {
    id,
    sessionId: null,
    title: `Chat ${id}`,
    cwd: 'C:/work/reconnect',
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: false,
    status: 'needs_you',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 1,
    costUsd: 0,
    contextPct: null,
    pendingCount: 1,
    queuedCount: 0,
    climayteActive: 0,
  }
}

const OPEN: TranscriptItem[] = [
  { kind: 'user', id: 'u1', ts: 1, text: 'push it' },
  { kind: 'permission', id: 'p1', ts: 2, toolName: 'Bash', input: { command: 'git push' }, canAlwaysAllow: false, state: 'pending' },
]

let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
const fetched: string[] = []
const g = globalThis as Record<string, unknown>
g.document ??= { title: 'Hydra Desk', hidden: false, createElement: () => ({}) } // vue's runtime-dom makes a template element on load
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
// rc-late's items answer only when the test lets them, as a slow GET does.
const late: { release?: () => void } = {}
// A path here fails that many more times as a stopped server does: nothing answers.
const down = new Map<string, number>()
g.fetch = async (path: string) => {
  if (path.startsWith('/api/chats/')) fetched.push(path)
  if (path === '/api/chats/rc-late/items') await new Promise<void>((r) => (late.release = r))
  const fails = down.get(path) ?? 0
  if (fails > 0) {
    down.set(path, fails - 1)
    throw new TypeError('Failed to fetch')
  }
  const out = ['/api/chats/rc-open/items', '/api/chats/rc-late/items', '/api/chats/rc-down/items', '/api/chats/rc-shut/items'].includes(path) ? OPEN : { ok: true }
  return new Response(JSON.stringify(out), { status: 200 })
}
const { useDesk, RELOAD_WAITS_MS } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })
const hello = (chats: ChatSummary[]): ServerEvent => ({
  type: 'hello',
  version: 'test',
  chats,
  settings: { defaultModel: null, defaultEffort: null, defaultPermissionMode: 'bypassPermissions', defaultAccountId: 'auto', delegateToCliMayte: false, idleCloseMinutes: 30, notifications: true },
})

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('a reconnect keeps the open chat', () => {
  test('hello reloads the items of the selected chat only', async () => {
    desk.select({ kind: 'chat', id: 'rc-open' })
    fetched.length = 0
    push(hello([summary('rc-open'), summary('rc-other')]))
    await until(() => desk.itemsByChat.value.has('rc-open'))
    expect(desk.itemsByChat.value.get('rc-open')?.map((i) => i.id)).toEqual(['u1', 'p1'])
    expect(fetched).toEqual(['/api/chats/rc-open/items'])
  })

  test('a selected chat the server no longer lists is not fetched', async () => {
    desk.select({ kind: 'chat', id: 'rc-gone' })
    fetched.length = 0
    push(hello([summary('rc-other')]))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetched).toEqual([])
  })

  test('what streams in while the reload is out is newer than its snapshot, and kept', async () => {
    desk.select({ kind: 'chat', id: 'rc-late' })
    push(hello([summary('rc-late')]))
    await until(() => !!late.release)
    // A request opens, and p1 is answered, before the GET's (older) answer arrives.
    const p2: TranscriptItem = { kind: 'permission', id: 'p2', ts: 3, toolName: 'Bash', input: { command: 'rm -rf dist' }, canAlwaysAllow: false, state: 'pending' }
    push({ type: 'item.upsert', chatId: 'rc-late', item: p2 })
    push({ type: 'item.upsert', chatId: 'rc-late', item: { ...OPEN[1]!, state: 'allowed' } as TranscriptItem })
    late.release!()
    await until(() => desk.itemsByChat.value.get('rc-late')?.length === 3)
    const items = desk.itemsByChat.value.get('rc-late') ?? []
    expect(items.map((i) => i.id)).toEqual(['u1', 'p1', 'p2'])
    expect(items.map((i) => (i.kind === 'permission' ? i.state : null))).toEqual([null, 'allowed', 'pending'])
  })
})

describe('a chat whose history does not load', () => {
  // 2026-10-05: after a server restart chats sat on "No messages yet" with their history on disk.
  RELOAD_WAITS_MS.splice(0, RELOAD_WAITS_MS.length, 5)
  const said = "This window's server is not answering (it may be restarting)"

  test('after a reconnect it is asked for again until it lands, with why it is missing meanwhile', async () => {
    down.set('/api/chats/rc-down/items', 2)
    desk.select({ kind: 'chat', id: 'rc-down' })
    fetched.length = 0
    push(hello([summary('rc-down')]))
    await until(() => desk.itemsError.value.has('rc-down'))
    expect(desk.itemsError.value.get('rc-down')).toBe(said)
    expect(desk.itemsByChat.value.has('rc-down')).toBe(false)
    await until(() => desk.itemsByChat.value.has('rc-down'))
    expect(desk.itemsByChat.value.get('rc-down')?.map((i) => i.id)).toEqual(['u1', 'p1'])
    expect(desk.itemsError.value.has('rc-down')).toBe(false)
    expect(fetched).toEqual(Array(3).fill('/api/chats/rc-down/items'))
  })

  test('opened while the server is down, it loads once the server answers', async () => {
    push(hello([summary('rc-shut')]))
    desk.select({ kind: 'chat', id: 'rc-shut' })
    down.set('/api/chats/rc-shut/items', 1)
    await expect(desk.loadItems('rc-shut')).rejects.toThrow(said)
    await until(() => desk.itemsByChat.value.has('rc-shut'))
    expect(desk.itemsByChat.value.get('rc-shut')?.map((i) => i.id)).toEqual(['u1', 'p1'])
  })
})

describe('a chat that streams before it is opened', () => {
  test('its history still loads when it is opened, with what streamed kept', async () => {
    desk.select({ kind: 'chat', id: 'rc-gone' })
    push(hello([summary('rc-open')]))
    const a1: TranscriptItem = { kind: 'assistant_text', id: 'a1', ts: 5, text: 'Running a command' }
    push({ type: 'item.upsert', chatId: 'rc-open', item: a1 })
    // Not a cached transcript yet: the window's open-chat check (has) still loads the history.
    expect(desk.itemsByChat.value.has('rc-open')).toBe(false)
    const items = await desk.loadItems('rc-open')
    expect(items.map((i) => i.id)).toEqual(['u1', 'p1', 'a1'])
  })
})

describe('the window title', () => {
  // Desk 2 runs beside Desk: its window says which it is (index.html carries the name until the first report).
  test('names Desk 2, with how many chats are working', async () => {
    document.title = ''
    push(hello([{ ...summary('rc-title'), status: 'working' }]))
    await until(() => document.title !== '')
    expect(document.title).toBe('(1 working) AgentHydra')
  })
})

describe('wantsDesktopNotice', () => {
  test('the Settings switch turns desktop notifications off', () => {
    expect(wantsDesktopNotice({ enabled: false, hidden: true, viewing: false })).toBe(false)
    expect(wantsDesktopNotice({ enabled: true, hidden: true, viewing: true })).toBe(true)
    expect(wantsDesktopNotice({ enabled: undefined, hidden: false, viewing: false })).toBe(true)
  })

  test('the chat already in front of the owner does not notify', () => {
    expect(wantsDesktopNotice({ enabled: true, hidden: false, viewing: true })).toBe(false)
  })
})
