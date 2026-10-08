<script setup lang="ts">
// The real app's status row (div.group/status): 24px high, padding 2px 4px, radius 6, gap 6, 14px
// muted text and a 12px muted chevron that turns down when open. Used by tool runs, thinking and cards.
import { icons } from '@/lib/icons'

const Chevron = icons.statusChevron
// hoverChevron: the chevron shows only on hover or when open (the real settled-tasks line has none at rest).
// data-expander: a click on it keeps it where it is while what it opens slides (TranscriptView's holdRow).
defineProps<{ open: boolean; running?: boolean; hoverChevron?: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="tx-status group/status"
    :data-state="running ? 'running' : 'done'"
    :aria-expanded="open"
    data-expander
    @click="$emit('toggle')"
  >
    <slot />
    <Chevron class="tx-status-chevron" :class="[open && 'rotate-90', hoverChevron && !open && 'opacity-0 group-hover/status:opacity-100']" />
    <slot name="after" />
  </button>
</template>
