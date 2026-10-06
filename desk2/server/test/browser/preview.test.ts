// The Browser card's stream: PreviewHub's refcount, the one-screencast rule with the pane's live session, the 5 fps cap
// and the backpressure drop. Chrome is faked by a small server that speaks DevTools over HTTP and a websocket per page.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { LiveSession } from '../../src/browser/cdp'
import { PreviewHub, type PreviewSink } from '../../src/browser/preview'

interface FakeChrome {
  port: number
  /** Every CDP method received, in order, over all sockets. */
  calls: { method: string; params: Record<string, unknown> }[]
  count(method: string): number
  /** Pushes a screencast frame to every connected page socket. */
  frame(data: string): void
  stop(): void
}

const fakes: FakeChrome[] = []
const lives: LiveSession[] = []
afterEach(() => {
  for (const l of lives.splice(0)) l.close()
  for (const f of fakes.splice(0)) f.stop()
})

function fakeChrome(): FakeChrome {
  const sockets = new Set<ServerWebSocket<unknown>>()
  const calls: FakeChrome['calls'] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const path = new URL(req.url).pathname
      if (path === '/json/list') return Response.json([{ id: 'tab1', type: 'page', url: 'https://example.com/', title: 'Example' }])
      if (path.startsWith('/devtools/page/') && srv.upgrade(req, { data: undefined })) return undefined
      return new Response('no', { status: 404 })
    },
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> }
        calls.push({ method: m.method, params: m.params })
        const result = m.method === 'Page.getNavigationHistory' ? { currentIndex: 0, entries: [{ id: 1, url: 'https://example.com/', title: 'Example' }] } : {}
        ws.send(JSON.stringify({ id: m.id, result }))
      },
    },
  })
  const fake: FakeChrome = {
    port: server.port as number,
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    frame(data) {
      for (const ws of sockets) ws.send(JSON.stringify({ method: 'Page.screencastFrame', params: { sessionId: 1, data, metadata: { deviceWidth: 640, deviceHeight: 400 } } }))
    },
    stop: () => void server.stop(true),
  }
  fakes.push(fake)
  return fake
}

function sink(backed = false): PreviewSink & { got: string[]; closedWith: string[]; backed: () => boolean; hold: boolean } {
  const s = {
    got: [] as string[],
    closedWith: [] as string[],
    hold: backed,
    send: (f: { data: string }) => void s.got.push(f.data),
    closed: (r: string) => void s.closedWith.push(r),
    backed: () => s.hold,
  }
  return s
}

const hub = (minIntervalMs = 200): PreviewHub => {
  return new PreviewHub({ minIntervalMs })
}

async function until(what: string, ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(10)
  }
}

describe('subscribe and unsubscribe', () => {
  test('one small screencast serves every card; the last one leaving stops it', async () => {
    const chrome = fakeChrome()
    const h = hub()
    const a = sink()
    const b = sink()
    const offA = h.subscribe(chrome.port, a)
    const offB = h.subscribe(chrome.port, b)
    expect(h.count(chrome.port)).toBe(2)
    await until('screencast started', () => chrome.count('Page.startScreencast') > 0)
    expect(chrome.count('Page.startScreencast')).toBe(1)
    const params = chrome.calls.find((c) => c.method === 'Page.startScreencast')?.params as { maxWidth: number; quality: number; everyNthFrame: number }
    expect(params.maxWidth).toBeLessThanOrEqual(640)
    expect(params.quality).toBeLessThanOrEqual(60)
    expect(params.everyNthFrame).toBeGreaterThanOrEqual(2)

    chrome.frame('one')
    await until('both cards got the frame', () => a.got.length === 1 && b.got.length === 1)

    offA()
    expect(h.count(chrome.port)).toBe(1)
    expect(h.casting(chrome.port)).toBe(true)
    expect(chrome.count('Page.stopScreencast')).toBe(0)

    offB()
    expect(h.count(chrome.port)).toBe(0)
    expect(h.casting(chrome.port)).toBe(false)
    await until('screencast stopped', () => chrome.count('Page.stopScreencast') === 1)
    // The same card leaving twice is harmless.
    offB()
    expect(chrome.count('Page.stopScreencast')).toBe(1)
  })

  test('a card that joins later gets the newest frame at once; a source that ends closes every card', async () => {
    const chrome = fakeChrome()
    const h = hub(10)
    const first = sink()
    h.subscribe(chrome.port, first)
    await until('screencast started', () => chrome.count('Page.startScreencast') > 0)
    chrome.frame('newest')
    await until('first card got it', () => first.got.length === 1)
    const late = sink()
    h.subscribe(chrome.port, late)
    expect(late.got).toEqual(['newest'])

    const ending: { end?: (r: string) => void } = {}
    const h2 = new PreviewHub({
      castFactory: (_p, _f, onEnd) => {
        ending.end = onEnd
        return { stop() {} }
      },
    })
    const s = sink()
    h2.subscribe(1, s)
    ending.end?.('the browser was closed')
    expect(s.closedWith).toEqual(['the browser was closed'])
    expect(h2.count(1)).toBe(0)
  })
})

