import { describe, expect, it } from 'bun:test'
import { activateTab, closeTab, enterTarget, filterProfiles, filterServers, freshTabs, loadTabs, looksLikeAddress, openTab, pageTitle, restoreTabs, retargetTab, saveTabs, serializeTabs, tabsKey } from '../../src/components/servers/logic'

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
  it('keeps the readable tabs when one is bad, and keys by folder ignoring case and slash direction', () => {
    const s = restoreTabs('{"tabs":[{"kind":"saved"},{"kind":"page","target":"http://localhost:1/"}],"active":0}')
    expect(s.tabs.map((t) => t.kind)).toEqual(['page'])
    expect(tabsKey('C:\\Users\\me\\App\\')).toBe(tabsKey('c:/users/me/app'))
    const store = mem()
    saveTabs('C:/Users/me/App', openTab(freshTabs('a'), { kind: 'page', target: 'http://localhost:2/', proc: null }, 'b'), store)
    expect(loadTabs('c:/users/ME/app', store).tabs.map((t) => t.kind)).toEqual(['new', 'page'])
    expect(loadTabs('C:/Users/me/Other', store).tabs.map((t) => t.kind)).toEqual(['new'])
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
    expect(enterTarget('zzz', [], [])).toBeNull()
  })
  it('titles a page by its server, else its host', () => {
    expect(pageTitle('http://localhost:5173/', { name: 'Web app' })).toBe('Web app')
    expect(pageTitle('http://localhost:5173/a', null)).toBe('localhost:5173')
    expect(pageTitle(null, null)).toBe('New tab')
  })
})
