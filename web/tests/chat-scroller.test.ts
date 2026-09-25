// web/tests/chat-scroller.test.ts - where the open transcript sits (composables/useChatScroller.ts)
// and how useOpenSession pages older turns in through it.
//
// The scroller is headless and measures through three numbers, so a plain object stands in for the
// pane: a test sets scrollHeight the way a render would, and reads scrollTop back. What is pinned:
//   - a history prepend keeps the reader's message under their eye instead of jumping by the height
//     of what was added above it;
//   - a poll sticks to the end only for a reader who was at the end, and otherwise counts the new
//     turns for the jump-to-latest button rather than yanking them down;
//   - "Load older turns" asks the daemon for one more page, and a new session starts at one page.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { nextTick, ref } from 'vue'
import type { QueueItem, SessionSource, SessionSummary, TailResult } from '../src/lib/api'

interface FakePane {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener: () => void
  removeEventListener: () => void
  querySelector: () => null
}

function pane(over: Partial<FakePane> = {}): FakePane {
  return {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 400,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    ...over,
  }
}

const asEl = (p: FakePane) => p as unknown as HTMLElement

let tailCalls: { limit?: number }[] = []
let nextTail: Partial<TailResult> = {}
// What a render of the answer does to the pane, run as the answer lands.
let onTail: () => void = () => {}

// Copied before the fake lands and restored after, as request-generations.test.ts explains:
// mock.module is process-wide, and a later file must get the real api back.
const realApi = { ...(await import('../src/lib/api')) }

mock.module('../src/lib/api', () => ({
  ...realApi,
  getTail: async (_id: string, source: SessionSource, opts: { limit?: number }) => {
    tailCalls.push({ limit: opts.limit })
    onTail()
    return {
      session_id: 's1',
      source,
      title: 't',
      cwd: '/',
      events: [],
      ...nextTail,
    } as TailResult
  },
}))

afterAll(() => {
  mock.module('../src/lib/api', () => realApi)
})

const { capturePrependAnchor, isAtBottom, restorePrependAnchor, useChatScroller } = await import(
  '../src/composables/useChatScroller'
)
const { TAIL_PAGE, useOpenSession } = await import('../src/composables/useOpenSession')

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

describe('prepend keeps the reader in place', () => {
  test('the same message stays under the eye when 1000px of history lands above it', () => {
    const p = pane({ scrollTop: 500 })
    const anchor = capturePrependAnchor(p)
    p.scrollHeight += 1000
    restorePrependAnchor(p, anchor)
    expect(p.scrollTop).toBe(1500)
  })

  test('the at-bottom check is a band, not an exact pixel', () => {
    expect(isAtBottom(pane({ scrollTop: 1600 }))).toBe(true)
    expect(isAtBottom(pane({ scrollTop: 1550 }))).toBe(true)
    expect(isAtBottom(pane({ scrollTop: 900 }))).toBe(false)
  })
})

describe('follow sticks only for a reader at the end', () => {
  test('a reader at the end is carried down with the new turn', async () => {
    const p = pane({ scrollTop: 1600 })
    const s = useChatScroller(ref(asEl(p)))
    await s.follow(async () => {
      p.scrollHeight += 300
      return 'grew'
    })
    expect(p.scrollTop).toBe(2300)
    expect(s.unseen.value).toBe(0)
  })

  test('a reader scrolled up stays put, and the new turn is counted for jump-to-latest', async () => {
    const p = pane({ scrollTop: 300 })
    const s = useChatScroller(ref(asEl(p)))
    await s.follow(async () => {
      p.scrollHeight += 300
      return 'grew'
    })
    expect(p.scrollTop).toBe(300)
    expect(s.atBottom.value).toBe(false)
    expect(s.unseen.value).toBe(1)

    s.scrollToLatest()
    expect(p.scrollTop).toBe(2300)
    expect(s.unseen.value).toBe(0)
  })

  test('the opening load lands at the end and clears the pending flag', async () => {
    const p = pane()
    const s = useChatScroller(ref(asEl(p)))
    expect(s.pending.value).toBe(true)
    await s.open(async () => true)
    expect(p.scrollTop).toBe(2000)
    expect(s.pending.value).toBe(false)
  })
})

describe('useOpenSession pages older turns in', () => {
  beforeEach(() => {
    tailCalls = []
    nextTail = {}
    onTail = () => {}
  })

  function setup() {
    return useOpenSession({
      sessions: ref<SessionSummary[]>([]),
      queue: ref<QueueItem[]>([]),
      showTools: ref(true),
      showThinking: ref(false),
      humanOnly: ref(false),
    })
  }
  const session = (id: string) =>
    ({ session_id: id, source: 'claude' }) as unknown as SessionSummary

  test('one more page is asked for, and the reader keeps their place', async () => {
    const open = setup()
    const p = pane({ scrollTop: 500 })
    open.chatEl.value = asEl(p)
    nextTail = { has_more: true }
    open.select(session('s1'))
    await settle()
    expect(tailCalls.map((c) => c.limit)).toEqual([TAIL_PAGE])
    expect(open.canLoadOlder.value).toBe(true)

    p.scrollTop = 500
    onTail = () => {
      p.scrollHeight += 1000
    }
    await open.loadOlder()
    expect(tailCalls.map((c) => c.limit)).toEqual([TAIL_PAGE, TAIL_PAGE * 2])
    expect(p.scrollTop).toBe(1500)
  })

  test('no older page is offered once the daemon says there is none', async () => {
    const open = setup()
    open.chatEl.value = asEl(pane())
    nextTail = { has_more: false }
    open.select(session('s1'))
    await settle()
    expect(open.canLoadOlder.value).toBe(false)
    await open.loadOlder()
    expect(tailCalls).toHaveLength(1)
  })

  test('a body-search hit opens at the newest turn holding the text, not at the end', async () => {
    const open = setup()
    const asked: string[] = []
    const p = pane({
      querySelector: ((sel: string) => {
        asked.push(sel)
        return { scrollIntoView: () => {} }
      }) as unknown as () => null,
    })
    open.chatEl.value = asEl(p)
    const turn = (text: string) => ({
      role: 'assistant',
      kind: 'text',
      text,
      tool_name: null,
      timestamp: null,
    })
    nextTail = {
      events: [turn('a Needle here'), turn('needle again'), turn('the end')],
    } as Partial<TailResult>
    open.anchorNextOpen('NEEDLE')
    open.select(session('s1'))
    await settle()
    expect(asked).toEqual(['[data-turn="1"]'])
    expect(p.scrollTop).toBe(0)

    // Consumed by that open: the next one lands at the end again.
    open.select(session('s2'))
    await settle()
    expect(asked).toHaveLength(1)
    expect(p.scrollTop).toBe(2000)
  })

  test('a newly opened session starts over at one page', async () => {
    const open = setup()
    open.chatEl.value = asEl(pane())
    nextTail = { has_more: true }
    open.select(session('s1'))
    await settle()
    await open.loadOlder()
    expect(open.tailLimit.value).toBe(TAIL_PAGE * 2)

    open.select(session('s2'))
    await settle()
    expect(tailCalls.at(-1)?.limit).toBe(TAIL_PAGE)
  })
})
