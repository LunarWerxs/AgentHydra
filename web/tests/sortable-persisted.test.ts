// web/src/composables/useSortable.ts — a table sort that survives a reload.
//
// The Instances table hands useSortable two persisted string refs (useUiPrefs), which is what makes
// the chosen ordering come back after an update, a restart or a stray F5. Pinned here:
//  * a remembered sort is applied on first read, before any click;
//  * clicks write through to the persisted refs, including back to '' for "unsorted";
//  * a remembered column that no longer exists, or a direction that is not asc/desc, reads as
//    unsorted rather than leaving the table in a state no header can show or undo;
//  * without persisted refs the composable behaves exactly as it always did.
import { expect, test } from 'bun:test'
import { ref } from 'vue'
import { useSortable } from '../src/composables/useSortable'

interface Row {
  name: string
  launched: number | null
}

const rows: Row[] = [
  { name: 'b', launched: 200 },
  { name: 'a', launched: null },
  { name: 'c', launched: 100 },
]
const columns = [
  { key: 'name', accessor: (r: Row) => r.name },
  { key: 'lastLaunched', accessor: (r: Row) => r.launched ?? undefined },
]
const names = (list: readonly Row[]) => list.map((r) => r.name)

test('a remembered sort is applied before any click', () => {
  const key = ref('lastLaunched')
  const direction = ref('desc')
  const { sortedRows, indicatorFor } = useSortable(() => rows, columns, { key, direction })
  // Newest first, and a never-launched row still sorts last whichever way the column runs.
  expect(names(sortedRows.value)).toEqual(['b', 'c', 'a'])
  expect(indicatorFor('lastLaunched')).toBe('desc')
})

test('clicks write through, all the way back to unsorted', () => {
  const key = ref('')
  const direction = ref('')
  const { toggleSort, sortedRows } = useSortable(() => rows, columns, { key, direction })
  toggleSort('name')
  expect([key.value, direction.value]).toEqual(['name', 'asc'])
  expect(names(sortedRows.value)).toEqual(['a', 'b', 'c'])
  toggleSort('name')
  expect([key.value, direction.value]).toEqual(['name', 'desc'])
  toggleSort('name')
  expect([key.value, direction.value]).toEqual(['', ''])
  expect(names(sortedRows.value)).toEqual(['b', 'a', 'c'])
})

test('a stale column or a bad direction reads as unsorted and can still be re-sorted', () => {
  const key = ref('columnThatWasRemoved')
  const direction = ref('asc')
  const { sortedRows, indicatorFor, toggleSort } = useSortable(() => rows, columns, {
    key,
    direction,
  })
  expect(names(sortedRows.value)).toEqual(['b', 'a', 'c'])
  expect(indicatorFor('name')).toBeNull()

  key.value = 'name'
  direction.value = 'sideways'
  expect(names(sortedRows.value)).toEqual(['b', 'a', 'c'])
  expect(indicatorFor('name')).toBeNull()
  toggleSort('name')
  expect([key.value, direction.value]).toEqual(['name', 'asc'])
})

test('without persisted refs the sort is in-memory, as before', () => {
  const { toggleSort, sortKey, sortDirection, sortedRows } = useSortable(() => rows, columns)
  expect(sortKey.value).toBeNull()
  toggleSort('lastLaunched')
  expect([sortKey.value, sortDirection.value]).toEqual(['lastLaunched', 'asc'])
  expect(names(sortedRows.value)).toEqual(['c', 'b', 'a'])
})
