import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activateTab, addressOrSearch, closeTab, enterTarget, filterProfiles, filterServers, freshTabs, loadTabs, looksLikeAddress, openTab, pageTitle, requestTab, restoreTabs, retargetTab, saveTabs, serializeTabs, tabsKey } from '../../src/components/servers/logic'

const ids = (s: { tabs: { id: string }[] }) => s.tabs.map((t) => t.id)
const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('the tab list', () => {
  it('starts as one New tab; a new tab goes last and is shown', () => {
    const s = freshTabs('a')
    expect(s.tabs).toEqual([{ id: 'a', kind: 'new', target: null, proc: null }])
    const t = openTab(s, undefined, 'b')
    expect(ids(t)).toEqual(['a', 'b'])
    expect(t.active).toBe('b')
  })
  it('closing the shown tab shows its right neighbour, else the left; another tab leaves the shown one', () => {
    let s = openTab(openTab(freshTabs('a'), undefined, 'b'), undefined, 'c')
    s = activateTab(s, 'b')
    expect(closeTab(s, 'a', 'x').active).toBe('b')
    expect(closeTab(s, 'b', 'x').active).toBe('c')
    expect(closeTab(activateTab(s, 'c'), 'c', 'x').active).toBe('b')
  })
  it('closing the last tab leaves one New tab', () => {
    const s = closeTab(freshTabs('a'), 'a', 'n')
    expect(s.tabs).toEqual([{ id: 'n', kind: 'new', target: null, proc: null }])
    expect(s.active).toBe('n')
  })
  it('retargeting keeps the tab in place', () => {
    const s = retargetTab(openTab(freshTabs('a'), undefined, 'b'), 'a', { kind: 'page', target: 'http://localhost:3000/', proc: 'p1' })
    expect(s.tabs[0]).toEqual({ id: 'a', kind: 'page', target: 'http://localhost:3000/', proc: 'p1' })
    expect(ids(s)).toEqual(['a', 'b'])
  })
})

describe('remembering the tabs per chat folder', () => {
  it('round-trips kind, target and the shown tab, with fresh ids', () => {
    let s = openTab(freshTabs('a'), { kind: 'page', target: 'http://localhost:5173/', proc: 'web' }, 'b')
    s = openTab(s, { kind: 'saved', target: 'shop', proc: null, url: 'https://shop.example.test/' }, 'c')
    s = activateTab(s, 'b')
    const back = restoreTabs(serializeTabs(s))
    expect(back.tabs.map(({ kind, target, proc, url }) => ({ kind, target, proc, url }))).toEqual([
      { kind: 'new', target: null, proc: null, url: undefined },
      { kind: 'page', target: 'http://localhost:5173/', proc: 'web', url: undefined },
      { kind: 'saved', target: 'shop', proc: null, url: 'https://shop.example.test/' }
    ])
    expect(back.active).toBe(back.tabs[1]!.id)
  })
  it('first open, junk, or tabs without a target are one New tab', () => {
    for (const raw of [null, '', 'nope', '{}', '{"tabs":[]}', '{"tabs":[{"kind":"page"},{"kind":"x"}]}']) {
      const s = restoreTabs(raw)
      expect(s.tabs.map((t) => t.kind)).toEqual(['new'])
      expect(s.active).toBe(s.tabs[0]!.id)
    }
  })
  it('keeps the readable tabs when one is bad', () => {
    const s = restoreTabs('{"tabs":[{"kind":"saved"},{"kind":"page","target":"http://localhost:1/"}],"active":0}')
    expect(s.tabs.map((t) => t.kind)).toEqual(['page'])
  })
  it("each chat keeps its own tabs; a chat with none starts on its AI's last browser, else one New tab", () => {
    const store = mem()
    saveTabs('chat-a', openTab(freshTabs('a'), { kind: 'page', target: 'https://www.google.com/search?igu=1&q=help', proc: null }, 'b'), store)
    expect(loadTabs('chat-a', null, store).tabs.map((t) => t.kind)).toEqual(['new', 'page'])
    // Another chat, even in the same folder, does not see chat-a's search.
    expect(loadTabs('chat-b', null, store).tabs.map((t) => [t.kind, t.target])).toEqual([['new', null]])
    expect(loadTabs('chat-b', { profile: 'shop', url: 'https://shop.example.com/' }, store).tabs).toMatchObject([{ kind: 'saved', target: 'shop', url: 'https://shop.example.com/' }])
    expect(loadTabs('chat-b', { url: 'https://example.com/' }, store).tabs).toMatchObject([{ kind: 'page', target: 'https://example.com/', proc: null }])
    // Remembered tabs win over the AI's browser.
    expect(loadTabs('chat-a', { profile: 'shop' }, store).tabs.map((t) => t.kind)).toEqual(['new', 'page'])
    expect(tabsKey('chat-a')).not.toBe(tabsKey('chat-b'))
  })
  it("a Browser card's request is its saved browser, else its address, else nothing", () => {
    expect(requestTab({ profile: 'shop', url: 'https://shop.example.com/' })).toEqual({ kind: 'saved', target: 'shop', proc: null, url: 'https://shop.example.com/' })
    expect(requestTab({ url: 'https://example.com/' })).toEqual({ kind: 'page', target: 'https://example.com/', proc: null })
    expect(requestTab({})).toBeNull()
  })
  it('the pane is open or shut per chat, and a chat gets a pane of its own on its own tabs', () => {
    const frame = readFileSync(join(import.meta.dir, '../../src/components/shell/DeskFrame.vue'), 'utf8')
    expect(frame).toContain('get: () => paneByView.value.get(viewKey.value) ?? null')
    // A Dev servers list's server opened with no chat on screen gets the view's own tabs.
    expect(frame).toContain(`:key="chat?.id ?? viewKey" :chat-id="chat?.id ?? viewKey"`)
  })
  it("a pane opened before the transcript loaded goes to the AI's browser when it arrives, while untouched", () => {
    const pane = readFileSync(join(import.meta.dir, '../../src/components/servers/ServersPane.vue'), 'utf8')
    expect(pane).toContain('const opened = props.aiBrowser ? null : state.value')
    expect(pane).toContain('if (r && opened && state.value === opened) state.value = loadTabs(props.chatId, r)')
  })
})

