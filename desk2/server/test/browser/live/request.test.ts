// browser_live's request contract: which actions exist, what each one needs, and what is refused before the engine runs.

import { describe, expect, test } from 'bun:test'
import { browserLiveRequest } from '../../../src/browser/live/request'

const refusedCode = (args: Record<string, unknown>) => {
  const built = browserLiveRequest(args)
  if (!('error' in built)) throw new Error(`expected a refusal, got ${JSON.stringify(built.request)}`)
  return built.error[0]
}

describe('browser_live request contract', () => {
  test('an unknown action is refused before the engine runs', () => {
    expect(refusedCode({ action: 'fly' })).toBe('browser_live_unknown_action')
  })

  test('open takes only an http(s) address', () => {
    expect(refusedCode({ action: 'open', url: 'file:///C:/Users/me/secret.txt' })).toBe('browser_live_url_refused')
    expect(refusedCode({ action: 'open', url: 'javascript:alert(1)' })).toBe('browser_live_url_refused')
    expect(refusedCode({ action: 'open' })).toBe('browser_live_url_required')
    const built = browserLiveRequest({ action: 'open', url: 'https://example.test/cart' })
    expect(built).toMatchObject({ request: { action: 'open', url: 'https://example.test/cart' } })
  })

  test('a tag must be a short plain name', () => {
    expect(refusedCode({ action: 'tag', tag: '<script>' })).toBe('browser_live_tag_invalid')
    expect(refusedCode({ action: 'tag', tag: 'x'.repeat(41) })).toBe('browser_live_tag_invalid')
    expect(refusedCode({ action: 'tag' })).toBe('browser_live_tag_required')
    expect(browserLiveRequest({ action: 'tag', tag: '  work  ' })).toMatchObject({ request: { tag: 'work' } })
  })

  test('a step may not name a window or a tab of its own', () => {
    expect(refusedCode({ action: 'steps', steps: [{ action: 'click', name: 'Save', window: 'work' }] })).toBe('browser_live_step_refused')
  })

  test('a step may not open, close or tag', () => {
    expect(refusedCode({ action: 'steps', steps: [{ action: 'open', url: 'https://example.test' }] })).toBe('browser_live_step_refused')
  })

  test('one call takes at most thirty steps', () => {
    const steps = Array.from({ length: 31 }, () => ({ action: 'wait' }))
    expect(refusedCode({ action: 'steps', steps })).toBe('browser_live_steps_too_many')
  })

  test('screenshot detail must be a known level', () => {
    expect(refusedCode({ action: 'screenshot', detail: 'huge' })).toBe('screenshot_detail_unknown')
  })

  test('screenshot quick scales the image down', () => {
    expect(browserLiveRequest({ action: 'screenshot', detail: 'quick' })).toMatchObject({
      request: { action: 'screenshot', maxWidth: 800, quality: 45 },
    })
  })

  test('find splits on | and drops empty parts', () => {
    expect(browserLiveRequest({ action: 'read', find: 'Save | Cancel |' })).toMatchObject({ request: { find: ['Save', 'Cancel'] } })
  })

  test('max is clamped to 1..1500 and an offset implies a mouse click', () => {
    expect(browserLiveRequest({ action: 'read', max: 9999 })).toMatchObject({ request: { max: 1500 } })
    expect(browserLiveRequest({ action: 'click', name: 'Save', offsetX: 5 })).toMatchObject({
      request: { offsetX: 5, mouse: true },
    })
  })
})
