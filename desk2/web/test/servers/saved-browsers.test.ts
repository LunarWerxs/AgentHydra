import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { BROWSER_PROFILES, OPEN_BROWSER_EVENT, type BrowserProfiles } from '@shared/browser'
import { browserOpen, browserProfiles } from '../../src/components/servers/api'
import { clipboardAction, fitFrame, formatAgo, isPasteKey, keyMessage, liveSocketUrl, mapPoint, mouseButton, normalizeAddress, profileRows, resolveRequest } from '../../src/components/servers/logic'

const NOW = Date.parse('2020-10-06T12:00:00Z')
const list: BrowserProfiles = {
  workspace: 'example-app',
  profiles: [
    { name: 'shop', note: 'Store admin for the example shop', sites: [], sessionHosts: ['admin.example.com', 'admin.example.com', 'mail.example.test'], open: true, own: true, lastUsedAt: '2020-10-06T11:55:00Z' },
    { name: 'scratch', note: null, sites: [], sessionHosts: [], open: false, own: true, lastUsedAt: null }
  ]
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('the saved browsers list', () => {
  it('asks GET BROWSER_PROFILES with the chat folder and turns the answer into rows', async () => {
    let asked = ''
    globalThis.fetch = (async (url: string) => {
      asked = String(url)
      return new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const got = await browserProfiles('C:/Users/me/Code/App')
    expect(asked).toBe(`${BROWSER_PROFILES}?cwd=C%3A%2FUsers%2Fme%2FCode%2FApp`)
    expect(profileRows(got, NOW)).toEqual([
      { name: 'shop', label: 'Example', note: 'Store admin for the example shop', hosts: ['admin.example.com', 'mail.example.test'], open: true, lastUsed: '5 min ago' },
      { name: 'scratch', label: 'scratch', note: null, hosts: [], open: false, lastUsed: 'never used' }
    ])
  })
  it('an empty list is no rows, and the error field rides along', () => {
    expect(profileRows({ workspace: null, profiles: [] })).toEqual([])
    expect(profileRows(null)).toEqual([])
  })
  it('POSTs the open request with login when asked', async () => {
    let body: unknown = null
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ profile: 'shop', started: true, tab: null }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await browserOpen('C:/Users/me/Code/App', 'shop', { login: true })
    expect(body).toEqual({ cwd: 'C:/Users/me/Code/App', profile: 'shop', login: true })
  })
  it('formats last use', () => {
    expect(formatAgo('2020-10-06T11:59:50Z', NOW)).toBe('just now')
    expect(formatAgo('2020-10-06T09:00:00Z', NOW)).toBe('3 h ago')
    expect(formatAgo('2020-10-04T12:00:00Z', NOW)).toBe('2 d ago')
  })
})

describe('the card request', () => {
  it('selects a listed profile, else keeps the address', () => {
    expect(resolveRequest({ profile: 'shop' }, list)).toEqual({ kind: 'profile', profile: 'shop' })
    expect(resolveRequest({ profile: 'gone', url: 'https://example.com/' }, list)).toEqual({ kind: 'missing', profile: 'gone', url: 'https://example.com/' })
    expect(resolveRequest({ url: 'https://example.com/' }, null)).toEqual({ kind: 'missing', profile: null, url: 'https://example.com/' })
  })
})

describe('OPEN_BROWSER_EVENT', () => {
  const target = new EventTarget()
  let mod: typeof import('../../src/components/servers/browser-request')
  beforeAll(async () => {
    ;(globalThis as { window?: unknown }).window = target
    mod = await import('../../src/components/servers/browser-request')
  })
  const fire = (detail: unknown) => target.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail }))

  it('keeps a request fired before the pane mounted, and hands it over once', () => {
    fire({ profile: 'shop', url: 'https://admin.example.com/' })
    expect(mod.browserRequest.value).toEqual({ profile: 'shop', url: 'https://admin.example.com/' })
    expect(mod.claimBrowserRequest()?.profile).toBe('shop')
    expect(mod.claimBrowserRequest()).toBeNull()
  })
  it('a request fired while the pane is mounted is a new one to claim', () => {
    fire({ profile: 'scratch' })
    expect(mod.claimBrowserRequest()).toEqual({ profile: 'scratch', url: undefined })
    fire(undefined)
    expect(mod.claimBrowserRequest()).toEqual({ profile: undefined, url: undefined })
  })
})

