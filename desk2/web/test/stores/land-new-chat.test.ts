import { describe, expect, test } from 'bun:test'
import type { ChatSummary, ServerEvent } from '@shared/protocol'
import { groupChats } from '../../src/components/sidebar/logic'

// A chat started from the New session screen is listed and opened the moment the POST answers,
// whether or not the socket's chat.upsert came first. The store runs on a fake socket and fetch.
function summary(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: null,
    title: `Chat ${id}`,
    cwd: 'C:/work/land',
    account: { id: 'default', label: 'Default', configDir: null },
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    status: 'starting',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    createdAt: 2_000,
    updatedAt: 2_000,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over
  } as ChatSummary
}

let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
let nextCreated: ChatSummary = summary('none')
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
g.fetch = async (path: string, init?: RequestInit) => {
  const out = path === '/api/chats' && init?.method === 'POST' ? nextCreated : { ok: true }
  return new Response(JSON.stringify(out), { status: 200 })
}
const { useDesk } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })
const ids = (prefix: string) => desk.chats.value.filter((c) => c.id.startsWith(prefix)).map((c) => c.id)

describe('a chat started from the New session screen lands', () => {
  test('it is listed and selected as soon as the server answers, before any chat.upsert', async () => {
    push({ type: 'chat.upsert', chat: summary('land-old', { status: 'idle', updatedAt: 1_000 }) })
    desk.select({ kind: 'new' })
    nextCreated = summary('land-new')
    const created = await desk.createChat({ cwd: 'C:/work/land', prompt: 'hello' })
    expect(created?.id).toBe('land-new')
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'land-new' })
    expect(ids('land-')).toEqual(['land-old', 'land-new'])
    // ...as the first row of its folder group.
    const group = groupChats(desk.chats.value.filter((c) => c.id.startsWith('land-'))).folders[0]!
    expect(group.entries.map((e) => e.id)).toEqual(['land-new', 'land-old'])
  })

  test('the socket summary that arrives afterwards replaces it, no second row', () => {
    push({ type: 'chat.upsert', chat: summary('land-new', { status: 'working' }) })
    expect(ids('land-new')).toEqual(['land-new'])
    expect(desk.chats.value.find((c) => c.id === 'land-new')!.status).toBe('working')
  })

  test('a summary the socket delivered first is newer and is kept', async () => {
    push({ type: 'chat.upsert', chat: summary('land-fast', { status: 'working' }) })
    nextCreated = summary('land-fast', { status: 'starting' })
    await desk.createChat({ cwd: 'C:/work/land', prompt: 'hi' })
    expect(ids('land-fast')).toEqual(['land-fast'])
    expect(desk.chats.value.find((c) => c.id === 'land-fast')!.status).toBe('working')
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'land-fast' })
  })
})
