import { describe, expect, test } from 'bun:test'
import type { ToolItem } from '../../src/components/transcript/lib/groups'
import {
  browserErrorSummary,
  isOwnChromeCall,
  leadingJson,
  lastBrowserRequest,
  ownChromeAction,
  ownChromeClosed,
  parseBrowserCall,
} from '../../src/components/transcript/lib/tools'

const A = 'mcp__connections__connections_execute'
const live = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: A, input: { local: true, tool_name: 'browser_live', params }, ...extra })
const item = (id: string, input: Record<string, unknown>): ToolItem => ({ id, ts: 1, kind: 'tool_use', name: A, input, status: 'done', startedAt: 1 })

describe('browser_live verbs', () => {
  test('each action says what it did; steps count their steps', () => {
    const verb = (params: Record<string, unknown>) => parseBrowserCall(A, { local: true, tool_name: 'browser_live', params }).verb
    expect(verb({ action: 'open', url: 'https://app.example.com/' })).toBe('Opened')
    expect(verb({ action: 'navigate', url: 'https://app.example.com/' })).toBe('Opened')
    expect(verb({ action: 'read' })).toBe('Read')
    expect(verb({ action: 'click', name: 'Continue' })).toBe('Clicked')
    expect(verb({ action: 'type', text: 'a@example.com' })).toBe('Typed into')
    expect(verb({ action: 'screenshot' })).toBe('Screenshot of')
    expect(verb({ action: 'close' })).toBe('Closed')
    expect(verb({ action: 'steps', steps: [{ click: '#a' }, { click: '#b' }, { click: '#c' }] })).toBe('Ran 3 steps')
    expect(verb({ action: 'steps', steps: [{ click: '#a' }] })).toBe('Ran 1 step')
    expect(verb({})).toBe('Showed live')
  })

  test('the live result names its address when the call gave none', () => {
    const r = parseBrowserCall(A, { local: true, tool_name: 'browser_live', params: { action: 'read' } }, '{"ok":true,"url":"app.example.com/checkout"}')
    expect(r.url).toBe('https://app.example.com/checkout')
    expect(r.profile).toBe('default browser')
  })

  test('the action reads as a short phrase; typed text is never shown', () => {
    expect(ownChromeAction(A, { local: true, tool_name: 'browser_live', params: { action: 'click', name: 'Continue' } })).toBe("Clicked 'Continue'")
    expect(ownChromeAction(A, { local: true, tool_name: 'browser_live', params: { action: 'type', text: 'secret' } })).toBe('Typed into')
    expect(ownChromeAction(A, { local: true, tool_name: 'browser_live', params: { action: 'open', url: 'https://app.example.com/' } })).toBe("Opened 'https://app.example.com/'")
    expect(ownChromeAction(A, { local: true, tool_name: 'browser_live', params: { action: 'steps', steps: [{ click: '#a' }] } })).toBe('Ran 1 step')
  })
})

describe('Your Chrome', () => {
  test('browser_live is the own Chrome; other browser calls are not', () => {
    expect(isOwnChromeCall(A, { local: true, tool_name: 'browser_live', params: {} })).toBe(true)
    expect(isOwnChromeCall(A, { local: true, tool_name: 'browser_navigate', params: {} })).toBe(false)
  })

  test('an own Chrome call is never the last browser request, so the AI-used pane never opens the default browser for it', () => {
    const items = [item('1', { local: true, tool_name: 'browser_live', params: { action: 'open', url: 'https://app.example.com/' } })]
    expect(lastBrowserRequest(items)).toBeNull()
    const mixed = [...items, item('2', { local: true, tool_name: 'browser_navigate', params: { url: 'https://example.com/' } })]
    expect(lastBrowserRequest(mixed)).toEqual({ profile: undefined, url: 'https://example.com/' })
  })
})

describe('closed detection', () => {
  test('a successful close as the newest own call is closed', () => {
    const run = [live({ action: 'open', url: 'https://status.example.com/' }, { result: { text: '{"ok":true}' } }), live({ action: 'close' }, { result: { text: '{"ok":true,"closed":true}' } })]
    expect(ownChromeClosed(run)).toBe(true)
  })

  test('a call after the close reopens it; a failed close is not closed', () => {
    const reopened = [live({ action: 'close' }, { result: { text: '{"ok":true}' } }), live({ action: 'read' }, { result: { text: '{"ok":true}' } })]
    expect(ownChromeClosed(reopened)).toBe(false)
    const failed = [live({ action: 'close' }, { status: 'error', result: { text: '{"ok":false,"detail":"No tab to close"}', isError: true } })]
    expect(ownChromeClosed(failed)).toBe(false)
    expect(ownChromeClosed([])).toBe(false)
  })

  test('the person closing or leaving the tab is closed; another failure is not', () => {
    const fail = (error: string) => live({ action: 'click', name: 'Continue' }, { status: 'error', result: { text: `{"ok":false,"error":"${error}","detail":"x"}`, isError: true } })
    expect(ownChromeClosed([live({ action: 'open' }, { result: { text: '{"ok":true}' } }), fail('browser_live_person_switched')])).toBe(true)
    expect(ownChromeClosed([fail('browser_live_tab_not_front')])).toBe(false)
  })
})

describe('leadingJson', () => {
  test('reads the first object, ignores a trailing non-JSON line, and respects braces inside strings', () => {
    expect(leadingJson('{"a":"x}y","b":{"c":1}}\nThe rest did not run.')).toEqual({ a: 'x}y', b: { c: 1 } })
    expect(leadingJson('no json here')).toBeNull()
    expect(leadingJson('{"a":')).toBeNull()
  })
})

describe('browserErrorSummary', () => {
  test('a steps failure is a headline with the step and reason, and its hint; no error code', () => {
    const text = '{"ok":false,"error":"step_failed","detail":"Step 3 (click) failed: no element matches #continue","hint":"Read the page again."}\nThe steps after step 3 did not run.'
    const s = browserErrorSummary(text)
    expect(s).toEqual({ headline: 'Stopped at step 3: no element matches #continue', hint: 'Read the page again.' })
    expect(s.headline).not.toContain('step_failed')
  })

  test('a failure with only a detail or an error message is that text; text without JSON is shown as it is', () => {
    expect(browserErrorSummary('{"ok":false,"detail":"The tab is gone"}')).toEqual({ headline: 'The tab is gone', hint: '' })
    expect(browserErrorSummary('{"ok":false,"message":"Timed out"}')).toEqual({ headline: 'Timed out', hint: '' })
    expect(browserErrorSummary('Something went wrong')).toEqual({ headline: 'Something went wrong', hint: '' })
  })

  test('a steps failure counts its steps, and the line after the JSON is not part of it', () => {
    const text =
      '{"ok":false,"ran":1,"of":4,"error":"browser_live_person_switched","detail":"Step 1 (click) failed: The tab in front is not the one this chat opened.","hint":"Open it again."}\n - To: Example Owner'
    expect(browserErrorSummary(text)).toEqual({ headline: 'Stopped at step 1 of 4: The tab in front is not the one this chat opened.', hint: 'Open it again.' })
  })

  test('a failure that names only its code reads in words, never as the code', () => {
    expect(browserErrorSummary('{"error":"browser_live_tab_not_front"}').headline).toBe('The tab in front is not the one this chat opened')
    expect(browserErrorSummary('{"error":"browser_live_something_new"}').headline).toBe('The browser step did not finish')
    expect(browserErrorSummary('{"error":"Chrome is not running"}').headline).toBe('Chrome is not running')
  })
})
