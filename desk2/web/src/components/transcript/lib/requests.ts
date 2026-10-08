// The docked permission card's keys (SPEC "Prompts"): Enter or 1 allows, 2 allows for this session, 3 always
// allows (2 and 3 only when offered; none of the three when the SDK starts the prompt on No), Esc denies.
// The keys never act while the owner types, or when a focused control, menu or dialog takes them.

import type { TranscriptItem } from '@shared/protocol'

export type PermissionKey = 'allow' | 'session' | 'always' | 'deny'

type PermissionItem = Extract<TranscriptItem, { kind: 'permission' }>

/** What a keydown needs to carry, so the mapping is tested without a DOM. */
export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  defaultPrevented?: boolean
  target: EventTarget | null
}

interface ElementLike {
  tagName?: string
  isContentEditable?: boolean
  closest?(selector: string): unknown
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Focus is in something that takes keys itself: a text field, or anything inside a menu, listbox or dialog. */
export function keysTaken(target: EventTarget | null): boolean {
  const el = target as ElementLike | null
  if (!el) return false
  if ((el.tagName && TYPING_TAGS.has(el.tagName)) || el.isContentEditable) return true
  return !!el.closest?.('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')
}

/** A key this soon after the card docks is not an answer to it: the owner could not have read it yet. */
export const ARM_MS = 400
/** A key this soon after the one before is part of a typing burst, not an answer. */
export const BURST_MS = 600

/** When a keydown came and where it went: the timing half of the card's key check. */
export interface KeyMoment {
  now: number
  /** When the card docked. */
  mountedAt: number
  /** The keydown before this one, anywhere in the window; null when none came. */
  prevKeyAt: number | null
  repeat?: boolean
  /** The key went to something inside the card. */
  inCard: boolean
  target: EventTarget | null
}

/**
 * The card may take this key: it went to the card or to no control at all (the page body), the card has
 * been up for ARM_MS, and it is neither auto-repeat nor part of a typing burst. A request that docks while
 * the owner types hides the composer's box, focus falls to the body, and the rest of his sentence ("step
 * 3", Enter) would otherwise answer it.
 */
export function keyIsForCard(m: KeyMoment): boolean {
  if (m.repeat) return false
  const tag = (m.target as ElementLike | null)?.tagName
  if (!m.inCard && tag !== 'BODY' && tag !== 'HTML') return false
  if (m.now - m.mountedAt < ARM_MS) return false
  return m.prevKeyAt === null || m.now - m.prevKeyAt >= BURST_MS
}

export function permissionKeyAction(e: KeyLike, item: Pick<PermissionItem, 'canAlwaysAllow' | 'defaultToNo'>): PermissionKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || keysTaken(e.target)) return null
  const tag = (e.target as ElementLike | null)?.tagName
  switch (e.key) {
    case 'Enter':
      // A focused button or link answers Enter itself.
      if (tag === 'BUTTON' || tag === 'A') return null
      return item.defaultToNo ? null : 'allow'
    case '1':
      return item.defaultToNo ? null : 'allow'
    // A prompt the SDK starts on No takes no one-key approval of any kind.
    case '2':
      return item.canAlwaysAllow && !item.defaultToNo ? 'session' : null
    case '3':
      return item.canAlwaysAllow && !item.defaultToNo ? 'always' : null
    case 'Escape':
      return 'deny'
    default:
      return null
  }
}
