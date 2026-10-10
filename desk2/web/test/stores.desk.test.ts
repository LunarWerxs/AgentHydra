import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'bun:test'

// Mock DOM globals, for this file only: left behind, a `document` with no documentElement breaks the
// next file in the process that boots the i18n (hydra/src/i18n reads documentElement.lang).
// The hooks sit in the describe below: a file-level afterAll did not run before the next file loaded.
const mockedGlobals: string[] = []
const mockDomGlobals = () => {
  if (typeof document === 'undefined') {
    ;(global as any).document = {
      title: 'Hydra Desk',
      hidden: false
    }
    mockedGlobals.push('document')
  }
  if (typeof window === 'undefined') {
    ;(global as any).window = {
      location: {
        protocol: 'http:',
        host: 'localhost:4796'
      },
      addEventListener: vi.fn(),
      focus: vi.fn()
    }
    mockedGlobals.push('window')
  }
}
const unmockDomGlobals = () => {
  for (const name of mockedGlobals.splice(0)) delete (global as any)[name]
}
import { ref } from 'vue'
import { useDesk } from '@/stores/desk'
import type { ServerEvent, ChatSummary, TranscriptItem } from '@shared/protocol'

// Mock WebSocket
class MockWebSocket {
  // The real constants: the store compares readyState with WebSocket.OPEN and WebSocket.CONNECTING.
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: MockWebSocket | null = null
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.last = this
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 10)
  }

  send() {}
  close() {
    this.readyState = 3
    this.onclose?.()
  }

  simulateMessage(data: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

// Mock fetch
const mockFetch = vi.fn((path: string, init?: RequestInit) => {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, audible: [], muted: [], unattributed: [], unattributedMuted: false }), { status: 200 })
  )
})

