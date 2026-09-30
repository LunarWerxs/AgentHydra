// web/src/lib/reconcile.ts - how a poll reaches the screen only when something changed.
//
// Pins the promise the Instances tab's polls rely on: a poll that brings nothing new hands back the
// SAME list (Vue then does nothing), and a poll that changes one row hands back a new list whose
// other rows are the same objects as before (only that row re-renders).

import { describe, expect, test } from 'bun:test'
import { reconcileList, reconcileMap } from '../src/lib/reconcile'

const rows = () => [
  { id: 'a', name: 'one', usage: { pct: 10 } },
  { id: 'b', name: 'two', usage: { pct: 20 } },
]

describe('reconcileList', () => {
  test('an identical poll returns the previous list itself', () => {
    const prev = rows()
    expect(reconcileList(prev, rows(), (r) => r.id)).toBe(prev)
  })

  test('one changed row is new; the unchanged one keeps its identity', () => {
    const prev = rows()
    const next = rows()
    next[1] = { ...next[1], usage: { pct: 21 } }
    const out = reconcileList(prev, next, (r) => r.id)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toBe(next[1])
  })
})

describe('reconcileMap', () => {
  test('equal entries leave the map as it was; a changed one makes a new map', () => {
    const prev = new Map([['k', { pct: 1 }]])
    expect(reconcileMap(prev, [['k', { pct: 1 }]])).toBe(prev)
    const next = reconcileMap(prev, [['k', { pct: 2 }]])
    expect(next).not.toBe(prev)
    expect(next.get('k')).toEqual({ pct: 2 })
  })
})
