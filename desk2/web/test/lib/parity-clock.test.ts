import { expect, test } from 'bun:test'
import { PARITY_NOW } from '../../src/dev/parity/clock'

// The Gallery's transcript section imports the parity fixtures, which are in the real window's bundle:
// reading PARITY_NOW must not freeze the window's clock (every elapsed counter read 0s).
test('importing the parity instant leaves Date.now running', () => {
  expect(Date.now()).not.toBe(PARITY_NOW)
  expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000)
})
