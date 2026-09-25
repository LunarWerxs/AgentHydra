// web/src/composables/useSortable.ts — the settled order. A refresh lands usage readings one at a
// time; before the settle, every arrival re-sorted the table and rows machine-gunned up and down
// (owner, 2026-09-25). Rows must hold still until the data is quiet, and a sort change is instant.
import { expect, test } from 'bun:test'
import { effectScope, nextTick, ref } from 'vue'
import { useSortable } from '../src/composables/useSortable'

interface Row {
  id: string
  pct: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('rows hold their place while readings land, then move once, and a sort change is instant', async () => {
  const rows = ref<Row[]>([
    { id: 'a', pct: 1 },
    { id: 'b', pct: 2 },
    { id: 'c', pct: 3 },
  ])
  const key = ref('pct')
  const direction = ref('asc')
  const scope = effectScope()
  const table = scope.run(() =>
    useSortable(
      () => rows.value,
      [{ key: 'pct', accessor: (r: Row) => r.pct }],
      { key, direction },
      { rowKey: (r) => r.id, settleMs: 40 },
    ),
  )!
  const order = () => table.sortedRows.value.map((r) => r.id).join('')
  await nextTick()
  expect(order()).toBe('abc')

  // Two readings arrive back to back: the cells change, the positions do not.
  rows.value = [
    { id: 'a', pct: 9 },
    { id: 'b', pct: 2 },
    { id: 'c', pct: 3 },
  ]
  await nextTick()
  rows.value = [
    { id: 'a', pct: 9 },
    { id: 'b', pct: 8 },
    { id: 'c', pct: 3 },
  ]
  await nextTick()
  expect(order()).toBe('abc')
  expect(table.sortedRows.value[0].pct).toBe(9)

  await sleep(80)
  expect(order()).toBe('cba')

  // The user's own click re-sorts at once.
  direction.value = 'desc'
  await nextTick()
  expect(order()).toBe('abc')
  scope.stop()
})
