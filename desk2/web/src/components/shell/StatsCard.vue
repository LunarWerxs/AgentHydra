<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { computeStats, type StatsRange } from './logic'
import { statsFooter, statsTiles } from './stats'

// The stats card of the new-session screen (480 wide, r12, #ffffff0d): tabs, ranges, six tiles and
// the activity grid, from what Hydra Desk knows about its own chats (stats.ts).
const props = defineProps<{ chats: ChatSummary[] }>()

const tab = ref<'overview' | 'models'>('overview')
const range = ref<StatsRange>('all')
const stats = computed(() => computeStats(props.chats, range.value))

const tiles = computed(() => statsTiles(stats.value))

// 27 weeks of 7 days, filled column by column (oldest week on the left).
const HEAT = ['var(--fill-secondary)', '#8fb8f0', 'var(--accent-text)', 'var(--accent-hover)', 'var(--accent)']
const maxModel = computed(() => Math.max(1, ...stats.value.models.map((m) => m.sessions)))

const footer = computed(() => statsFooter(stats.value))

const CHIP = 'flex h-5 cursor-default items-center rounded-[var(--radius-5)] px-1.5 text-[12px] leading-4'
const chip = (on: boolean) => [CHIP, on ? 'bg-fill-hover font-semibold text-text' : 'text-text-muted hover:text-text-2']
</script>

<template>
  <section aria-label="Usage" class="w-[480px] max-w-full rounded-[var(--radius-12)] bg-fill-5 px-3 pb-3 pt-2">
    <div class="flex items-center">
      <div role="tablist" class="flex items-center gap-0.5">
        <button type="button" role="tab" :aria-selected="tab === 'overview'" :class="chip(tab === 'overview')" @click="tab = 'overview'">Overview</button>
        <button type="button" role="tab" :aria-selected="tab === 'models'" :class="chip(tab === 'models')" @click="tab = 'models'">Models</button>
      </div>
      <span class="flex-1" />
      <div role="radiogroup" aria-label="Range" class="flex items-center gap-0.5">
        <button type="button" role="radio" :aria-checked="range === 'all'" :class="chip(range === 'all')" @click="range = 'all'">All</button>
        <button type="button" role="radio" :aria-checked="range === '30d'" :class="chip(range === '30d')" @click="range = '30d'">30d</button>
        <button type="button" role="radio" :aria-checked="range === '7d'" :class="chip(range === '7d')" @click="range = '7d'">7d</button>
      </div>
    </div>

    <template v-if="tab === 'overview'">
      <div class="mt-5 grid grid-cols-3 gap-1">
        <div v-for="t in tiles" :key="t.label" :title="t.title" class="flex h-11 min-w-0 flex-col justify-start rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1 pt-[2.5px]">
          <span class="truncate text-[12px] leading-4 text-text-muted">{{ t.label }}</span>
          <span class="tnum truncate text-[13px] leading-[19px] text-text" :class="t.strong ? 'font-semibold' : ''">{{ t.value }}</span>
        </div>
      </div>
      <div class="mt-[6px] grid grid-flow-col grid-rows-7 justify-between gap-y-[3px]" role="img" aria-label="Activity over the last 27 weeks">
        <span v-for="(level, i) in stats.heat" :key="i" class="size-[15px] rounded-[2px]" :style="{ background: HEAT[level] }" />
      </div>
    </template>

    <div v-else class="mt-[18px] flex min-h-[217px] flex-col gap-[5px]">
      <div v-for="m in stats.models" :key="m.label" class="relative flex h-7 items-center overflow-hidden rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[13px] leading-[19px]">
        <span class="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]" :style="{ width: `${(m.sessions / maxModel) * 100}%` }" />
        <span class="relative min-w-0 flex-1 truncate text-text">{{ m.label }}</span>
        <span class="tnum relative text-text-2">{{ m.sessions.toLocaleString('en-US') }}</span>
      </div>
      <p v-if="!stats.models.length" class="text-[12px] leading-4 text-text-muted">No sessions in this range yet.</p>
    </div>

    <p class="mt-2 text-[11px] leading-4 text-text-muted">{{ footer }}</p>
  </section>
</template>
