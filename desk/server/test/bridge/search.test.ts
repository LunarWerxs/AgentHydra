// AgentHydra's transcript search mapped to SearchHit (bridge/search.ts), on its own response shape.

import { afterEach, describe, expect, test } from 'bun:test'
import { createBridge } from '../../src/bridge'
import { mapSearch, pickSnippet, searchResults, SNIPPET_MAX } from '../../src/bridge/search'
import { type FakeHydra, fixture, NOW, searchAnswer, startFakeHydra } from './fake-hydra'

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sessions: any[] = fixture('sessions')
const row = (id: string) => sessions.find((s) => s.session_id === id) ?? null

describe('search hits', () => {
  const results = searchAnswer().results
  const hits = mapSearch(results, results.map((r: any) => row(r.session_id)), 'websocket test')

  test('a hit takes its title and activity time from the session row, in AgentHydra order', () => {
    expect(hits.map((h) => h.sessionId)).toEqual([sid(2), sid(1), '00000000-0000-4000-8000-0000000000ff'])
    expect(hits[0]).toEqual({
      sessionId: sid(2),
      title: 'Session 1',
      cwd: 'C:\\Users\\me\\Desktop\\Project\\alpha',
      snippet: '…we fixed the flaky WebSocket test by…',
      source: 'cli',
      lastActivityAt: 1791069817976,
      score: 7,
    })
  })

  test('a blank cwd comes from the row, codex stays codex', () => {
    expect(hits[1]).toMatchObject({ title: 'Session 3', cwd: 'C:\\Users\\me\\Desktop\\Project\\gamma', source: 'codex', score: 1 })
  })

  test('a hit the index has no row for keeps its id as title and no time', () => {
    expect(hits[2]).toMatchObject({ title: '00000000', cwd: 'C:\\Users\\me\\old', lastActivityAt: null, snippet: 'a websocket line' })
  })

  test('one hit per session id', () => {
    const twice = [results[0], { ...results[0], source: 'codex' }]
    expect(mapSearch(twice, [null, null], 'websocket')).toHaveLength(1)
  })
})

describe('snippets', () => {
  test('a long line is cut around the match, both cuts marked', () => {
    const long = `${'x'.repeat(200)} the flaky websocket test ${'y'.repeat(200)}`
    const s = pickSnippet([long], 'WebSocket')
    expect(s.length).toBe(SNIPPET_MAX + 2)
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toContain('the flaky websocket test')
  })

  test('a match at the start is not cut in front; whitespace is folded', () => {
    const s = pickSnippet([`websocket\n\n  test ${'z'.repeat(300)}`], 'websocket')
    expect(s.startsWith('websocket test')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })

  test('no snippet holding the words falls back to the first, none to empty', () => {
    expect(pickSnippet(['first', 'second'], 'absent')).toBe('first')
    expect(pickSnippet([], 'absent')).toBe('')
  })
})

describe('an answer of another shape', () => {
  test('no results, or results without a session id, give fewer hits instead of an error', () => {
    expect(searchResults({ searched: 'index' })).toEqual([])
    expect(searchResults(null)).toEqual([])
    expect(searchResults({ results: 'none' })).toEqual([])
    expect(searchResults({ results: [null, { source: 'claude' }, { session_id: sid(2) }] })).toEqual([{ session_id: sid(2) }] as any)
    expect(mapSearch(undefined, [], 'q')).toEqual([])
  })

  test('a result without snippets has an empty snippet', () => {
    const [hit] = mapSearch([{ session_id: sid(2), source: 'claude' } as any], [null], 'websocket')
    expect(hit).toMatchObject({ sessionId: sid(2), title: '00000000', cwd: null, snippet: '' })
  })
})

describe('the bridge search', () => {
  const fakes: FakeHydra[] = []
  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.stop()
  })
  const lookups = (f: FakeHydra) => f.gets.filter((g) => /^\/api\/sessions\/[^/?]+\?source=/.test(g))

  async function fake(): Promise<FakeHydra> {
    const f = await startFakeHydra()
    fakes.push(f)
    return f
  }

  test("a hit's session row is read once a minute, however many searches ask", async () => {
    const f = await fake()
    let t = NOW
    const b = createBridge({ url: f.url, now: () => t })
    const first = await b.search('websocket test', 25)
    expect(first.map((h) => h.title)).toEqual(['Session 1', 'Session 3', '00000000'])
    expect(lookups(f)).toHaveLength(3)

    // the row the index does not have is remembered as none too
    expect(await b.search('websocket test', 25)).toEqual(first)
    expect(lookups(f)).toHaveLength(3)
    expect(f.gets.filter((g) => g.startsWith('/api/sessions/search'))).toHaveLength(2)

    t += 61_000
    await b.search('websocket test', 25)
    expect(lookups(f)).toHaveLength(6)
  })

  test('a search dropped before it starts reads nothing and says aborted', async () => {
    const f = await fake()
    const b = createBridge({ url: f.url })
    const ac = new AbortController()
    ac.abort()
    await expect(b.search('websocket', 25, ac.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(f.gets).toEqual([])
  })

  test('a search dropped once its answer is in starts no row lookups', async () => {
    const f = await fake()
    const ac = new AbortController()
    const b = createBridge({
      url: f.url,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(input, init)
        if (String(input).includes('/api/sessions/search')) ac.abort()
        return res
      }) as unknown as typeof fetch,
    })
    await expect(b.search('websocket', 25, ac.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(f.gets.some((g) => g.startsWith('/api/sessions/search'))).toBe(true)
    expect(lookups(f)).toEqual([])
  })
})
