import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARM_MS, BURST_MS, keyIsForCard, keysTaken, permissionKeyAction, type KeyLike, type KeyMoment } from '../../src/components/transcript/lib/requests'

// The docked permission card's keys: what each key does, and when the card leaves keys alone.
const body = { tagName: 'BODY', closest: () => null } as unknown as EventTarget
const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, target: body, ...over })
const offered = { canAlwaysAllow: true }
const bare = { canAlwaysAllow: false }

describe('permissionKeyAction', () => {
  it('Enter or 1 allows, 2 allows for the session, 3 always allows, Esc denies', () => {
    expect(permissionKeyAction(key('Enter'), offered)).toBe('allow')
    expect(permissionKeyAction(key('1'), offered)).toBe('allow')
    expect(permissionKeyAction(key('2'), offered)).toBe('session')
    expect(permissionKeyAction(key('3'), offered)).toBe('always')
    expect(permissionKeyAction(key('Escape'), offered)).toBe('deny')
    expect(permissionKeyAction(key('4'), offered)).toBeNull()
    expect(permissionKeyAction(key('a'), offered)).toBeNull()
  })

  it('2 and 3 do nothing when the card offers no rule to save', () => {
    expect(permissionKeyAction(key('2'), bare)).toBeNull()
    expect(permissionKeyAction(key('3'), bare)).toBeNull()
    expect(permissionKeyAction(key('1'), bare)).toBe('allow')
  })

  it('a prompt the SDK starts on No takes no one-key approval of any kind; Esc still denies', () => {
    const no = { canAlwaysAllow: true, defaultToNo: true }
    expect(permissionKeyAction(key('Enter'), no)).toBeNull()
    expect(permissionKeyAction(key('1'), no)).toBeNull()
    expect(permissionKeyAction(key('2'), no)).toBeNull()
    expect(permissionKeyAction(key('3'), no)).toBeNull()
    expect(permissionKeyAction(key('Escape'), no)).toBe('deny')
  })

  it('never acts while the owner types, with a modifier, mid-composition or once something else took the key', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(permissionKeyAction(key('1', { target: { tagName, closest: () => null } as unknown as EventTarget }), offered)).toBeNull()
      expect(permissionKeyAction(key('Escape', { target: { tagName, closest: () => null } as unknown as EventTarget }), offered)).toBeNull()
    }
    expect(permissionKeyAction(key('1', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }), offered)).toBeNull()
    expect(permissionKeyAction(key('1', { ctrlKey: true }), offered)).toBeNull()
    expect(permissionKeyAction(key('1', { metaKey: true }), offered)).toBeNull()
    expect(permissionKeyAction(key('1', { altKey: true }), offered)).toBeNull()
    expect(permissionKeyAction(key('Enter', { isComposing: true }), offered)).toBeNull()
    expect(permissionKeyAction(key('Escape', { defaultPrevented: true }), offered)).toBeNull()
  })

  it('Enter on a focused button or link is that control\'s; digits still answer', () => {
    const button = { tagName: 'BUTTON', closest: () => null } as unknown as EventTarget
    expect(permissionKeyAction(key('Enter', { target: button }), offered)).toBeNull()
    expect(permissionKeyAction(key('1', { target: button }), offered)).toBe('allow')
    expect(permissionKeyAction(key('Enter', { target: { tagName: 'A', closest: () => null } as unknown as EventTarget }), offered)).toBeNull()
  })

  it('keys inside an open menu or dialog belong to it', () => {
    const inMenu = { tagName: 'DIV', closest: (s: string) => (s.includes('[role="menu"]') ? {} : null) } as unknown as EventTarget
    expect(keysTaken(inMenu)).toBe(true)
    expect(permissionKeyAction(key('Escape', { target: inMenu }), offered)).toBeNull()
    expect(keysTaken(null)).toBe(false)
  })
})