describe('canvas to page coordinates', () => {
  const frame = { width: 1000, height: 500 }
  it('maps with no letterbox when the aspect matches', () => {
    expect(mapPoint({ left: 10, top: 20, width: 500, height: 250 }, frame, 260, 145)).toEqual({ x: 500, y: 250 })
  })
  it('keeps a shorter frame flush with the top of a taller canvas', () => {
    const box = { left: 0, top: 0, width: 500, height: 500 } // frame drawn 500x250 at y 0
    expect(fitFrame(500, 500, frame)).toEqual({ x: 0, y: 0, width: 500, height: 250, scale: 0.5 })
    expect(mapPoint(box, frame, 250, 125)).toEqual({ x: 500, y: 250 })
    expect(mapPoint(box, frame, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(mapPoint(box, frame, 250, 300)).toBeNull()
  })
  it('undoes the bars of a wider canvas, and clamps a drag that left the page', () => {
    const box = { left: 100, top: 0, width: 1000, height: 250 } // drawn 500x250 at x 250
    expect(mapPoint(box, frame, 100 + 250 + 250, 125)).toEqual({ x: 500, y: 250 })
    expect(mapPoint(box, frame, 150, 125)).toBeNull()
    expect(mapPoint(box, frame, 150, 125, true)).toEqual({ x: 0, y: 250 })
    expect(mapPoint(box, frame, 5000, -40, true)).toEqual({ x: 1000, y: 0 })
  })
  it('has no mapping before a frame', () => {
    expect(mapPoint({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 }, 5, 5)).toBeNull()
  })
})

describe('input messages', () => {
  const key = (over: Partial<Parameters<typeof keyMessage>[0]>) => ({ type: 'keydown', key: 'a', code: 'KeyA', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over })
  it('a printable key carries its text and modifier bits', () => {
    expect(keyMessage(key({ key: 'A', shiftKey: true }))).toEqual({ type: 'key', event: 'down', key: 'A', code: 'KeyA', modifiers: 8, text: 'A' })
  })
  it('key up, named keys and shortcuts carry no text; Enter types a return', () => {
    expect(keyMessage(key({ type: 'keyup' }))).toEqual({ type: 'key', event: 'up', key: 'a', code: 'KeyA', modifiers: 0 })
    expect(keyMessage(key({ key: 'ArrowLeft', code: 'ArrowLeft' })).text).toBeUndefined()
    expect(keyMessage(key({ ctrlKey: true, altKey: true })).text).toBeUndefined()
    expect(keyMessage(key({ ctrlKey: true, altKey: true })).modifiers).toBe(3)
    expect(keyMessage(key({ key: 'Enter', code: 'Enter' })).text).toBe('\r')
  })
  it('the paste shortcut is left to the paste event', () => {
    expect(isPasteKey({ key: 'v', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isPasteKey({ key: 'v', ctrlKey: false, metaKey: false })).toBe(false)
  })
  it('mouse buttons: down/up by button, move by what is held', () => {
    expect(mouseButton({ type: 'mousedown', button: 2, buttons: 2 })).toBe('right')
    expect(mouseButton({ type: 'mouseup', button: 0, buttons: 0 })).toBe('left')
    expect(mouseButton({ type: 'mousemove', button: 0, buttons: 0 })).toBe('none')
    expect(mouseButton({ type: 'mousemove', button: 0, buttons: 1 })).toBe('left')
  })
})

describe('address bar and socket', () => {
  it('adds https:// only when there is no scheme', () => {
    expect(normalizeAddress('example.com/login')).toBe('https://example.com/login')
    expect(normalizeAddress('  http://localhost:3000/x ')).toBe('http://localhost:3000/x')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
    expect(normalizeAddress('   ')).toBeNull()
  })
  it('builds the live socket address from the page', () => {
    expect(liveSocketUrl({ protocol: 'http:', host: 'localhost:7798' }, 'C:/Users/me/App', 'shop')).toBe('ws://localhost:7798/api/browser/live?cwd=C%3A%2FUsers%2Fme%2FApp&profile=shop')
    expect(liveSocketUrl({ protocol: 'https:', host: 'h.example.com' }, '/w', 'a b', 't1')).toBe('wss://h.example.com/api/browser/live?cwd=%2Fw&profile=a+b&tab=t1')
  })
})

describe('clipboardAction', () => {
  const k = (key: string, m: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => clipboardAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m })
  it('names the copy, cut and paste shortcuts, Ctrl or Cmd', () => {
    expect(k('c', { ctrlKey: true })).toBe('copy')
    expect(k('X', { metaKey: true })).toBe('cut')
    expect(k('v', { ctrlKey: true })).toBe('paste')
    expect(k('Insert', { ctrlKey: true })).toBe('copy')
    expect(k('Insert', { shiftKey: true })).toBe('paste')
    expect(k('Delete', { shiftKey: true })).toBe('cut')
  })
  it('leaves every other key to the page', () => {
    expect(k('c')).toBeNull()
    expect(k('a', { ctrlKey: true })).toBeNull()
    expect(k('c', { ctrlKey: true, shiftKey: true })).toBeNull()
    expect(k('c', { ctrlKey: true, altKey: true })).toBeNull()
  })
})
