<script setup lang="ts">
// A sortable column's header: a real button, so the keyboard reaches it and anything that looks
// for controls finds it. The headers used to take the click on the cell itself, which nothing but
// a mouse could press (SUE round, 2026-10-01: a visitor's click on Tokens "did not take").
import SortIndicator from '@/components/SortIndicator.vue'
import type { SortDirection } from '@/composables/useSortable'

defineProps<{ direction: SortDirection; quiet?: boolean }>()
const emit = defineEmits<{ sort: [] }>()
</script>

<template>
  <button
    type="button"
    class="inline-flex cursor-pointer select-none items-center gap-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    @click="emit('sort')"
  >
    <slot />
    <SortIndicator :direction="direction" :quiet="quiet" />
  </button>
</template>
