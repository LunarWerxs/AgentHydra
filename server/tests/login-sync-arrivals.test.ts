// What a login sync that brings in new accounts says: one message per pass, listing each arrival by
// its number and plan, and nothing at all when nothing arrived. Invented fixtures only.
import { expect, test } from 'bun:test'
import { arrivalMessage } from '../src/login-sync-arrivals'

test('several arrivals in one pass are one message listing each', () => {
  const msg = arrivalMessage([
    { kind: 'cli', num: 7, plan: 'Max 20×' },
    { kind: 'desktop', num: 3, plan: null },
  ])
  expect(msg?.title).toBe('Login sync: 2 new accounts')
  expect(msg?.body).toBe(
    'Added by the sync: Claude CLI account #7 (Max 20×); Claude desktop instance #3.',
  )
})

test('no arrivals means no message', () => {
  expect(arrivalMessage([])).toBeNull()
})
