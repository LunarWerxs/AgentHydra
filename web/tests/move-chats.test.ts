// web/tests/move-chats.test.ts - the pure half of "Move chats to account" on an Instances row
// (web/src/lib/move-chats.ts): which destinations the submenu offers, and which of an account's
// store rows the move takes.
import { expect, test } from 'bun:test'
import type { ChatListRow } from '../src/lib/api'
import { moveTargets, planMove } from '../src/lib/move-chats'

const inst = (dir: string, isRunning: boolean, label = dir) => ({ dir, isRunning, label })
const label = (i: { label: string }) => i.label

test('closed destinations are hidden until asked for; running ones come first, then by name', () => {
  const me = inst('c:/i/me', true)
  const fleet = [
    inst('c:/i/zed', false, 'zed'),
    inst('c:/i/bob', true, 'bob'),
    me,
    inst('c:/i/amy', false, 'amy'),
    inst('c:/i/cat', true, 'cat'),
  ]
  expect(moveTargets(fleet, me, false, label).map(label)).toEqual(['bob', 'cat'])
  expect(moveTargets(fleet, me, true, label).map(label)).toEqual(['bob', 'cat', 'amy', 'zed'])
})

test('the source row itself is never a destination, whichever way the switch is set', () => {
  const me = inst('c:/i/me', true)
  for (const show of [false, true])
    expect(moveTargets([me, inst('c:/i/other', true)], me, show, label).map(label)).toEqual([
      'c:/i/other',
    ])
})

const row = (over: Partial<ChatListRow>): ChatListRow => ({
  instance: 'x',
  chatId: 'local_a',
  sessionId: 'sid-a',
  title: 'A real chat',
  archived: false,
  isArchived: false,
  lastActivityAt: null,
  cwd: null,
  live: false,
  livePid: null,
  done: false,
  ...over,
})

test('a plan takes every unarchived row with a transcript, and counts what it leaves behind', () => {
  const plan = planMove([
    row({ sessionId: 'sid-1', title: 'one' }),
    row({ sessionId: 'sid-2', title: 'two', done: true }),
    row({ sessionId: null, chatId: 'local_app-made', title: 'desktop only' }),
    row({ sessionId: 'sid-4', title: 'four', isArchived: true, archived: true }),
    row({ sessionId: 'sid-5', title: null, live: true, livePid: 77 }),
  ])
  expect(plan.chats.map((c) => c.sessionId)).toEqual(['sid-1', 'sid-5'])
  expect(plan.skippedDone).toBe(1)
  expect(plan.skippedNoSession).toBe(1)
})

test('a live chat is still in the plan: the route stops it, that is what a person-driven move means', () => {
  const plan = planMove([row({ live: true, livePid: 1234 })])
  expect(plan.chats).toHaveLength(1)
})

test('an archived row is neither moved nor counted as skipped - it was never in scope', () => {
  const plan = planMove([row({ isArchived: true, archived: true })])
  expect(plan).toEqual({ chats: [], skippedDone: 0, skippedNoSession: 0 })
})
