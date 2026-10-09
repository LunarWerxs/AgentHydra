import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRealPage, type BrowserTab } from '@shared/browser'
import { cardPlan, restoreTabs, savedTabTitle, serializeTabs, syncPages, type TabsState } from '../../src/components/servers/logic'

// A saved browser's pages are top tabs, one per real page (the old second row of page sub-tabs is gone).

const pg = (id: string, url: string, title = ''): BrowserTab => ({ id, url, title })
let n = 0
const mk = () => `n${++n}`
const base = (): TabsState => ({ tabs: [{ id: 'new1', kind: 'new', target: null, proc: null }], active: 'new1' })
const saved = (s: TabsState, profile = 'shop') => s.tabs.filter((t) => t.kind === 'saved' && t.target === profile)

describe('which pages are real', () => {
  it('http, https and file are; blank, internal, data and blob pages and empty are not', () => {
    for (const u of ['https://example.com/', 'http://localhost:3000/x', 'file:///C:/Users/me/a.html']) expect(isRealPage(u)).toBe(true)
    for (const u of ['about:blank', 'chrome://newtab/', 'devtools://devtools/x', 'data:text/html,hi', 'blob:https://example.com/1', '', '  ']) expect(isRealPage(u)).toBe(false)
  })
})

describe('one top tab per real page', () => {
  it('every real page gets a tab beside the others and a blank one gets none', () => {
    const s = syncPages(base(), 'shop', [pg('a', 'https://example.com/a'), pg('b', 'about:blank'), pg('c', 'https://example.com/c'), pg('d', 'chrome://newtab/')], mk)
    expect(s.tabs.map((t) => [t.kind, t.target, t.page])).toEqual([['new', null, undefined], ['saved', 'shop', 'a'], ['saved', 'shop', 'c']])
    expect(s.active).toBe('new1')
  })
  it('a page that appears later gets a tab without taking the view; a page that closes loses its tab', () => {
    const one = syncPages(base(), 'shop', [pg('a', 'https://example.com/a')], mk)
    const two = syncPages(one, 'shop', [pg('a', 'https://example.com/a'), pg('b', 'https://example.org/b')], mk)
    expect(saved(two).map((t) => t.page)).toEqual(['a', 'b'])
    expect(two.active).toBe('new1')
    const gone = syncPages(two, 'shop', [pg('b', 'https://example.org/b')], mk)
    expect(saved(gone).map((t) => t.page)).toEqual(['b'])
  })
  it('a blank page that navigates somewhere real gets its tab; nothing changed returns the same state', () => {
    const s = syncPages(base(), 'shop', [pg('a', 'about:blank')], mk)
    expect(saved(s)).toEqual([])
    const t = syncPages(s, 'shop', [pg('a', 'https://example.com/')], mk)
    expect(saved(t).map((x) => x.page)).toEqual(['a'])
    expect(syncPages(t, 'shop', [pg('a', 'https://example.com/')], mk)).toBe(t)
  })
  it('a page of the shown tab that goes blank keeps its tab; an inactive one that goes blank loses it', () => {
    let s = syncPages(base(), 'shop', [pg('a', 'https://example.com/a'), pg('b', 'https://example.com/b')], mk)
    s = { ...s, active: saved(s)[0]!.id }
    const blank = syncPages(s, 'shop', [pg('a', 'about:blank'), pg('b', 'about:blank')], mk)
    expect(saved(blank).map((t) => t.page)).toEqual(['a'])
    expect(blank.active).toBe(s.active)
  })
  it('a tab standing for the profile takes the first real page instead of doubling it', () => {
    const s: TabsState = { tabs: [{ id: 'p1', kind: 'saved', target: 'shop', proc: null }], active: 'p1' }
    const t = syncPages(s, 'shop', [pg('a', 'https://example.com/a'), pg('b', 'https://example.com/b')], mk)
    expect(t.tabs.map((x) => [x.id, x.page])).toEqual([['p1', 'a'], [t.tabs[1]!.id, 'b']])
  })
  it('pages of other profiles are left alone, and a browser that could not be asked changes nothing', () => {
    const s = syncPages(base(), 'shop', [pg('a', 'https://example.com/a')], mk)
    const t = syncPages(s, 'games', [pg('a', 'https://example.org/')], mk)
    expect(saved(t, 'shop').map((x) => x.page)).toEqual(['a'])
    expect(saved(t, 'games').map((x) => x.page)).toEqual(['a'])
    expect(syncPages(t, 'shop', null, mk)).toBe(t)
    expect(syncPages(t, 'shop', [], mk).tabs.some((x) => x.target === 'shop')).toBe(false)
  })
  it('page tabs of a Chrome that restarted drop out when it is looked at again', () => {
    const restored = restoreTabs(serializeTabs(syncPages(base(), 'shop', [pg('old', 'https://example.com/a')], mk)))
    expect(saved(restored).map((t) => t.page)).toEqual(['old'])
    const now = syncPages(restored, 'shop', [pg('new', 'https://example.com/a')], mk)
    expect(saved(now).map((t) => t.page)).toEqual(['new'])
  })
})

