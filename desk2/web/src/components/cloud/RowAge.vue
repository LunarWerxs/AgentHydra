<script setup lang="ts">
import { useClock } from '@/lib/clock'
import { relativeTime } from '@/components/sidebar/search'

// The one place the cloud list reads the 30 s clock, so a tick redraws these few words and not the list.
defineProps<{ at: number | null }>()
const now = useClock(30_000)
</script>

<template>
  <span class="shrink-0 pr-1 text-[12px] leading-4 text-text-muted tnum">{{ relativeTime(at, now) }}</span>
</template>
