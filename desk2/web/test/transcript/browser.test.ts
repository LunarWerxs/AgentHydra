import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupRows, type ToolItem } from '../../src/components/transcript/lib/groups'
import { browserOpenRequest, isBrowserCall, newestBrowserCalls, parseBrowserCall, toolFamily } from '../../src/components/transcript/lib/tools'

const call = (tool_name: string, params: Record<string, unknown> = {}, local = true) => ({ local, tool_name, params })
const item = (id: string, name: string, input: Record<string, unknown>): ToolItem => ({
  id,
  ts: 1,
  kind: 'tool_use',
  name,
  input,
  status: 'done',
  startedAt: 1,
})
const A = 'mcp__connections__connections_execute'
const B = 'mcp__claude_ai_Connections__connections_execute'

describe('browser family', () => {
  test('both server prefixes with local:true and a browser_ tool are the browser; nothing else is', () => {
    expect(toolFamily(A, call('browser_navigate'))).toBe('browser')
    expect(toolFamily(B, call('browser_click'))).toBe('browser')
    expect(toolFamily(A, call('browser_navigate', {}, false))).toBe('mcp')
    expect(toolFamily(A, call('memory_search'))).toBe('mcp')
    expect(isBrowserCall('mcp__x__other_tool', call('browser_navigate'))).toBe(false)
    expect(toolFamily(A)).toBe('mcp')
  })
})

describe('parseBrowserCall', () => {
  test('verbs, url from params, profile from params', () => {
    const p = { url: 'https://shop.example.com/a', profile: 'example-shop' }
    expect(parseBrowserCall(A, call('browser_navigate', p))).toEqual({ verb: 'Opened', url: p.url, profile: 'example-shop' })
    const verbs: Record<string, string> = {
      browser_click: 'Clicked',
      browser_type: 'Typed into',
      browser_snapshot: 'Read',
      browser_read: 'Read',
      browser_get_text: 'Read',
      browser_take_screenshot: 'Screenshot of',
      browser_profile_login: 'Sign-in window for',
      browser_profile_find: 'Looked for a saved browser for',
      browser_profiles: 'Listed saved browsers',
      browser_live: 'Showed live',
      browser_scroll_down: 'Scroll down',
    }
    for (const [tool, verb] of Object.entries(verbs)) expect(parseBrowserCall(tool, {}).verb).toBe(verb)
  })

  test('url falls back to the first address in the result; the profile to the default browser', () => {
    const r = parseBrowserCall(A, call('browser_click'), 'Clicked. Now on https://example.com/next?x=1 (200) or https://other.example.com')
    expect(r).toEqual({ verb: 'Clicked', url: 'https://example.com/next?x=1', profile: 'default browser' })
    expect(parseBrowserCall(A, call('browser_click'), 'no address here').url).toBe('')
  })

  test('the profile is params.profile, then profile_id, then profileId, else the default browser', () => {
    expect(parseBrowserCall(A, call('browser_click', { profile: 'one', profile_id: 'two', profileId: 'three' })).profile).toBe('one')
    expect(parseBrowserCall(A, call('browser_click', { profile_id: 'company-example', profileId: 'three' })).profile).toBe('company-example')
    expect(parseBrowserCall(A, call('browser_click', { profileId: 'three' })).profile).toBe('three')
    expect(parseBrowserCall(A, call('browser_click', {})).profile).toBe('default browser')
  })

  test('only the newest call of each named profile may preview live', () => {
    const items = [
      item('1', A, call('browser_navigate', { profile: 'shop' })),
      item('2', A, call('browser_click', { profile_id: 'shop' })),
      item('3', A, call('browser_click', { profile: 'blog' })),
      item('4', A, call('browser_click')),
      item('5', A, call('memory_search')),
    ]
    expect([...newestBrowserCalls(items)]).toEqual([['shop', '2'], ['blog', '3']])
  })

  test('a click asks for the saved profile and the address; the default browser has no profile', () => {
    expect(browserOpenRequest({ url: 'https://example.com', profile: 'example-shop' })).toEqual({ profile: 'example-shop', url: 'https://example.com' })
    expect(browserOpenRequest({ url: '', profile: 'default browser' })).toEqual({ profile: undefined, url: undefined })
  })

  test('the card fires OPEN_BROWSER_EVENT with that request; DeskFrame opens the servers pane for a chat and drops the listener', () => {
    const card = readFileSync(join(import.meta.dir, '../../src/components/transcript/parts/BrowserCard.vue'), 'utf8')
    expect(card).toContain('<button')
    expect(card).toContain('new CustomEvent(OPEN_BROWSER_EVENT, { detail: browserOpenRequest(info.value) })')
    const frame = readFileSync(join(import.meta.dir, '../../src/components/shell/DeskFrame.vue'), 'utf8')
    expect(frame).toContain('window.addEventListener(OPEN_BROWSER_EVENT, onOpenBrowser)')
    expect(frame).toContain('window.removeEventListener(OPEN_BROWSER_EVENT, onOpenBrowser)')
    expect(frame).toMatch(/onOpenBrowser = \(\) => \{\s*if \(chat\.value\) pane\.value = 'servers'/)
  })
})

describe('grouping keeps the card', () => {
  test('a run of browser calls is one row of its own, between tool runs, and shows the latest call', () => {
    const rows = groupRows([
      item('a', 'Bash', {}),
      item('b1', A, call('browser_navigate', { url: 'https://example.com' })),
      item('b2', B, call('browser_click')),
      item('m', A, call('memory_search')),
    ])
    expect(rows.map((r) => r.id)).toEqual(['tools:a', 'browser:b1', 'tools:m'])
    const r = rows[1]
    expect(r.kind === 'browser' && r.items.map((i) => i.id)).toEqual(['b1', 'b2'])
  })
})