describe('a tab title', () => {
  it('is the page title, else its host, else the profile label', () => {
    const t = { target: 'shop', page: 'a', url: 'https://admin.example.com/x' }
    expect(savedTabTitle(t, [pg('a', 'https://admin.example.com/x', 'Orders')], 'Example')).toBe('Orders')
    expect(savedTabTitle(t, [pg('a', 'https://admin.example.com/x', '')], 'Example')).toBe('admin.example.com')
    expect(savedTabTitle(t, undefined, 'Example')).toBe('admin.example.com')
    expect(savedTabTitle({ target: 'shop', page: undefined, url: undefined }, undefined, 'Example')).toBe('Example')
  })
})

describe('a Browser card click', () => {
  const pages = [pg('a', 'https://example.com/a'), pg('b', 'https://example.com/b#top')]
  const have = syncPages(base(), 'shop', pages, mk)
  const tabOf = (page: string) => saved(have).find((t) => t.page === page)!.id
  it('brings forward the tab of the page at its address (a hash or trailing slash aside)', () => {
    expect(cardPlan(have, 'shop', 'https://example.com/b/', pages)).toEqual({ kind: 'pick', tab: tabOf('b') })
  })
  it('opens a NEW page when the profile is open and nothing is at the address, never navigating one that exists', () => {
    expect(cardPlan(have, 'shop', 'https://example.com/z', [pg('a', 'https://example.com/a'), pg('b', 'about:blank')])).toEqual({ kind: 'new', url: 'https://example.com/z' })
    expect(cardPlan(base(), 'shop', 'https://example.com/z', [pg('a', 'about:blank')])).toEqual({ kind: 'new', url: 'https://example.com/z' })
  })
  it('a page with no tab yet gets one; a profile that is not open keeps the Open flow', () => {
    expect(cardPlan(base(), 'shop', 'https://example.com/a', [pg('a', 'https://example.com/a')])).toEqual({ kind: 'add', page: pg('a', 'https://example.com/a') })
    expect(cardPlan(base(), 'shop', 'https://example.com/a', 'closed')).toEqual({ kind: 'placeholder' })
    expect(cardPlan(base(), 'shop', 'https://example.com/a', null)).toEqual({ kind: 'placeholder' })
  })
  it('a card with no address brings forward the profile first tab', () => {
    expect(cardPlan(have, 'shop', undefined, pages)).toEqual({ kind: 'pick', tab: tabOf('a') })
  })
})

describe('the pane markup', () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, '../../src/components/servers', f), 'utf8')
  it('has no second row of page tabs, and binds the live view to its one page', () => {
    const view = read('SavedBrowsers.vue')
    expect(view).not.toContain('aria-label="Pages"')
    expect(view).not.toContain("send({ type: 'tab'")
    expect(read('ServersPane.vue')).toContain(':page-id="activeTab.page"')
  })
  it('a page tab carries a badge naming its profile, the full name on hover, and closing it closes the page, not the Chrome', () => {
    const pane = read('ServersPane.vue')
    expect(pane).toContain('data-testid="profile-badge"')
    expect(pane).toContain(':label="`Chrome profile: ${t.target}`"')
    expect(pane).toContain('browserClosePage(cwd, profile, page, props.chatId)')
    expect(pane).not.toContain('browserClose(')
  })
})
