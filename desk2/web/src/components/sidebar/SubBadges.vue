<script setup lang="ts">
import { Bot, Network } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { runPulse } from './logic'
import { badgeTip, SUB_KIND_LABELS, toggleExpanded, type SubBadge } from './subitems'

// A row's sub-items in Count mode (subitems.ts), at the right edge where its other metadata sits: one small
// badge per kind, its icon (CliMayte: the chrome bar's Bot; HSwarm: the network mark its job lines use) and how
// many run (a muted total when none do). A click opens the row's lines of that kind under it, a second folds
// them; hovering lists the titles and the accounts. The dot per account that followed the count is gone (owner,
// 2026-10-08: "I don't know what they are doing or what they are for anyways, so remove"); the tooltip and the
// task lines still name the accounts. While some run, the icon pulses as their lines' marks do: blue for HSwarm's
// jobs, the one blue in the sidebar, gray for CliMayte's tasks (owner, 2026-10-05: "Only the HSwarm items should
// have blue").
// A badge whose lines are open under the row reads as on (owner, 2026-10-09: "it doesn't change color just a little
// bit ... to show that it's been toggled on"): HSwarm's tinted in the accent, as the Filter button is while it narrows
// the list (SidebarTools.vue); CliMayte's, which may not be blue, lit and outlined in the strong border instead. A
// running icon keeps its pulse in the badge's colour.
defineProps<{ rowKey: string; badges: SubBadge[] }>()
const label = (b: SubBadge) => `${SUB_KIND_LABELS[b.kind]}: ${b.running} running of ${b.total}${b.accounts.length ? `, on ${b.accounts.map((a) => a.label).join(', ')}` : ''}`
const tone = (b: SubBadge) => (!b.running ? 'text-text-muted' : b.kind === 'jobs' ? 'text-accent-text' : 'text-text-2')
const look = (b: SubBadge) =>
  !b.open
    ? `bg-(--fill-secondary) hover:bg-fill-hover ${tone(b)}`
    : b.kind === 'jobs'
      ? 'bg-accent-bg text-accent-text'
      : 'bg-fill-selected text-text ring-1 ring-inset ring-border-strong'
const pulse = (b: SubBadge) => (!b.running ? '' : b.open ? 'run-pulse' : runPulse(b.kind === 'jobs' ? 'blue' : 'gray'))
</script>

<template>
  <span v-if="badges.length" class="flex shrink-0 items-center gap-1">
    <Tip v-for="b in badges" :key="b.kind" :label="badgeTip(b)">
      <button
        type="button"
        :aria-label="label(b)"
        :aria-expanded="b.open"
        class="flex h-4 min-w-4 cursor-default items-center justify-center gap-0.5 rounded-sm px-1 text-[11px] leading-4 tnum transition-colors duration-(--dur-fast)"
        :class="look(b)"
        @click.stop="toggleExpanded(rowKey, b.kind)"
        @keydown.enter.stop
      >
        <component :is="b.kind === 'tasks' ? Bot : Network" class="size-3 shrink-0" :class="pulse(b)" aria-hidden="true" />
        {{ b.running || b.total }}
      </button>
    </Tip>
  </span>
</template>
