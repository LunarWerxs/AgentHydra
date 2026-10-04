// web/tests/session-unread.test.ts - which sessions show a bold (unread) title in the list
// (web/src/lib/session-unread.ts).
//
// A wrong rule either bolds the whole list (every session, on first use) or never bolds the one that
// moved, which is the only thing the mark is for.

import { expect, test } from 'bun:test'
import {
  isUnread,
  markSeen,
  pruneSeen,
  type SeenState,
  UNREAD_HORIZON_MS,
} from '../src/lib/session-unread'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_780_000_000_000

test('a session is unread only when it moved after you last opened it', () => {
  let s: SeenState = { since: T0, seen: {} }
  // First use: everything that moved before tracking started is read.
  expect(isUnread(s, 'claude:a', T0 - 5 * DAY)).toBe(false)
  // It moved afterwards and nobody opened it.
  expect(isUnread(s, 'claude:a', T0 + 1000)).toBe(true)
  // Opened at that activity: read. It moves again: unread.
  s = markSeen(s, 'claude:a', T0 + 1000)
  expect(isUnread(s, 'claude:a', T0 + 1000)).toBe(false)
  expect(isUnread(s, 'claude:a', T0 + 2000)).toBe(true)
  // A mark never moves back: an older reading of the same session leaves it as it was.
  expect(markSeen(s, 'claude:a', T0 + 500)).toBe(s)
  // Another session is its own mark.
  expect(isUnread(s, 'codex:a', T0 + 1000)).toBe(true)
})

test('pruning old marks never turns a read session unread', () => {
  const now = T0 + 60 * DAY
  const before: SeenState = {
    since: T0,
    seen: { 'claude:old': T0 + 2 * DAY, 'claude:new': now - 2 * DAY },
  }
  const after = pruneSeen(before, now)
  expect(Object.keys(after.seen)).toEqual(['claude:new'])
  expect(after.since).toBe(now - UNREAD_HORIZON_MS)
  for (const [key, at] of [
    ['claude:old', T0 + 2 * DAY],
    ['claude:new', now - 2 * DAY],
    ['claude:never-opened', T0 - DAY],
  ] as const)
    expect(isUnread(after, key, at)).toBe(isUnread(before, key, at))
  // Nothing to drop: the same state back, so storage is not rewritten.
  expect(pruneSeen(after, now)).toBe(after)
})
