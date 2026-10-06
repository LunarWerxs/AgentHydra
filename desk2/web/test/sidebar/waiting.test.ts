import { expect, test } from 'bun:test'
import { isWaitingForAccount, statusGlyph, waitingLine } from '../../src/components/sidebar/logic'

// A CliMayte chat whose worker waits for an account is status 'starting' with a `waiting` note: it must say
// Waiting (with the start time when known), and only a chat really launching says Starting.
const NOON = new Date(2026, 9, 6, 12, 0, 0).getTime()
const at = (h: number, m: number) => new Date(2026, 9, 6, h, m, 0).getTime()

test('a waiting chat says Waiting for an account, with the time it starts when one is given', () => {
  expect(waitingLine({ reason: 'x', until: at(12, 40) }, NOON)).toBe('Waiting for an account, starts about 12:40')
})

test('a waiting chat with no time, or one already past, gives no time', () => {
  expect(waitingLine({ reason: 'x', until: null }, NOON)).toBe('Waiting for an account')
  expect(waitingLine({ reason: 'x', until: NOON - 1000 }, NOON)).toBe('Waiting for an account')
})

test('the sidebar dot says Waiting for a waiting chat and Starting for a launching one', () => {
  expect(statusGlyph({ status: 'starting', unread: false, waiting: { reason: 'x', until: null } }).label).toBe('Waiting')
  expect(statusGlyph({ status: 'starting', unread: false }).label).toBe('Starting')
  expect(statusGlyph({ status: 'starting', unread: false, waiting: null }).label).toBe('Starting')
})

test('only a starting chat with a wait is waiting for an account', () => {
  expect(isWaitingForAccount({ status: 'starting', waiting: { reason: 'x', until: null } })).toBe(true)
  expect(isWaitingForAccount({ status: 'starting' })).toBe(false)
  expect(isWaitingForAccount({ status: 'working', waiting: { reason: 'x', until: null } })).toBe(false)
})
