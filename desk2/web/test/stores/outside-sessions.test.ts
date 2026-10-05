import { describe, expect, test } from 'bun:test'
import type { ExternalSession, SearchHit, ServerEvent } from '@shared/protocol'

// An outside session older than the list's 24 hours (a search hit) is fetched on its own, and a newer
// search cancels the one in flight. The store runs on a fake socket; each test sets its own fetch.
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

const hit = (sessionId: string): SearchHit => ({
  sessionId,
  title: 'Flaky websocket test',
  cwd: 'C:/work/alpha',
  snippet: '…the websocket test times out…',
  source: 'cli',
  lastActivityAt: 1_000,
  score: 1
})

let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
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
g.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const { useDesk } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })
const listed = (prefix: string) => desk.external.value.filter((s) => s.id.startsWith(prefix))

describe('an outside session the list does not carry', () => {
  test('is fetched once by its encoded id and listed after the list', async () => {
    push({ type: 'external.update', sessions: [session({ id: 'old-listed' })] })
    const paths: string[] = []
    g.fetch = async (path: string) => {
      paths.push(path)
      return new Response(JSON.stringify(session({ id: 'old/3d', title: 'Three days ago' })), { status: 200 })
    }
    await desk.ensureExternal('old/3d')
    expect(paths).toEqual(['/api/external/sessions/old%2F3d'])
    expect(listed('old').map((s) => [s.id, s.title])).toEqual([
      ['old-listed', 'Level editor export bug'],
      ['old/3d', 'Three days ago']
    ])
    // Known now, and a listed one never needed it: no second request.
    await desk.ensureExternal('old/3d')
    await desk.ensureExternal('old-listed')
    expect(paths).toHaveLength(1)
  })

  test('the list wins once it carries the session too', () => {
    push({ type: 'external.update', sessions: [session({ id: 'old/3d', title: 'Listed now' })] })
    expect(listed('old').map((s) => [s.id, s.title])).toEqual([['old/3d', 'Listed now']])
  })

  test("AgentHydra's 404 rejects and lists nothing", async () => {
    g.fetch = async () => new Response(JSON.stringify({ error: 'unknown session' }), { status: 404 })
    await expect(desk.ensureExternal('gone-1')).rejects.toThrow()
    expect(listed('gone')).toEqual([])
  })

  test('its marks (the unread clear on opening) and its first message reach it like a listed one', async () => {
    push({ type: 'external.update', sessions: [] })
    const earlier = { kind: 'user', id: 'u-earlier', ts: 500, text: 'the turn run in Claude Desktop' }
    const calls: string[] = []
    g.fetch = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      const out = path.endsWith('/meta')
        ? { title: null, pinned: false, archived: false, unread: false, group: null }
        : path === '/api/accounts/pick'
          ? { id: 'cli-9', label: '#9 · Pro', configDir: 'C:/cli/cli-9', number: 9 }
          : path === '/api/chats/import'
            ? { id: 'imported-1' }
            : path.endsWith('/messages')
              ? { queued: false }
              : path === '/api/chats/imported-1/items'
                ? [earlier]
                : session({ id: 'aged-1', unread: true })
      return new Response(JSON.stringify(out), { status: 200 })
    }
    await desk.ensureExternal('aged-1')
    expect(listed('aged-1')[0]!.unread).toBe(true)
    await desk.updateSessionMeta('aged-1', { unread: false })
    expect(listed('aged-1')[0]!.unread).toBe(false)
    calls.length = 0
    await desk.send('ext:aged-1', { text: 'carry on' })
    // No instance holds it and none was picked: the server places it at the import.
    // Its history is fetched before the send, so the chat opens on the whole conversation, not the new lines alone.
    expect(calls).toEqual(['POST /api/chats/import', 'GET /api/chats/imported-1/items', 'POST /api/chats/imported-1/messages'])
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'imported-1' })
    expect(desk.itemsByChat.value.get('imported-1')?.map((i) => i.id)).toEqual(['u-earlier'])
  })
})

describe('a newer search supersedes the one in flight', () => {
  // A fetch that answers only when told to, recording each request's signal.
  function slowFetch() {
    const signals: AbortSignal[] = []
    const answer: ((hits: SearchHit[]) => void)[] = []
    g.fetch = (_path: string, init?: RequestInit) => {
      signals.push(init!.signal!)
      return new Promise<Response>((resolve) => answer.push((hits) => resolve(new Response(JSON.stringify(hits), { status: 200 }))))
    }
    return { signals, answer }
  }
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error)

  test('the earlier request is aborted and its promise rejects with an AbortError; the newer one answers', async () => {
    const { signals, answer } = slowFetch()
    const first = desk.search('websocket')
    const second = desk.search('websocket test')
    const err = await failure(first)
    expect(err).toBeInstanceOf(Error)
    expect(err!.name).toBe('AbortError')
    expect(signals.map((s) => s.aborted)).toEqual([true, false])
    answer[1]!([hit('h1')])
    expect(await second).toEqual([hit('h1')])
  })

  test('a query too short to search cancels the one in flight and asks nothing', async () => {
    const { signals } = slowFetch()
    const first = desk.search('websocket')
    expect(await desk.search('w')).toEqual([])
    expect((await failure(first))!.name).toBe('AbortError')
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
  })

  test('a failure that was not superseded is still a SearchError', async () => {
    g.fetch = async () => new Response(JSON.stringify({ error: 'AgentHydra is not answering' }), { status: 503 })
    const err = await failure(desk.search('websocket'))
    expect(err!.name).toBe('SearchError')
    expect(err!.message).toBe('AgentHydra is not answering')
  })
})
