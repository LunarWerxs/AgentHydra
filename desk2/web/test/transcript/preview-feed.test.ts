// What feeds a Browser card: only the newest card of a profile, on screen, in a visible window subscribes to the
// stream; leaving the screen or hiding the window closes it; a failed stream falls back to the 3 s poll.
import { describe, expect, test } from 'bun:test'
import { newestBrowserCalls } from '../../src/components/transcript/lib/tools'
import { PreviewFeed, previewWanted, previewStreamUrl } from '../../src/components/transcript/lib/browserPreview'

const A = 'mcp__connections__connections_execute'
const call = (id: string, profile: string) => ({ id, ts: 1, kind: 'tool_use' as const, name: A, input: { local: true, tool_name: 'browser_click', params: { profile } }, status: 'done' as const, startedAt: 1 })
const base = { named: true, newest: true, onScreen: true, visible: true, hasCwd: true }

describe('previewWanted', () => {
  test('only the newest card of a named profile, on screen, in a visible window', () => {
    const newest = newestBrowserCalls([call('1', 'shop'), call('2', 'shop')])
    const wanted = (id: string) => previewWanted({ ...base, newest: newest.get('shop') === id })
    expect(wanted('1')).toBe(false)
    expect(wanted('2')).toBe(true)
    expect(previewWanted({ ...base, onScreen: false })).toBe(false)
    expect(previewWanted({ ...base, visible: false })).toBe(false)
    expect(previewWanted({ ...base, named: false })).toBe(false)
    expect(previewWanted({ ...base, hasCwd: false })).toBe(false)
  })
})

function fakeDeps() {
  const streams: { onFrame: (s: string) => void; onEnd: () => void; closed: boolean }[] = []
  let polls = 0
  return {
    streams,
    polls: () => polls,
    deps: {
      openStream(onFrame: (s: string) => void, onEnd: () => void) {
        const s = { onFrame, onEnd, closed: false }
        streams.push(s)
        return () => void (s.closed = true)
      },
      poll: async () => void polls++,
    },
  }
}

describe('PreviewFeed', () => {
  test('wanted opens one stream; hidden or off screen closes it; wanted again opens a new one', () => {
    const f = fakeDeps()
    const shown: string[] = []
    const feed = new PreviewFeed(f.deps, (s) => shown.push(s))
    feed.setWanted(true)
    feed.setWanted(true)
    expect(f.streams.length).toBe(1)
    f.streams[0].onFrame('data:a')
    expect(shown).toEqual(['data:a'])
    feed.setWanted(false)
    expect(f.streams[0].closed).toBe(true)
    expect(feed.streaming).toBe(false)
    feed.setWanted(true)
    expect(f.streams.length).toBe(2)
    feed.setWanted(false)
    expect(f.polls()).toBe(0)
  })

  test('a stream that ends falls back to the poll, keeps polling, and the stream is tried again later', async () => {
    const f = fakeDeps()
    const feed = new PreviewFeed(f.deps, () => {}, { pollMs: 20, retryMs: 90, firstFrameMs: 1000 })
    feed.setWanted(true)
    f.streams[0].onFrame('data:a')
    f.streams[0].onEnd()
    expect(f.polls()).toBe(1)
    await Bun.sleep(50)
    expect(f.polls()).toBeGreaterThan(1)
    await Bun.sleep(100)
    expect(f.streams.length).toBe(2)
    const after = f.polls()
    await Bun.sleep(60)
    expect(f.polls()).toBe(after)
    feed.setWanted(false)
    expect(f.streams[1].closed).toBe(true)
  })

  test('a stream that never delivers a frame falls back to the poll; leaving stops the poll', async () => {
    const f = fakeDeps()
    const feed = new PreviewFeed(f.deps, () => {}, { pollMs: 20, retryMs: 10_000, firstFrameMs: 30 })
    feed.setWanted(true)
    // Waits for the fallback rather than a fixed 100 ms: a loaded machine (the full gate) can run 30 ms timers late.
    for (const end = Date.now() + 2000; Date.now() < end && !(f.streams[0].closed && f.polls() > 1); ) await Bun.sleep(10)
    expect(f.streams[0].closed).toBe(true)
    expect(f.polls()).toBeGreaterThan(1)
    feed.setWanted(false)
    const n = f.polls()
    await Bun.sleep(60)
    expect(f.polls()).toBe(n)
  })
})

test('the stream address follows the page’s scheme and carries the chat folder and profile', () => {
  expect(previewStreamUrl({ protocol: 'http:', host: 'localhost:7798' }, 'C:/Users/me/proj', 'shop')).toBe('ws://localhost:7798/api/browser/preview-stream?cwd=C%3A%2FUsers%2Fme%2Fproj&profile=shop')
  expect(previewStreamUrl({ protocol: 'https:', host: 'example.com' }, 'x', 'y').startsWith('wss://example.com/')).toBe(true)
})
