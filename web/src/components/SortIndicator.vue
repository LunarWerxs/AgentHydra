<script setup lang="ts">
// A sortable column's mark: the direction while the table is sorted by it, and otherwise a faint
// pair of arrows on hover, so a header says it sorts (SUE round, 2026-10-01: a visitor did not take
// the Tokens header for sortable). The idle pair sits in the gutter after the label and takes no
// width: drawn inline on every header it widened the Instances table's narrow columns past its
// frame, and the table scrolled sideways (owner, 2026-10-01). `quiet` leaves it off.
import { ArrowDown, ArrowUp, ArrowUpDown } from '@lucide/vue'
import type { SortDirection } from '@/composables/useSortable'

defineProps<{ direction: SortDirection; quiet?: boolean }>()
</script>

<template>
  <ArrowUp v-if="direction === 'asc'" class="size-3" />
  <ArrowDown v-else-if="direction === 'desc'" class="size-3" />
  <ArrowUpDown
    v-else-if="!quiet"
    class="pointer-events-none absolute start-full top-1/2 ms-px size-2.5 -translate-y-1/2 opacity-0 transition-opacity group-hover/sort:opacity-50 group-focus-visible/sort:opacity-50"
    aria-hidden="true"
  />
</template>
