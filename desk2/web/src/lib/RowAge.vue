<script setup lang="ts">
import { useClock } from '@/lib/clock'
import { relativeTime } from '@/components/sidebar/search'

// The one place the sidebar's lists read the 30 s clock for a row's age, so a tick redraws these few words and not
// the list. The row that holds it gives it its right padding.
defineProps<{ at: number | null }>()
const now = useClock(30_000)
</script>

<template>
  <span class="shrink-0 text-[12px] leading-4 text-text-muted tnum">{{ relativeTime(at, now) }}</span>
</template>
