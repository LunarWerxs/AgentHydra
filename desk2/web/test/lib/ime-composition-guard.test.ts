import { afterEach, describe, expect, it } from 'bun:test'
import { installImeCompositionGuard } from '@/lib/ime-composition-guard'

// A keystroke that belongs to an input method never reaches the window's key handlers (the composer's Enter, a
// permission card's digits): main.ts installs this one document guard, and the handlers no longer check for it.
const g = globalThis as { Element?: unknown }
const hadElement = 'Element' in g
afterEach(() => {
  if (!hadElement) delete g.Element
})

function key(type: 'keydown' | 'keyup', init: { key: string; code?: string; isComposing?: boolean; keyCode?: number }): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code: init.code ?? init.key, ...init })
}

function guarded(): { doc: EventTarget; seen: string[]; uninstall: () => void } {
  g.Element ??= class {}
  const doc = new EventTarget()
  const uninstall = installImeCompositionGuard({ target: doc as unknown as Document })
  const seen: string[] = []
  doc.addEventListener('keydown', (e) => seen.push(`down ${(e as unknown as { key: string }).key}`))
  doc.addEventListener('keyup', (e) => seen.push(`up ${(e as unknown as { key: string }).key}`))
  return { doc, seen, uninstall }
}

describe('IME composition guard', () => {
  it('keeps a composing Enter and the keyup paired with it from the handlers', () => {
    const { doc, seen, uninstall } = guarded()
    doc.dispatchEvent(key('keydown', { key: 'Enter', isComposing: true }))
    doc.dispatchEvent(key('keyup', { key: 'Enter' }))
    expect(seen).toEqual([])
    uninstall()
  })

  it("stops Safari's commit Enter, which reports keyCode 229 with isComposing false", () => {
    const { doc, seen, uninstall } = guarded()
    doc.dispatchEvent(key('keydown', { key: 'Enter', keyCode: 229, isComposing: false }))
    expect(seen).toEqual([])
    uninstall()
  })

  it('lets ordinary keys through, and a composing digit is stopped like Enter', () => {
    const { doc, seen, uninstall } = guarded()
    doc.dispatchEvent(key('keydown', { key: 'Enter' }))
    doc.dispatchEvent(key('keyup', { key: 'Enter' }))
    doc.dispatchEvent(key('keydown', { key: '1', code: 'Digit1', isComposing: true }))
    doc.dispatchEvent(key('keydown', { key: '1', code: 'Digit1' }))
    expect(seen).toEqual(['down Enter', 'up Enter', 'down 1'])
    uninstall()
  })

  it('is installed once per document, and its uninstall lets composing keys through again', () => {
    const { doc, seen, uninstall } = guarded()
    expect(installImeCompositionGuard({ target: doc as unknown as Document })).toBe(uninstall)
    uninstall()
    doc.dispatchEvent(key('keydown', { key: 'Enter', isComposing: true }))
    expect(seen).toEqual(['down Enter'])
  })
})
