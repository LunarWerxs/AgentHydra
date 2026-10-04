<script setup lang="ts">
// This chat's queue (Hydra Desk's own), stacked on top of the repo strip and the box, outside them: at
// most three one-line rows, then "+N more". Rendered only while there are some, so the default captures do
// not change. Any row opens the queue popover, where they are edited, reordered, sent now or removed.
import { computed } from 'vue'
import type { QueueItem } from '@shared/protocol'
import { queueBadge, trayText, type HeldWhy } from './queue'

const props = defineProps<{ items: QueueItem[]; held: Record<string, HeldWhy> }>()
const emit = defineEmits<{ open: [] }>()

const TRAY_ROWS = 3
const rows = computed(() =>
  props.items.slice(0, TRAY_ROWS).map((item) => ({ item, text: trayText(item), badge: queueBadge(item, props.held) }))
)
const more = computed(() => props.items.length - rows.value.length)
</script>

<template>
  <ul
    role="list"
    aria-label="Queued for this chat"
    class="flex flex-col rounded-[var(--radius-12)] border border-[var(--border)] bg-[var(--bg-popover)] p-1"
    data-queue-tray
  >
    <li v-for="(r, i) in rows" :key="r.item.id">
      <button
        type="button"
        class="flex h-6 w-full items-center gap-1.5 rounded-[var(--radius-6)] px-1 text-left text-[13px] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
        :aria-label="`Queued ${i + 1}: ${r.text}`"
        @click="emit('open')"
      >
        <span class="tnum w-3 shrink-0 text-[var(--text-muted)]">{{ i + 1 }}</span>
        <span class="min-w-0 flex-1 truncate">{{ r.text }}</span>
        <span
          v-if="r.badge"
          class="shrink-0 text-[12px]"
          :class="r.badge.tone === 'warn' ? 'text-[var(--warning-text)]' : 'text-[var(--text-muted)]'"
        >{{ r.badge.label }}</span>
      </button>
    </li>
    <li v-if="more > 0">
      <button
        type="button"
        class="flex h-6 items-center rounded-[var(--radius-6)] px-1 text-[12px] text-[var(--text-muted)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
        @click="emit('open')"
      >
        +{{ more }} more queued
      </button>
    </li>
  </ul>
</template>
