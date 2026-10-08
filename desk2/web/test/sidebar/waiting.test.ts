import { expect, test } from 'bun:test'
import { externalGlyph, isActive, isWaitingForAccount, statusGlyph, waitingLine } from '../../src/components/sidebar/logic'

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

// Active only keeps the rows whose dot is active: running, starting, done with background work still running, or
// waiting on you, which includes a reply not read yet and an error (owner, 2026-10-08: "ones that are waiting on me to
// view it or do something").
test('the dot decides what Active only keeps', () => {
  type Over = Omit<Parameters<typeof statusGlyph>[0], 'unread'> & { unread?: boolean }
  const chat = (over: Over) => isActive(statusGlyph({ unread: false, ...over }))
  const cases: [string, boolean, Over][] = [
    ['a running chat', true, { status: 'working' }],
    ['a starting chat', true, { status: 'starting' }],
    ['a chat waiting on the owner', true, { status: 'needs_you' }],
    ['a finished chat with background tasks running', true, { status: 'idle', backgroundActive: 1 }],
    ['a finished chat with a CliMayte worker running', true, { status: 'idle', climayteActive: 1 }],
    ['a closed chat with background tasks running', true, { status: 'closed', backgroundActive: 2 }],
    ['an unread finished chat', true, { status: 'idle', unread: true }],
    ['an unread closed chat', true, { status: 'closed', unread: true }],
    ['a chat in error', true, { status: 'error' }],
    ['an idle chat', false, { status: 'idle' }],
    ['a closed chat', false, { status: 'closed' }],
    ['a stopped chat', false, { status: 'stopped' }],
    ['a chat at a usage limit', false, { status: 'limited' }]
  ]
  for (const [name, active, over] of cases) expect({ name, active: chat(over) }).toEqual({ name, active })
  const session = (status: 'working' | 'needs_you' | 'idle' | 'stale', unread = false) => isActive(externalGlyph({ status, unread }))
  expect(session('working')).toBe(true)
  expect(session('needs_you')).toBe(true)
  expect(session('idle', true)).toBe(true)
  expect(session('stale', true)).toBe(true)
  expect(session('idle')).toBe(false)
  expect(session('stale')).toBe(false)
  expect(isActive(undefined)).toBe(false)
})