describe('useDesk store', () => {
  let mockWs: MockWebSocket | null = null

  beforeAll(mockDomGlobals)
  afterAll(unmockDomGlobals)

  beforeEach(() => {
    // Mock global fetch and WebSocket
    ;(global as any).fetch = mockFetch
    ;(global as any).WebSocket = MockWebSocket
    ;(global as any).Notification = {
      permission: 'granted' as const,
      requestPermission: vi.fn()
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('initializes with empty state', () => {
    const desk = useDesk()
    expect(desk.chats.value).toEqual([])
    expect(desk.itemsByChat.value.size).toBe(0)
    expect(desk.external.value).toEqual([])
    expect(desk.workers.value).toEqual([])
  })

  it('handles hello event with chats and settings', async () => {
    const desk = useDesk()
    await desk.init()

    // Simulate a hello event
    const helloEvent: ServerEvent & { type: 'hello' } = {
      type: 'hello',
      version: '0.1.0',
      chats: [
        {
          id: 'chat-1',
          sessionId: 'session-1',
          title: 'Test Chat',
          cwd: '/test',
          account: { id: 'default', label: 'Default', configDir: null },
          accountAuto: false,
          model: null,
          effort: null,
          permissionMode: 'default',
          delegateToCliMayte: false,
          status: 'idle',
          activity: null,
          turnStartedAt: null,
          lastError: null,
          limitResetsAt: null,
          unread: false,
          pinned: false,
          archived: false,
          group: null,
          forkedFrom: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          costUsd: 0,
          contextPct: null,
          pendingCount: 0,
          queuedCount: 0,
          climayteActive: 0
        }
      ],
      settings: {
        defaultModel: null,
        defaultEffort: 'medium',
        defaultPermissionMode: 'acceptEdits',
        defaultAccountId: 'auto',
        delegateToCliMayte: true,
        idleCloseMinutes: 30,
        notifications: true,
        projectFolders: [],
        projectRoots: [],
        hiddenProjects: [],
        babysitter: true, orchestrator: false, orchestratorModel: 'opus'
      }
    }

    // Give the WebSocket time to connect and trigger hello
    await new Promise((resolve) => setTimeout(resolve, 20))
    MockWebSocket.last!.simulateMessage(helloEvent)
    expect(desk.chats.value.map((c) => c.id)).toEqual(['chat-1'])
    expect(desk.settings.value?.defaultEffort).toBe('medium')
  })

  it('updates items on upsert event', async () => {
    const desk = useDesk()
    await desk.init()

    const upsertEvent: ServerEvent = {
      type: 'item.upsert',
      chatId: 'chat-1',
      item: {
        id: 'item-1',
        ts: Date.now(),
        kind: 'user',
        text: 'Hello'
      } as TranscriptItem
    }

    desk.itemsByChat.value.set('chat-1', [])
    MockWebSocket.last!.simulateMessage(upsertEvent)
    expect(desk.itemsByChat.value.get('chat-1')).toEqual([expect.objectContaining({ id: 'item-1', text: 'Hello' })])
  })

  it('appends text on delta event', async () => {
    const desk = useDesk()
    await desk.init()

    // Initialize items
    desk.itemsByChat.value.set('chat-1', [
      {
        id: 'item-1',
        ts: Date.now(),
        kind: 'assistant_text',
        text: 'Hello'
      } as TranscriptItem
    ])

    // Simulate a delta event
    const deltaEvent: ServerEvent = {
      type: 'item.delta',
      chatId: 'chat-1',
      itemId: 'item-1',
      text: ' world'
    }

    MockWebSocket.last!.simulateMessage(deltaEvent)
    expect(desk.itemsByChat.value.get('chat-1')).toEqual([expect.objectContaining({ id: 'item-1', text: 'Hello world' })])
  })

  it('selects chat', () => {
    const desk = useDesk()
    desk.select({ kind: 'chat', id: 'chat-1' })
    expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-1' })
  })

  // Owner, 2026-10-09: a new chat's POST answered seconds after he had moved on to another chat, and the
  // window pulled him back into the new one. It opens only while he is still where he sent it from.
  describe('a chat the window makes', () => {
    const summary = (id: string): ChatSummary => ({
      id,
      sessionId: null,
      title: 'Example chat',
      cwd: 'C:/Users/me/project',
      account: { id: 'default', label: 'Default', configDir: null },
      accountAuto: false,
      model: null,
      effort: null,
      permissionMode: 'default',
      delegateToCliMayte: false,
      status: 'closed',
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
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0
    })
    /** The next fetch answers only when the test says so, with this chat. */
    function answerLater(): (body: unknown) => void {
      let answer: ((body: unknown) => void) | null = null
      mockFetch.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))
      )
      return (body) => answer!(body)
    }
    const req = { cwd: 'C:/Users/me/project', prompt: 'Example first message' }

    it('stays on the chat the person moved to before the new chat answered', async () => {
      const desk = useDesk()
      desk.select({ kind: 'new', cwd: req.cwd })
      const answer = answerLater()
      const made = desk.createChat(req)
      desk.select({ kind: 'chat', id: 'chat-1' })
      answer(summary('chat-late'))
      await made
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-1' })
      expect(desk.chats.value.some((c) => c.id === 'chat-late')).toBe(true)
    })

    it('opens the new chat when the person is still on the new-session screen', async () => {
      const desk = useDesk()
      desk.select({ kind: 'new', cwd: req.cwd })
      const answer = answerLater()
      const made = desk.createChat(req)
      answer(summary('chat-stayed'))
      await made
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-stayed' })
    })

    it('opens a fork only while the person is still on the chat they forked', async () => {
      const desk = useDesk()
      desk.select({ kind: 'chat', id: 'chat-1' })
      let answer = answerLater()
      let made = desk.forkChat('chat-1')
      answer(summary('fork-stayed'))
      await made
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'fork-stayed' })

      desk.select({ kind: 'chat', id: 'chat-1' })
      answer = answerLater()
      made = desk.forkChat('chat-1')
      desk.select({ kind: 'new' })
      answer(summary('fork-left'))
      await made
      expect(desk.selected.value).toEqual({ kind: 'new' })
      expect(desk.chats.value.some((c) => c.id === 'fork-left')).toBe(true)
    })

  describe('a message the window draws', () => {
    it('draws the bubble before the POST answers, and the server echo takes its place', async () => {
      const desk = useDesk()
      await desk.init()
      desk.itemsByChat.value.set('chat-echo', [])
      const answer = answerLater()
      const sending = desk.send('chat-echo', { text: 'Example hello' })
      expect(desk.itemsByChat.value.get('chat-echo')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example hello' })])
      MockWebSocket.last!.simulateMessage({
        type: 'item.upsert',
        chatId: 'chat-echo',
        item: { id: 'msg-echo', ts: 1, kind: 'user', text: 'Example hello' } as TranscriptItem
      })
      answer({ queued: false })
      await sending
      expect(desk.itemsByChat.value.get('chat-echo')).toEqual([expect.objectContaining({ id: 'msg-echo', text: 'Example hello' })])
    })

    it('keeps the text and marks the bubble Not sent when the POST fails', async () => {
      const desk = useDesk()
      desk.itemsByChat.value.set('chat-fail', [])
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('{"error":"down"}', { status: 500 })))
      const result = await desk.send('chat-fail', { text: 'Example unsent' })
      expect(result).toBeNull()
      expect(desk.itemsByChat.value.get('chat-fail')).toEqual([
        expect.objectContaining({ text: 'Example unsent', sendFailed: expect.any(String) })
      ])
    })

    it('Retry clears Not sent and posts the same text again', async () => {
      const desk = useDesk()
      desk.itemsByChat.value.set('chat-retry', [])
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('{"error":"down"}', { status: 500 })))
      await desk.send('chat-retry', { text: 'Example again' })
      const failed = desk.itemsByChat.value.get('chat-retry')![0]
      mockFetch.mockClear()
      desk.retrySend('chat-retry', failed.id)
      expect(desk.itemsByChat.value.get('chat-retry')).toEqual([
        expect.objectContaining({ text: 'Example again', sendFailed: undefined })
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mockFetch).toHaveBeenCalledWith('/api/chats/chat-retry/messages', expect.objectContaining({ method: 'POST' }))
    })

    it('opens a new chat at once and makes it the real chat in place', async () => {
      const desk = useDesk()
      desk.select({ kind: 'new', cwd: req.cwd })
      const answer = answerLater()
      const made = desk.createChat({ cwd: req.cwd, prompt: 'Example first message' })
      const placeholder = desk.selected.value as { kind: 'chat'; id: string }
      expect(placeholder.kind).toBe('chat')
      expect(desk.chats.value.some((c) => c.id === placeholder.id)).toBe(true)
      expect(desk.itemsByChat.value.get(placeholder.id)).toEqual([expect.objectContaining({ kind: 'user', text: 'Example first message' })])
      answer(summary('chat-made'))
      await made
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-made' })
      expect(desk.chats.value.some((c) => c.id === placeholder.id)).toBe(false)
      expect(desk.itemsByChat.value.get('chat-made')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example first message' })])
    })

    it('a chat.upsert that lands before the POST answers takes the placeholder row: one row, one bubble', async () => {
      const desk = useDesk()
      await desk.init()
      desk.select({ kind: 'new', cwd: 'C:/Users/me/early' })
      const answer = answerLater()
      const made = desk.createChat({ cwd: 'C:/Users/me/early', prompt: 'Example early' })
      const placeholder = (desk.selected.value as { id: string }).id
      const row = desk.chats.value.find((c) => c.id === placeholder)!
      const chat = { ...row, id: 'chat-early', sessionId: 'session-early', title: 'Example early', createdAt: Date.now() + 1 }
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat })
      expect(desk.chats.value.filter((c) => c.id === 'chat-early' || c.id === placeholder)).toEqual([expect.objectContaining({ id: 'chat-early' })])
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-early' })
      answer(chat)
      await made
      expect(desk.chats.value.filter((c) => c.id === 'chat-early')).toHaveLength(1)
      expect(desk.chats.value.some((c) => c.id === placeholder)).toBe(false)
      expect(desk.itemsByChat.value.get('chat-early')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example early' })])
    })

    it('a different chat made in the same folder while the POST is out is not taken: the view stays on the placeholder', async () => {
      const desk = useDesk()
      await desk.init()
      desk.select({ kind: 'new', cwd: 'C:/Users/me/shared' })
      const answer = answerLater()
      const made = desk.createChat({ cwd: 'C:/Users/me/shared', prompt: 'Example mine' })
      const placeholder = (desk.selected.value as { id: string }).id
      const row = desk.chats.value.find((c) => c.id === placeholder)!
      MockWebSocket.last!.simulateMessage({
        type: 'chat.upsert',
        chat: { ...row, id: 'chat-other', sessionId: 'session-other', title: 'Example other chat', createdAt: Date.now() + 1 }
      })
      expect(desk.selected.value).toEqual({ kind: 'chat', id: placeholder })
      expect(desk.chats.value.some((c) => c.id === 'chat-other')).toBe(true)
      answer({ ...row, id: 'chat-mine', sessionId: 'session-mine', title: 'Example mine', createdAt: Date.now() + 2 })
      await made
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-mine' })
      expect(desk.chats.value.filter((c) => c.id === 'chat-mine')).toHaveLength(1)
      expect(desk.chats.value.filter((c) => c.id === 'chat-other')).toHaveLength(1)
      expect(desk.chats.value.some((c) => c.id === placeholder)).toBe(false)
      expect(desk.itemsByChat.value.get('chat-mine')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example mine' })])
      expect(desk.itemsByChat.value.get('chat-other') ?? []).toEqual([])
    })

    it('a chat the server put in another account still takes the placeholder when the request named one', async () => {
      const desk = useDesk()
      await desk.init()
      desk.select({ kind: 'new', cwd: 'C:/Users/me/routed' })
      const answer = answerLater()
      const made = desk.createChat({ cwd: 'C:/Users/me/routed', prompt: 'Example routed', accountId: 'acct-named' })
      const placeholder = (desk.selected.value as { id: string }).id
      const row = desk.chats.value.find((c) => c.id === placeholder)!
      const chat = {
        ...row,
        id: 'chat-routed',
        sessionId: 'session-routed',
        title: 'Example routed',
        account: { id: 'climayte', label: 'Example account', configDir: null },
        createdAt: Date.now() + 1
      }
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat })
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-routed' })
      answer(chat)
      await made
      expect(desk.chats.value.filter((c) => c.id === 'chat-routed')).toHaveLength(1)
      expect(desk.chats.value.some((c) => c.id === placeholder)).toBe(false)
      expect(desk.itemsByChat.value.get('chat-routed')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example routed' })])
    })

    it('a chat the server wrote with backslashes takes the placeholder made with forward slashes', async () => {
      const desk = useDesk()
      await desk.init()
      desk.select({ kind: 'new', cwd: 'C:/Users/me/slash' })
      const answer = answerLater()
      const made = desk.createChat({ cwd: 'C:/Users/me/slash', prompt: 'Example slashed' })
      const placeholder = (desk.selected.value as { id: string }).id
      const row = desk.chats.value.find((c) => c.id === placeholder)!
      const chat = { ...row, id: 'chat-slash', sessionId: 'session-slash', cwd: 'C:\\Users\\me\\slash', title: 'Example slashed', createdAt: Date.now() + 1 }
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat })
      expect(desk.selected.value).toEqual({ kind: 'chat', id: 'chat-slash' })
      answer(chat)
      await made
      expect(desk.chats.value.filter((c) => c.id === 'chat-slash')).toHaveLength(1)
      expect(desk.chats.value.some((c) => c.id === placeholder)).toBe(false)
      expect(desk.itemsByChat.value.get('chat-slash')).toEqual([expect.objectContaining({ kind: 'user', text: 'Example slashed' })])
    })

    it('a landed chat keeps the placeholder row key, so its sidebar row is patched, not re-made', async () => {
      const desk = useDesk()
      await desk.init()
      desk.select({ kind: 'new', cwd: 'C:/Users/me/rowkey' })
      const answer = answerLater()
      const made = desk.createChat({ cwd: 'C:/Users/me/rowkey', prompt: 'Example keyed' })
      const placeholder = (desk.selected.value as { id: string }).id
      const row = desk.chats.value.find((c) => c.id === placeholder)!
      const chat = { ...row, id: 'chat-keyed', sessionId: 'session-keyed', title: 'Example keyed', createdAt: Date.now() + 1 }
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat })
      answer(chat)
      await made
      expect(desk.rowKeyOf('chat-keyed')).toBe(placeholder)
      expect(desk.rowKeyOf('chat-unrelated')).toBe('chat-unrelated')
    })

    it('a history snapshot that already holds the sent message takes its bubble: one bubble', async () => {
      const desk = useDesk()
      await desk.init()
      await desk.send('chat-hist', { text: 'Example hist' })
      const answer = answerLater()
      const loading = desk.loadItems('chat-hist')
      answer([{ id: 'srv-hist', ts: Date.now() + 500, kind: 'user', text: 'Example hist' }])
      await loading
      const items = desk.itemsByChat.value.get('chat-hist') ?? []
      expect(items.filter((i) => i.kind === 'user' && i.text === 'Example hist')).toEqual([expect.objectContaining({ id: 'srv-hist' })])
    })

    it('the server echo takes the oldest bubble when its text differs from the one sent', async () => {
      const desk = useDesk()
      await desk.init()
      desk.itemsByChat.value.set('chat-trim', [])
      const answer = answerLater()
      const sending = desk.send('chat-trim', { text: 'Example  spaced ' })
      MockWebSocket.last!.simulateMessage({
        type: 'item.upsert',
        chatId: 'chat-trim',
        item: { id: 'msg-trim', ts: 1, kind: 'user', text: 'Example spaced' } as TranscriptItem
      })
      answer({ queued: false })
      await sending
      expect(desk.itemsByChat.value.get('chat-trim')).toEqual([expect.objectContaining({ id: 'msg-trim' })])
    })

    it('a message sent to a busy chat is drawn as queued', async () => {
      const desk = useDesk()
      await desk.init()
      MockWebSocket.last!.simulateMessage({
        type: 'chat.upsert',
        chat: { ...summary('chat-busy'), status: 'working', turnStartedAt: 100 }
      })
      desk.itemsByChat.value.set('chat-busy', [])
      const answer = answerLater()
      const sending = desk.send('chat-busy', { text: 'Example queued' })
      expect(desk.itemsByChat.value.get('chat-busy')).toEqual([
        expect.objectContaining({ kind: 'user', text: 'Example queued', queued: true })
      ])
      answer({ queued: true })
      await sending
    })
  })
  })

  describe('a Stop the window draws', () => {
    const chat = (id: string, status: ChatSummary['status'], turnStartedAt: number | null): ChatSummary => ({
      id,
      sessionId: null,
      title: 'Example chat',
      cwd: 'C:/Users/me/project',
      account: { id: 'default', label: 'Default', configDir: null },
      accountAuto: false,
      model: null,
      effort: null,
      permissionMode: 'default',
      delegateToCliMayte: false,
      status,
      activity: status === 'working' ? 'Reading the file' : null,
      turnStartedAt,
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
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0
    })
    const statusOf = (desk: ReturnType<typeof useDesk>, id: string) => desk.chats.value.find((c) => c.id === id)

    it('reads stopped before the request answers, and the late status of that turn does not flip it back', async () => {
      const desk = useDesk()
      await desk.init()
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-stop', 'working', 100) })
      let answer: ((body: unknown) => void) | null = null
      mockFetch.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))
      )

      const stopping = desk.interrupt('chat-stop')
      expect(statusOf(desk, 'chat-stop')).toMatchObject({ status: 'stopped', activity: null, turnStartedAt: null })

      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-stop', 'working', 100) })
      expect(statusOf(desk, 'chat-stop')?.status).toBe('stopped')

      answer!({ ok: true })
      await stopping
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-stop', 'stopped', null) })
      expect(statusOf(desk, 'chat-stop')?.status).toBe('stopped')
    })

    it("a new turn after the stop is the server's again and shows as working", async () => {
      const desk = useDesk()
      await desk.init()
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-next', 'working', 100) })
      await desk.interrupt('chat-next')
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-next', 'working', 250) })
      expect(statusOf(desk, 'chat-next')).toMatchObject({ status: 'working', turnStartedAt: 250 })
    })

    it('a failed stop restores the chat as it was and says why', async () => {
      const desk = useDesk()
      await desk.init()
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-fail', 'working', 100) })
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('{"error":"down"}', { status: 500 })))
      await expect(desk.interrupt('chat-fail')).rejects.toThrow()
      expect(statusOf(desk, 'chat-fail')).toMatchObject({ status: 'working', activity: 'Reading the file', turnStartedAt: 100 })
      MockWebSocket.last!.simulateMessage({ type: 'chat.upsert', chat: chat('chat-fail', 'working', 100) })
      expect(statusOf(desk, 'chat-fail')?.status).toBe('working')
    })
  })
})
