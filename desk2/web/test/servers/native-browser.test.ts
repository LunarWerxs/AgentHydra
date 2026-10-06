import { describe, expect, it } from 'bun:test'
import { deliverHostEvent, hasHostBrowser, type HostBrowserIn, type HostBrowserOut, HostView, hostRect, overlaps } from '../../src/components/servers/native-browser'

describe('hasHostBrowser', () => {
  it('only inside AgentHydra’s window: the host flag and its ipc both', () => {
    const ipc = { postMessage() {} }
    expect(hasHostBrowser({ agentHydraHost: { browser: 1 }, ipc })).toBe(true)
    expect(hasHostBrowser({ agentHydraHost: { browser: 1 } })).toBe(false)
    expect(hasHostBrowser({ ipc })).toBe(false)
    expect(hasHostBrowser({ agentHydraHost: { browser: 2 }, ipc })).toBe(false)
    expect(hasHostBrowser({})).toBe(false)
  })
})

describe('hostRect', () => {
  it('CSS pixels times the scale, in whole pixels', () => {
    expect(hostRect({ left: 500.4, top: 74, width: 900, height: 700.5 }, 1.5)).toEqual({ left: 751, top: 111, right: 2101, bottom: 1162 })
    expect(hostRect({ left: 0, top: 0, width: 10, height: 10 }, 1)).toEqual({ left: 0, top: 0, right: 10, bottom: 10 })
  })
  it('a box with no area (a hidden tab) is no box', () => {
    expect(hostRect({ left: 0, top: 0, width: 0, height: 0 }, 1)).toBeNull()
    expect(hostRect({ left: 10, top: 10, width: 300, height: 0.5 }, 2)).toBeNull()
  })
})

describe('overlaps', () => {
  const pane = { left: 1000, top: 80, right: 2000, bottom: 1400 }
  it('a menu reaching into the tab overlaps it; one beside it or touching its edge does not', () => {
    expect(overlaps({ left: 900, top: 100, right: 1100, bottom: 300 }, pane)).toBe(true)
    expect(overlaps({ left: 700, top: 100, right: 1000, bottom: 300 }, pane)).toBe(false)
    expect(overlaps({ left: 1200, top: 0, right: 1400, bottom: 80 }, pane)).toBe(false)
  })
})

describe('HostView', () => {
  const made = () => {
    const sent: HostBrowserIn[] = []
    const got: HostBrowserOut[] = []
    const view = new HostView((e) => got.push(e), (m) => sent.push(m))
    return { view, sent, got }
  }
  const box = { left: 10, top: 20, right: 810, bottom: 620 }

  it('nothing reaches the host before the first open', () => {
    const { view, sent } = made()
    view.place(box)
    view.act('reload')
    expect(sent).toEqual([])
    expect(view.isOpen).toBe(false)
  })

  it('open makes the view; place is sent only when the box changed, null hides it', () => {
    const { view, sent } = made()
    view.open('https://example.com/', box)
    view.place({ ...box })
    view.place({ ...box, right: 900 })
    view.place(null)
    view.place(null)
    expect(sent).toEqual([
      { kind: 'browser', op: 'open', id: view.id, url: 'https://example.com/', rect: box },
      { kind: 'browser', op: 'place', id: view.id, rect: { ...box, right: 900 } },
      { kind: 'browser', op: 'place', id: view.id, rect: null },
    ])
  })

  it('back, forward and reload go to the view; close ends it and its events', () => {
    const { view, sent, got } = made()
    view.open('https://example.com/', null)
    view.act('back')
    view.act('forward')
    view.act('reload')
    deliverHostEvent({ id: view.id, type: 'url', url: 'https://example.com/a', loading: false })
    view.close()
    deliverHostEvent({ id: view.id, type: 'url', url: 'https://example.com/b', loading: false })
    view.act('reload')
    expect(sent.map((m) => m.op)).toEqual(['open', 'back', 'forward', 'reload', 'close'])
    expect(got).toEqual([{ id: view.id, type: 'url', url: 'https://example.com/a', loading: false }])
  })

  it('an event reaches only the view it names', () => {
    const a = made()
    const b = made()
    expect(a.view.id).not.toBe(b.view.id)
    deliverHostEvent({ id: b.view.id, type: 'title', title: 'Example', url: 'https://example.com/' })
    deliverHostEvent(null)
    deliverHostEvent({ type: 'url' })
    expect(a.got).toEqual([])
    expect(b.got).toEqual([{ id: b.view.id, type: 'title', title: 'Example', url: 'https://example.com/' }])
  })
})
