// useSortable — click-header sort (asc → desc → none) for a rows+columns table.
// Generic over the row type; each column declares its own accessor so callers don't need
// to pre-shape their data. Kept tiny and dependency-free so it's easy to reuse on other
// tables (Sessions/Queue) later, per PLAN.md §4.
import { computed, onScopeDispose, type Ref, ref, type WritableComputedRef, watch } from 'vue'

export type SortDirection = 'asc' | 'desc' | null

export interface SortableColumn<Row> {
  /** Stable key identifying this column; also what `sortKey` holds while active. */
  key: string
  /** Extracts the comparable value for a row. Return null/undefined to sort it last. */
  accessor: (row: Row) => string | number | boolean | null | undefined
}

/**
 * Where a table keeps its sort when it should outlive the component: two plain string refs, in the
 * shape a persisted preference already has (see composables/useUiPrefs.ts). `''` means "no sort" in
 * both, because a remembered value round-trips through storage as a string and `null` does not.
 */
export interface PersistedSort {
  key: Ref<string>
  direction: Ref<string>
}

/** Hold row positions still while the sort's inputs are still arriving (see the SETTLED ORDER note). */
export interface SortSettleOptions<Row> {
  /** Identifies a row across data refreshes. */
  rowKey: (row: Row) => string
  /** How long the sort's inputs must stay quiet before rows move. Default 1500ms. */
  settleMs?: number
}

/**
 * Click-to-sort state machine for a table. Cycles a column through
 * asc -> desc -> none (back to the original/unsorted `rows` order) on repeated clicks.
 *
 * Pass `persisted` to have the table remember its sort. A remembered key that no longer names a
 * column (one was renamed or removed since it was saved), or a direction that is not asc/desc,
 * reads as "unsorted" instead of leaving the table in a state no header can show or undo.
 */
export function useSortable<Row>(
  rows: () => readonly Row[],
  columns: SortableColumn<Row>[],
  persisted?: PersistedSort,
  settle?: SortSettleOptions<Row>,
) {
  const columnsByKey = new Map(columns.map((c) => [c.key, c]))

  const sortKey: Ref<string | null> | WritableComputedRef<string | null> = persisted
    ? computed({
        get: () => (columnsByKey.has(persisted.key.value) ? persisted.key.value : null),
        set: (value) => {
          persisted.key.value = value ?? ''
        },
      })
    : ref<string | null>(null)
  const sortDirection: Ref<SortDirection> | WritableComputedRef<SortDirection> = persisted
    ? computed({
        get: () => {
          const value = persisted.direction.value
          return sortKey.value && (value === 'asc' || value === 'desc') ? value : null
        },
        set: (value) => {
          persisted.direction.value = value ?? ''
        },
      })
    : ref<SortDirection>(null)

  function toggleSort(key: string) {
    if (!columnsByKey.has(key)) return
    if (sortKey.value !== key) {
      sortKey.value = key
      sortDirection.value = 'asc'
      return
    }
    if (sortDirection.value === 'asc') {
      sortDirection.value = 'desc'
    } else if (sortDirection.value === 'desc') {
      sortKey.value = null
      sortDirection.value = null
    } else {
      sortDirection.value = 'asc'
    }
  }

  /** Sort indicator for a given column key: 'asc' | 'desc' | null (not the active sort). */
  function indicatorFor(key: string): SortDirection {
    return sortKey.value === key ? sortDirection.value : null
  }

  function compareValues(a: unknown, b: unknown): number {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  }

  const liveSortedRows = computed<readonly Row[]>(() => {
    const source = rows()
    const key = sortKey.value
    const dir = sortDirection.value
    if (!key || !dir) return source
    const col = columnsByKey.get(key)
    if (!col) return source
    const copy = source.slice()
    copy.sort((a, b) => {
      const left = col.accessor(a)
      const right = col.accessor(b)
      // A missing value sorts LAST in both directions, as the column contract promises. Negating
      // it with the rest put every never-launched or stopped row at the TOP of a descending sort,
      // which is exactly the wrong end for "most recent first" or "biggest first".
      if (left == null || right == null) return compareValues(left, right)
      const cmp = compareValues(left, right)
      return dir === 'asc' ? cmp : -cmp
    })
    return copy
  })

  // SETTLED ORDER. A table whose sort column is fed by readings that arrive one at a time (a page
  // refresh hydrates the usage cache, then each live check lands separately) re-sorted on every
  // arrival, so rows machine-gunned up and down the page (owner, 2026-09-25). With `settle`, the
  // cells still update live but ROW POSITIONS only move once the order has been quiet for
  // settleMs; the user's own sort change applies at once. New rows appear in their live position,
  // gone rows leave at once.
  if (!settle)
    return { sortKey, sortDirection, sortedRows: liveSortedRows, toggleSort, indicatorFor }
  const { rowKey, settleMs = 1500 } = settle
  const committed = ref<string[] | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const commit = () => {
    clearTimeout(timer)
    timer = undefined
    committed.value = liveSortedRows.value.map(rowKey)
  }
  watch([sortKey, sortDirection], commit)
  watch(
    () => liveSortedRows.value.map(rowKey).join('\n'),
    () => {
      // A row added or removed is a change of WHAT is listed: place it now. Only a reshuffle of
      // the same rows waits for the data to settle.
      const live = liveSortedRows.value.map(rowKey)
      const known = committed.value
      if (!known || known.length !== live.length || !live.every((key) => known.includes(key)))
        return commit()
      clearTimeout(timer)
      timer = setTimeout(commit, settleMs)
    },
    { immediate: true },
  )
  onScopeDispose(() => clearTimeout(timer))

  const sortedRows = computed<readonly Row[]>(() => {
    const live = liveSortedRows.value
    const rank = new Map((committed.value ?? []).map((key, index) => [key, index]))
    // The watch above commits before render whenever the row set changes, so every live row is
    // ranked; the live index only breaks a tie that cannot happen.
    return live
      .map((row, liveIndex) => ({ row, liveIndex, at: rank.get(rowKey(row)) ?? liveIndex }))
      .sort((a, b) => a.at - b.at || a.liveIndex - b.liveIndex)
      .map((r) => r.row)
  })

  return { sortKey, sortDirection, sortedRows, toggleSort, indicatorFor }
}
