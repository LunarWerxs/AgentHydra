<script setup lang="ts">
import { Bot, Network } from '@lucide/vue'
import { runPulse } from './logic'
import { accountTone } from './account-tone'
import { badgeTip, SUB_KIND_LABELS, toggleExpanded, type SubBadge } from './subitems'

// A row's sub-items in Count mode (subitems.ts), at the right edge where its other metadata sits: one small
// badge per kind, its icon (CliMayte: the chrome bar's Bot; HSwarm: the network mark its job lines use) and how
// many run (a muted total when none do), and on a CliMayte badge a dot per account its tasks run on, in that
// account's colour (owner, 2026-10-06). A click opens the row's lines of that kind under it, a second folds
// them; hovering lists the titles. While some run, the icon pulses as their lines' marks do: blue for HSwarm's
// jobs, the one blue in the sidebar, gray for CliMayte's tasks (owner, 2026-10-05: "Only the HSwarm items should
// have blue").
defineProps<{ rowKey: string; badges: SubBadge[] }>()
// The accounts a CliMayte badge draws as dots; its tooltip names every one.
const DOTS = 3
const label = (b: SubBadge) => `${SUB_KIND_LABELS[b.kind]}: ${b.running} running of ${b.total}${b.accounts.length ? `, on ${b.accounts.map((a) => a.label).join(', ')}` : ''}`
const tone = (b: SubBadge) => (!b.running ? 'text-text-muted' : b.kind === 'jobs' ? 'text-accent-text' : 'text-text-2')
</script>

<template>
  <span v-if="badges.length" class="flex shrink-0 items-center gap-1">
    <button
      v-for="b in badges"
      :key="b.kind"
      type="button"
      :title="badgeTip(b)"
      :aria-label="label(b)"
      :aria-expanded="b.open"
      class="flex h-4 min-w-4 cursor-default items-center justify-center gap-0.5 rounded-[4px] px-1 text-[11px] leading-4 tnum transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover"
      :class="[b.open ? 'bg-fill-selected' : 'bg-[var(--fill-secondary)]', tone(b)]"
      @click.stop="toggleExpanded(rowKey, b.kind)"
      @keydown.enter.stop
    >
      <component :is="b.kind === 'tasks' ? Bot : Network" class="size-3 shrink-0" :class="b.running ? runPulse(b.kind === 'jobs' ? 'blue' : 'gray') : ''" aria-hidden="true" />
      {{ b.running || b.total }}
      <!-- A CliMayte badge's accounts: a dot each in its colour, dimmed for one with nothing running (account-tone.ts). -->
      <span v-if="b.accounts.length" class="flex items-center gap-px" aria-hidden="true">
        <span
          v-for="a in b.accounts.slice(0, DOTS)"
          :key="a.label"
          class="size-1.5 shrink-0 rounded-full"
          :class="a.running ? '' : 'opacity-50'"
          :style="{ backgroundColor: accountTone(a.label) ?? 'currentColor' }"
        />
      </span>
    </button>
  </span>
</template>