describe('the New tab filter and address bar', () => {
  const servers = [
    { id: 'web', name: 'Web app', port: 5173, status: 'running' as const },
    { id: 'api', name: 'API', port: 4000, status: 'stopped' as const }
  ]
  const rows = [
    { name: 'shop', note: 'Store admin', hosts: ['admin.example.com'], open: true, lastUsed: 'just now' },
    { name: 'mail', note: null, hosts: [], open: false, lastUsed: 'never used' }
  ]
  it('filters servers by name, port and status, and saved browsers by name, note and host', () => {
    expect(filterServers(servers, 'web').map((s) => s.id)).toEqual(['web'])
    expect(filterServers(servers, ':4000').map((s) => s.id)).toEqual(['api'])
    expect(filterServers(servers, 'stopped api').map((s) => s.id)).toEqual(['api'])
    expect(filterServers(servers, '').length).toBe(2)
    expect(filterProfiles(rows, 'admin').map((r) => r.name)).toEqual(['shop'])
    expect(filterProfiles(rows, 'zzz')).toEqual([])
  })
  it('tells an address from a search', () => {
    for (const t of ['3000', 'localhost:3000', 'http://x', 'example.com', 'example.com/a', 'host:8080']) expect(looksLikeAddress(t)).toBe(true)
    for (const t of ['', 'web', 'web app', 'my-app', '5']) expect(looksLikeAddress(t)).toBe(false)
  })
  it('Enter: a port is localhost, an address opens, else the first match', () => {
    expect(enterTarget('3000', servers, rows)).toEqual({ kind: 'address', url: 'http://localhost:3000/' })
    expect(enterTarget('example.com', servers, rows)).toEqual({ kind: 'address', url: 'http://example.com/' })
    expect(enterTarget('app', servers, rows)).toEqual({ kind: 'server', id: 'web' })
    expect(enterTarget('shop', [], rows)).toEqual({ kind: 'saved', name: 'shop' })
    expect(enterTarget('help', [], [])).toEqual({ kind: 'address', url: 'https://www.google.com/search?igu=1&q=help' })
    expect(enterTarget('  ', [], [])).toBeNull()
  })
  it('an address bar opens an address or a port, and searches Google for anything else', () => {
    expect(addressOrSearch('example.com')).toBe('http://example.com/')
    expect(addressOrSearch('5173')).toBe('http://localhost:5173/')
    expect(addressOrSearch('help')).toBe('https://www.google.com/search?igu=1&q=help')
    expect(addressOrSearch('how to center a div')).toBe('https://www.google.com/search?igu=1&q=how%20to%20center%20a%20div')
    expect(addressOrSearch(' ')).toBeNull()
  })
  it('titles a page by its server, else its host', () => {
    expect(pageTitle('http://localhost:5173/', { name: 'Web app' })).toBe('Web app')
    expect(pageTitle('http://localhost:5173/a', null)).toBe('localhost:5173')
    expect(pageTitle(null, null)).toBe('New tab')
  })
})
