// web/tests/session-multiselect.test.ts - Shift-click ranges in the session list
// (web/src/lib/session-multiselect.ts).
//
// The contract is the one every file manager has: everything between the anchor and the clicked
// row, inclusive, in list order, whichever direction you went. The two degradations are the part
// worth pinning: a clicked row that is not in the list selects nothing, and an anchor that has
// left the list (the filter changed) selects just the clicked row rather than a guessed range.

import { expect, test } from 'bun:test'
import { applySelectionRequests, bandRange, rangeBetween } from '../src/lib/session-multiselect'

const keys = ['a', 'b', 'c', 'd', 'e']

test('forward range is inclusive of both ends', () => {
  expect(rangeBetween(keys, 'b', 'd')).toEqual(['b', 'c', 'd'])
})

test('backward range gives the same rows in list order', () => {
  expect(rangeBetween(keys, 'd', 'b')).toEqual(['b', 'c', 'd'])
})

test('anchor and target the same row is a range of one', () => {
  expect(rangeBetween(keys, 'c', 'c')).toEqual(['c'])
})

test('an anchor no longer in the list degrades to the clicked row alone', () => {
  expect(rangeBetween(keys, 'gone', 'c')).toEqual(['c'])
})

test('a clicked row not in the list selects nothing', () => {
  expect(rangeBetween(keys, 'a', 'gone')).toEqual([])
})

test('does not mutate its input', () => {
  const frozen = Object.freeze(['x', 'y', 'z'])
  expect(rangeBetween(frozen, 'z', 'x')).toEqual(['x', 'y', 'z'])
})

// Selection requests: every gesture (Shift-click, Ctrl+A, box drag) is applied through
// applySelectionRequests. Pinned: setAll true drops keys the filter hides (the old checkAllFiltered
// behaviour), setRange leaves rows outside the range alone, and the input Set is never mutated
// (a mutated reactive Set would not re-render the checkboxes).

test('setAll true selects exactly the visible keys, dropping hidden ones', () => {
  const next = applySelectionRequests(keys, new Set(['hidden', 'a']), [
    { type: 'setAll', selected: true },
  ])
  expect([...next].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('setAll false clears everything', () => {
  const next = applySelectionRequests(keys, new Set(['a', 'b']), [
    { type: 'setAll', selected: false },
  ])
  expect(next.size).toBe(0)
})

test('setRange adds a range and keeps what was selected outside it', () => {
  const next = applySelectionRequests(keys, new Set(['a']), [
    { type: 'setRange', first: 'd', last: 'c', selected: true },
  ])
  expect([...next].sort()).toEqual(['a', 'c', 'd'])
})

test('setRange false deselects only the range', () => {
  const next = applySelectionRequests(keys, new Set(keys), [
    { type: 'setRange', first: 'b', last: 'c', selected: false },
  ])
  expect([...next].sort()).toEqual(['a', 'd', 'e'])
})

test('requests apply in order and the input set is left untouched', () => {
  const current = new Set(['e'])
  const next = applySelectionRequests(keys, current, [
    { type: 'setAll', selected: false },
    { type: 'setRange', first: 'a', last: 'b', selected: true },
  ])
  expect([...next].sort()).toEqual(['a', 'b'])
  expect([...current]).toEqual(['e'])
})

// Box select: the band's vertical overlap alone picks a contiguous first..last range. Pinned: a
// band dragged upward gives the same range, a band sitting in the gap between rows touches none,
// and merely touching a row's edge does not count as covering it.

const rows = [
  { key: 'a', top: 0, bottom: 40 },
  { key: 'b', top: 46, bottom: 86 },
  { key: 'c', top: 92, bottom: 132 },
]

test('a band over two rows is the range between them, in either direction', () => {
  expect(bandRange(rows, 10, 60)).toEqual({ first: 'a', last: 'b' })
  expect(bandRange(rows, 100, 20)).toEqual({ first: 'a', last: 'c' })
})

test('a band in the gap between rows, or only touching an edge, selects nothing', () => {
  expect(bandRange(rows, 41, 45)).toBeNull()
  expect(bandRange(rows, 40, 46)).toBeNull()
})
