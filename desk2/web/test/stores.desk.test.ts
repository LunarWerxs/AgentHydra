import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test'

// Mock DOM globals
if (typeof document === 'undefined') {
  ;(global as any).document = {
    title: 'Hydra Desk',
    hidden: false
  }
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
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  )
})

describe('useDesk store', () => {
  let mockWs: MockWebSocket | null = null

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
    function answerLater(): (chat: ChatSummary) => void {
      let answer: ((chat: ChatSummary) => void) | null = null
      mockFetch.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (answer = (chat) => resolve(new Response(JSON.stringify(chat), { status: 200 }))))
      )
      return (chat) => answer!(chat)
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
  })
})
