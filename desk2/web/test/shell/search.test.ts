import { describe, it, expect } from 'bun:test'
import type { ChatSummary, ExternalSession, SearchHit } from '@shared/protocol'
import type { ChatGroup } from '@/components/sidebar/logic'
import {
  SearchError,
  createSearchRunner,
  everywhereRows,
  highlightParts,
  moveCursor,
  relativeTime,
  resolveCursor,
  searchEscape,
  searchTargets,
  shownSessionIds,
  type SearchState,
  type SearchTimers
} from '@/components/sidebar/search'

const hit = (sessionId: string): SearchHit => ({ sessionId, title: sessionId, cwd: null, snippet: '', source: 'cli', lastActivityAt: null })
const ours = (id: string, sessionId: string | null) => ({ id, sessionId }) as ChatSummary

/** Timers the test fires by hand. */
function manualTimers(): SearchTimers & { fire(): void; pending(): number } {
  let n = 0
  const queue = new Map<number, () => void>()
  return {
    set: (fn) => (queue.set(++n, fn), n),
    clear: (h) => void queue.delete(h as number),
    fire() {
      const fns = [...queue.values()]
      queue.clear()
      for (const f of fns) f()
    },
    pending: () => queue.size
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function harness() {
  const timers = manualTimers()
  const calls: { query: string; answer: ReturnType<typeof deferred<SearchHit[]>> }[] = []
  const states: SearchState[] = []
  const runner = createSearchRunner({
    run: (query) => {
      const answer = deferred<SearchHit[]>()
      calls.push({ query, answer })
      return answer.promise
    },
    onChange: (s) => states.push(s),
    timers
  })
  return { timers, calls, states, runner, last: () => states[states.length - 1]! }
}

describe('sidebar search runner', () => {
  it('waits for a pause in typing and asks once, for the last text', () => {
    const h = harness()
    h.runner.input('we')
    h.runner.input('web')
    h.runner.input(' webs ')
    expect(h.timers.pending()).toBe(1)
    expect(h.last()).toEqual({ query: 'webs', phase: 'loading', hits: [], error: null })
    h.timers.fire()
    expect(h.calls.map((c) => c.query)).toEqual(['webs'])
  })

  it('never lets a slower earlier answer overwrite a newer one', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.runner.input('beta')
    h.timers.fire()
    h.calls[1]!.answer.resolve([hit('b')])
    await settle()
    expect(h.last()).toMatchObject({ query: 'beta', phase: 'done', hits: [hit('b')] })
    h.calls[0]!.answer.resolve([hit('a')])
    await settle()
    expect(h.last()).toMatchObject({ query: 'beta', phase: 'done', hits: [hit('b')] })
  })

  it('a query under two characters is idle and drops the answer in flight', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.runner.input('a')
    expect(h.last()).toEqual({ query: 'a', phase: 'idle', hits: [], error: null })
    h.calls[0]!.answer.resolve([hit('x')])
    await settle()
    expect(h.last().phase).toBe('idle')
    expect(h.calls).toHaveLength(1)
  })

  it('the same text again (a trailing space) does not ask again', () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.runner.input('alpha ')
    expect(h.timers.pending()).toBe(0)
    expect(h.calls).toHaveLength(1)
  })

  it('tells AgentHydra offline apart from a failed search', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.calls[0]!.answer.reject(new SearchError(true, 'AgentHydra is not running'))
    await settle()
    expect(h.last()).toEqual({ query: 'alpha', phase: 'offline', hits: [], error: 'AgentHydra is not running' })
    h.runner.input('beta')
    h.timers.fire()
    h.calls[1]!.answer.reject(new SearchError(false, 'index broke'))
    await settle()
    expect(h.last()).toMatchObject({ phase: 'failed', error: 'index broke' })
  })

  it('a failed or offline search is asked again for the same text; one running or answered is not', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.runner.input('alpha')
    expect(h.timers.pending()).toBe(0)
    h.calls[0]!.answer.reject(new SearchError(true, 'AgentHydra is not running'))
    await settle()
    expect(h.last().phase).toBe('offline')
    h.runner.input('alpha')
    expect(h.last()).toEqual({ query: 'alpha', phase: 'loading', hits: [], error: null })
    h.timers.fire()
    h.calls[1]!.answer.reject(new SearchError(false, 'index broke'))
    await settle()
    expect(h.last().phase).toBe('failed')
    h.runner.input('alpha ')
    h.timers.fire()
    h.calls[2]!.answer.resolve([hit('a')])
    await settle()
    expect(h.last()).toMatchObject({ query: 'alpha', phase: 'done', hits: [hit('a')] })
    h.runner.input('alpha')
    expect(h.timers.pending()).toBe(0)
    expect(h.calls).toHaveLength(3)
  })

  it('a search the store aborted for a newer one is dropped without a failure', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    const before = h.states.length
    const abort = new Error('superseded')
    abort.name = 'AbortError'
    h.calls[0]!.answer.reject(abort)
    await settle()
    expect(h.states).toHaveLength(before)
    expect(h.last()).toEqual({ query: 'alpha', phase: 'loading', hits: [], error: null })
  })

  it('stop drops the pending query and the answer in flight', async () => {
    const h = harness()
    h.runner.input('alpha')
    h.timers.fire()
    h.runner.input('beta')
    h.runner.stop()
    expect(h.timers.pending()).toBe(0)
    h.calls[0]!.answer.resolve([hit('a')])
    await settle()
    expect(h.last()).toMatchObject({ query: 'beta', phase: 'loading' })
  })
})

