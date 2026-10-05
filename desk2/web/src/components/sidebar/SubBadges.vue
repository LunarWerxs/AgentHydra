<script setup lang="ts">
import { Bot, Network } from '@lucide/vue'
import { badgeTip, SUB_KIND_LABELS, toggleExpanded, type SubBadge } from './subitems'

// A row's sub-items in Count mode (subitems.ts), at the right edge where its other metadata sits: one small
// badge per kind, its icon (CliMayte: the chrome bar's Bot; HSwarm: the network mark its job lines use) and how
// many run (a muted total when none do). A click opens the row's lines of that kind under it, a second folds
// them; hovering lists the titles.
defineProps<{ rowKey: string; badges: SubBadge[] }>()
</script>

<template>
  <span v-if="badges.length" class="flex shrink-0 items-center gap-1">
    <button
      v-for="b in badges"
      :key="b.kind"
      type="button"
      :title="badgeTip(b)"
      :aria-label="`${SUB_KIND_LABELS[b.kind]}: ${b.running} running of ${b.total}`"
      :aria-expanded="b.open"
      class="flex h-4 min-w-4 cursor-default items-center justify-center gap-0.5 rounded-[4px] px-1 text-[11px] leading-4 tnum transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover"
      :class="[b.open ? 'bg-fill-selected' : 'bg-[var(--fill-secondary)]', b.running ? 'text-accent-text' : 'text-text-muted']"
      @click.stop="toggleExpanded(rowKey, b.kind)"
      @keydown.enter.stop
    >
      <component :is="b.kind === 'tasks' ? Bot : Network" class="size-3 shrink-0" aria-hidden="true" />
      {{ b.running || b.total }}
    </button>
  </span>
</template>
