// The rows of one instance table before they are drawn: sorted by the table's header, then run
// through the tab-wide filter (useInstanceFilter). Every instance table (Claude desktop, Claude CLI,
// Codex) gets its rows this way, so they sort and filter by the same rules; what differs is only the
// facts each kind can state about a row.
import { computed, type Ref } from 'vue'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { type PersistedSort, type SortableColumn, useSortable } from '@/composables/useSortable'
import type { UsageSnapshot } from '@/lib/api'
import type { InstanceFacts } from '@/lib/instance-filter'
import { bindingWeeklyPct } from '@/lib/usage'
import { msUntilReset } from '@/lib/usage-reset'

type Sortable = string | number | boolean | null | undefined

/**
 * The quota columns every kind sorts by the same way. Time-remaining columns sort by how long is
 * left, not by the reset timestamp: "soonest reset first" is what the question wants, and it is
 * stable as the clock advances because every row shifts by the same amount.
 */
export function quotaSortColumns<Row>(
  usageOf: (row: Row) => UsageSnapshot | null | undefined,
  planOf: (row: Row) => Sortable,
  now: Ref<Date>,
): SortableColumn<Row>[] {
  return [
    {
      key: 'session',
      accessor: (r) => msUntilReset(usageOf(r)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (r) => msUntilReset(usageOf(r)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (r) => {
        const snap = usageOf(r)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    { key: 'usageSession', accessor: (r) => usageOf(r)?.session?.pct ?? undefined },
    { key: 'plan', accessor: planOf },
  ]
}

export function useInstanceSource<Row>(opts: {
  rows: () => readonly Row[]
  columns: SortableColumn<Row>[]
  rowKey: (row: Row) => string
  facts: (row: Row) => InstanceFacts
  /** Where the sort is remembered across reloads, when it should be. */
  persisted?: PersistedSort
}) {
  const { sortedRows, toggleSort, indicatorFor } = useSortable(
    opts.rows,
    opts.columns,
    opts.persisted,
    { rowKey: opts.rowKey },
  )
  const { dimmed, visible } = useInstanceFilter()
  const visibleRows = computed(() => visible(sortedRows.value, opts.facts))
  return {
    sortedRows,
    toggleSort,
    indicatorFor,
    visibleRows,
    /** Rows the filter took out: said out loud in the heading beside the count. */
    hiddenByFilter: computed(() => sortedRows.value.length - visibleRows.value.length),
    isDimmed: (row: Row) => dimmed(opts.facts(row)),
  }
}