describe('Everywhere rows and the keyboard', () => {
  const ext = { id: 's-ext' } as ExternalSession
  const groups: ChatGroup[] = [
    { key: 'pinned', label: 'Pinned', cwd: null, entries: [{ kind: 'chat', id: 'c1', at: 3, chat: ours('c1', 's-c1') }] },
    {
      key: 'C:/w',
      label: 'w',
      cwd: 'C:/w',
      entries: [
        { kind: 'chat', id: 'c2', at: 2, chat: ours('c2', null) },
        { kind: 'external', id: 's-ext', at: 1, session: ext }
      ]
    },
    { key: 'C:/shut', label: 'shut', cwd: 'C:/shut', entries: [{ kind: 'chat', id: 'c4', at: 0, chat: ours('c4', 's-c4') }] }
  ]
  const chats = [ours('c1', 's-c1'), ours('c2', null), ours('c3', 's-c3'), ours('c4', 's-c4')]

  it('skips hits the list already shows; our chat opens as the chat, the rest as outside sessions', () => {
    expect([...shownSessionIds(groups)]).toEqual(['s-c1', 's-ext', 's-c4'])
    const rows = everywhereRows([hit('s-c1'), hit('s-c3'), hit('s-ext'), hit('s-far')], chats, shownSessionIds(groups))
    expect(rows.map((r) => [r.key, r.view])).toEqual([
      ['hit:s-c3', { kind: 'chat', id: 'c3' }],
      ['hit:s-far', { kind: 'external', id: 's-far' }]
    ])
  })

  it('the arrow keys walk the open groups first, then the Everywhere rows, and stop at the ends', () => {
    const rows = everywhereRows([hit('s-far')], chats, new Set())
    const targets = searchTargets(groups, new Set(['C:/shut']), rows)
    expect(targets.map((t) => t.key)).toEqual(['chat:c1', 'chat:c2', 'external:s-ext', 'hit:s-far'])
    expect(targets[2]!.view).toEqual({ kind: 'external', id: 's-ext' })
    expect(moveCursor(-1, 1, 4)).toBe(0)
    expect(moveCursor(3, 1, 4)).toBe(3)
    expect(moveCursor(0, -1, 4)).toBe(-1)
    expect(moveCursor(-1, -1, 4)).toBe(-1)
    expect(moveCursor(-1, 1, 0)).toBe(-1)
  })

  it('a collapsed group shows none of its rows: their hits stay in Everywhere, where the arrow keys reach them', () => {
    const collapsed = new Set(['C:/shut'])
    expect([...shownSessionIds(groups, collapsed)]).toEqual(['s-c1', 's-ext'])
    const rows = everywhereRows([hit('s-c1'), hit('s-c4')], chats, shownSessionIds(groups, collapsed))
    expect(rows.map((r) => [r.key, r.view])).toEqual([['hit:s-c4', { kind: 'chat', id: 'c4' }]])
    expect(searchTargets(groups, collapsed, rows).map((t) => t.key)).toEqual(['chat:c1', 'chat:c2', 'external:s-ext', 'hit:s-c4'])
  })

  it('the cursor follows its row when a row lands above it, and keeps its place when its row goes away', () => {
    const t = (...keys: string[]) => keys.map((key) => ({ key, view: { kind: 'chat' as const, id: key } }))
    expect(resolveCursor(t('chat:a', 'chat:b'), 'chat:b', 1)).toBe(1)
    expect(resolveCursor(t('chat:new', 'chat:a', 'chat:b'), 'chat:b', 1)).toBe(2)
    expect(resolveCursor(t('chat:a', 'chat:c'), 'chat:b', 1)).toBe(1)
    expect(resolveCursor(t('chat:a'), 'chat:b', 1)).toBe(0)
    expect(resolveCursor(t(), 'chat:b', 1)).toBe(-1)
    expect(resolveCursor(t('chat:a'), null, 0)).toBe(-1)
  })

  it('Escape with text clears it and stops there; in an empty box it closes and goes on', () => {
    const calls: string[] = []
    const e = { preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') }
    expect(searchEscape(e, 'web')).toBe('clear')
    expect(calls).toEqual(['prevent', 'stop'])
    calls.length = 0
    expect(searchEscape(e, '')).toBe('close')
    expect(calls).toEqual([])
  })
})

describe('emphasis and age', () => {
  it('emphasises every query word wherever it appears, whatever its case', () => {
    expect(highlightParts('Fix the WebSocket test; websocket again', 'websocket TEST')).toEqual([
      { text: 'Fix the ', mark: false },
      { text: 'WebSocket', mark: true },
      { text: ' ', mark: false },
      { text: 'test', mark: true },
      { text: '; ', mark: false },
      { text: 'websocket', mark: true },
      { text: ' again', mark: false }
    ])
  })

  it('merges overlapping words and leaves a line without them whole', () => {
    expect(highlightParts('abcdef', 'abc cde')).toEqual([
      { text: 'abcde', mark: true },
      { text: 'f', mark: false }
    ])
    expect(highlightParts('nothing here', 'zz')).toEqual([{ text: 'nothing here', mark: false }])
    expect(highlightParts('', 'zz')).toEqual([])
  })

  it('marks the right letters after a character that lowercases longer', () => {
    // "İ" lowercases to two code units: marks taken from a lowercased copy land one letter late.
    expect(highlightParts('İstanbul is', 'is')).toEqual([
      { text: 'İstanbul ', mark: false },
      { text: 'is', mark: true }
    ])
    expect(highlightParts('a+b (c)', 'A+B (c)')).toEqual([
      { text: 'a+b', mark: true },
      { text: ' ', mark: false },
      { text: '(c)', mark: true }
    ])
  })

  it('says how long ago, short', () => {
    const now = 10 * 7 * 86_400_000
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime(now - 20_000, now)).toBe('now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d')
    expect(relativeTime(now - 15 * 86_400_000, now)).toBe('2w')
  })
})
