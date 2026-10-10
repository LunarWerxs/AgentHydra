import { expect, test } from 'bun:test'
import { nextMessageStep } from '../../src/components/transcript/lib/steps'

// The transcript's step arrows (owner, 2026-10-09): each click on the up arrow goes one message the person sent
// further back, each on the down arrow one further on, and past the last one there is no step (the arrow then jumps
// to the bottom). Messages sit at these tops; a step lands one 50 px under the view's top.
const tops = [100, 900, 2000]
const line = 50

test('up walks back one sent message per click and down walks forward, never landing twice on one', () => {
  let at = 3000 // reading the newest output, below every message
  const ups: number[] = []
  for (let step = nextMessageStep(tops, at, 'up', line); step !== null; step = nextMessageStep(tops, at, 'up', line)) {
    ups.push(step)
    at = step
  }
  expect(ups).toEqual([1950, 850, 50])

  const downs: number[] = []
  for (let step = nextMessageStep(tops, at, 'down', line); step !== null; step = nextMessageStep(tops, at, 'down', line)) {
    downs.push(step)
    at = step
  }
  expect(downs).toEqual([850, 1950])
  // Between two messages, up goes to the one above the view and down to the one below it.
  expect(nextMessageStep(tops, 1200, 'up', line)).toBe(850)
  expect(nextMessageStep(tops, 1200, 'down', line)).toBe(1950)
  // A message near the top clamps at 0; nothing sent means no step either way.
  expect(nextMessageStep([20], 400, 'up', line)).toBe(0)
  expect(nextMessageStep([], 400, 'up', line)).toBeNull()
})
