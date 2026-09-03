// web/tests/session-multiselect.test.ts - Shift-click ranges in the session list
// (web/src/lib/session-multiselect.ts).
//
// The contract is the one every file manager has: everything between the anchor and the clicked
// row, inclusive, in list order, whichever direction you went. The two degradations are the part
// worth pinning: a clicked row that is not in the list selects nothing, and an anchor that has
// left the list (the filter changed) selects just the clicked row rather than a guessed range.

import { expect, test } from 'bun:test'
import { rangeBetween } from '../src/lib/session-multiselect'

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