describe('the pane’s live session', () => {
  test('its frames are reused: no second screencast is started on the same Chrome', async () => {
    const chrome = fakeChrome()
    const live = new LiveSession(chrome.port, () => {}, () => {})
    lives.push(live)
    await live.start({ id: 'tab1', url: 'https://example.com/', title: 'Example' })
    expect(chrome.count('Page.startScreencast')).toBe(1)

    const h = hub(10)
    const s = sink()
    h.subscribe(chrome.port, s)
    await Bun.sleep(150)
    expect(h.casting(chrome.port)).toBe(false)
    expect(chrome.count('Page.startScreencast')).toBe(1)

    chrome.frame('from the pane')
    await until('the card got the pane’s frame', () => s.got.includes('from the pane'))
  })

  test('a pane that opens while the card casts takes the screencast over; when it closes the card casts again', async () => {
    const chrome = fakeChrome()
    const h = hub(10)
    h.subscribe(chrome.port, sink())
    await until('card cast started', () => chrome.count('Page.startScreencast') === 1)

    const live = new LiveSession(chrome.port, () => {}, () => {})
    lives.push(live)
    await live.start({ id: 'tab1', url: 'https://example.com/', title: 'Example' })
    expect(h.casting(chrome.port)).toBe(false)
    await until('card cast stopped', () => chrome.count('Page.stopScreencast') === 1)

    live.close()
    expect(h.casting(chrome.port)).toBe(true)
    await until('card cast restarted', () => chrome.count('Page.startScreencast') === 3)
  })
})

describe('rate and backpressure', () => {
  test('a card gets at most one frame per interval, and the newest one is not lost', async () => {
    const chrome = fakeChrome()
    const h = hub(150)
    const s = sink()
    h.subscribe(chrome.port, s)
    await until('screencast started', () => chrome.count('Page.startScreencast') > 0)
    for (let i = 1; i <= 20; i++) chrome.frame(`f${i}`)
    await until('newest frame delivered', () => s.got.at(-1) === 'f20')
    expect(s.got.length).toBeLessThanOrEqual(3)
    expect(s.got.length).toBeLessThan(20)
  })

  test('while the socket is backed up frames are dropped, and the newest goes out once it drains', async () => {
    const chrome = fakeChrome()
    const h = hub(20)
    const s = sink(true)
    h.subscribe(chrome.port, s)
    await until('screencast started', () => chrome.count('Page.startScreencast') > 0)
    for (let i = 1; i <= 10; i++) chrome.frame(`f${i}`)
    await Bun.sleep(200)
    expect(s.got).toEqual([])
    s.hold = false
    await until('drained', () => s.got.length > 0)
    expect(s.got).toEqual(['f10'])
  })
})