describe('keyIsForCard: a key the owner typed for the composer never answers', () => {
  const inside = { tagName: 'BUTTON' } as unknown as EventTarget
  const docked = 10_000
  // A quiet key on the body well after the card docked.
  const moment = (over: Partial<KeyMoment> = {}): KeyMoment => ({ now: docked + 2_000, mountedAt: docked, prevKeyAt: null, inCard: false, target: body, ...over })

  it('a key to the card or the page body, once the card is up and the keyboard was quiet, is the card\'s', () => {
    expect(keyIsForCard(moment())).toBe(true)
    expect(keyIsForCard(moment({ target: inside, inCard: true }))).toBe(true)
    expect(keyIsForCard(moment({ target: { tagName: 'HTML' } as unknown as EventTarget }))).toBe(true)
    expect(keyIsForCard(moment({ prevKeyAt: docked + 2_000 - BURST_MS }))).toBe(true)
  })

  it('not a key to some other control (the box is hidden, but a key can still reach a sidebar button or a field)', () => {
    expect(keyIsForCard(moment({ target: { tagName: 'BUTTON' } as unknown as EventTarget }))).toBe(false)
    expect(keyIsForCard(moment({ target: { tagName: 'TEXTAREA' } as unknown as EventTarget }))).toBe(false)
    expect(keyIsForCard(moment({ target: null }))).toBe(false)
  })

  it('not in the first moments after the card docks', () => {
    expect(keyIsForCard(moment({ now: docked }))).toBe(false)
    expect(keyIsForCard(moment({ now: docked + ARM_MS - 1 }))).toBe(false)
    expect(keyIsForCard(moment({ now: docked + ARM_MS }))).toBe(true)
  })

  it('not a key in a typing burst: "...step 3" typed on through the dock answers nothing', () => {
    // He was typing when the card docked and the box hid; the keys go on reaching the body.
    let prev = docked - 120
    for (let now = docked + 150; now < docked + 3_000; now += 180) {
      expect(keyIsForCard(moment({ now, prevKeyAt: prev }))).toBe(false)
      prev = now
    }
    // He stops, reads the card, then answers.
    expect(keyIsForCard(moment({ now: prev + BURST_MS, prevKeyAt: prev }))).toBe(true)
    // A pause shorter than a burst gap across the dock still counts as typing.
    expect(keyIsForCard(moment({ now: docked + ARM_MS + 50, prevKeyAt: docked - 50 }))).toBe(false)
  })

  it('not an auto-repeated key (a held Enter, or a held digit)', () => {
    expect(keyIsForCard(moment({ repeat: true }))).toBe(false)
    expect(keyIsForCard(moment({ repeat: true, inCard: true, target: inside }))).toBe(false)
  })
})

describe('the docked card wires the keys', () => {
  const card = readFileSync(join(import.meta.dir, '../../src/components/transcript/parts/PermissionCard.vue'), 'utf8')
  it('listens only when docked, and never while the deny reason box is open', () => {
    expect(card).toContain("if (props.docked) window.addEventListener('keydown', onKey)")
    expect(card).toContain("onBeforeUnmount(() => window.removeEventListener('keydown', onKey))")
    expect(card).toMatch(/if \(ctx\.readOnly\.value \|\| busy\.value \|\| denying\.value \|\| props\.item\.state !== 'pending'\) return/)
  })

  it('asks keyIsForCard before any key acts, with the window-wide key clock', () => {
    expect(card).toContain('prevKeyAt: keyBefore(), repeat: e.repeat, inCard: el.contains(')
    expect(card.indexOf('if (!keyIsForCard(moment)) return')).toBeGreaterThan(0)
    expect(card.indexOf('if (!keyIsForCard(moment)) return')).toBeLessThan(card.indexOf('const action = permissionKeyAction(e, props.item)'))
    const clock = readFileSync(join(import.meta.dir, '../../src/components/transcript/lib/key-clock.ts'), 'utf8')
    expect(clock).toContain('{ capture: true }')
  })
})
