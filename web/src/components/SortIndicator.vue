<script setup lang="ts">
// A sortable column's mark: the direction while the table is sorted by it, and otherwise a faint
// pair of arrows, so a header says it sorts before anyone clicks it. Without the idle mark a
// visitor looking for the biggest number did not take the Tokens header for sortable (SUE round,
// 2026-10-01). `quiet` leaves the idle mark off a column too narrow for it.
import { ArrowDown, ArrowUp, ArrowUpDown } from '@lucide/vue'
import type { SortDirection } from '@/composables/useSortable'

defineProps<{ direction: SortDirection; quiet?: boolean }>()
</script>

<template>
  <ArrowUp v-if="direction === 'asc'" class="size-3" />
  <ArrowDown v-else-if="direction === 'desc'" class="size-3" />
  <ArrowUpDown v-else-if="!quiet" class="size-3 opacity-40" aria-hidden="true" />
</template>
