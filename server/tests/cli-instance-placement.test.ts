// server/tests/cli-instance-placement.test.ts — what an account's priority and caps (AccountPlacement) may be.
//
// The contract (core/cli-instances.ts setCliInstancePlacement, behind POST /api/cli-instances/:id/placement):
// a priority is one of the four levels and a cap a whole percent from 1 to 84, 85 and over (or empty) being
// the fleet's line; anything else is refused and nothing is stored, since placement trusts the stored value
// and the queue snapshot carries it to the other PCs. A field left out keeps its value, so a partial ask
// never wipes a cap there too. CONFIG_DIR is a temp folder (tests/setup.ts).

import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  setCliInstancePlacement,
} from '../src/core/cli-instances'

const id = randomUUID()
createCliInstance('Example Placement', { id })
afterAll(() => {
  deleteCliInstance(id, 'Example Placement')
})

test('only the four levels and caps from 1 to 84 are stored; 85 and over is the fleet line', () => {
  for (const bad of [
    { priority: 3 },
    { priority: true },
    { priority: '' },
    { maxSessionPct: 0 },
    { maxWeekPct: 'abc' },
    { maxWeekPct: false },
  ]) {
    expect(setCliInstancePlacement(id, bad).ok).toBe(false)
  }
  expect(getCliInstance(id)?.placement).toBeUndefined()
  expect(
    setCliInstancePlacement(id, { priority: '2', maxSessionPct: '50', maxWeekPct: 85 }).ok,
  ).toBe(true)
  expect(getCliInstance(id)?.placement).toMatchObject({
    priority: 2,
    maxSessionPct: 50,
    maxWeekPct: null,
  })
})

test('a field left out keeps its value, and null clears a cap', () => {
  expect(setCliInstancePlacement(id, { priority: 2, maxSessionPct: 50, maxWeekPct: 40 }).ok).toBe(
    true,
  )
  expect(setCliInstancePlacement(id, { priority: 1 }).ok).toBe(true)
  expect(getCliInstance(id)?.placement).toMatchObject({
    priority: 1,
    maxSessionPct: 50,
    maxWeekPct: 40,
  })
  expect(setCliInstancePlacement(id, { maxSessionPct: null }).ok).toBe(true)
  expect(getCliInstance(id)?.placement).toMatchObject({
    priority: 1,
    maxSessionPct: null,
    maxWeekPct: 40,
  })
})
