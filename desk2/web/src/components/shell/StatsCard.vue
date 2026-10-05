<script lang="ts">
import type { HomeStats } from '@shared/protocol'
import type { StatsRange } from './logic'

// Each range's last answer from the server, kept across mounts of the card (the screen mounts on every
// Ctrl+N, close and Back) so a mount paints it at once while the server is asked again.
const recentAnswers = new Map<StatsRange, HomeStats>()
</script>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ChevronRight } from '@lucide/vue'
import type { ChatSummary } from '@shared/protocol'
import { computeStats } from './logic'
import { useShellSource } from './source'
import { DESK_ONLY_OFFLINE, DESK_ONLY_WAITING, heatTitle, homeFooter, homeModels, homeSources, homeTiles, statsFooter, statsTiles } from './stats'

// The stats card of the new-session screen (480 wide, r12, #ffffff0d): tabs, ranges, nine tiles, the
// sources and the activity grid, over every source AgentHydra counts (owner, 2026-10-04: "the overview
// screen needs to display full consolidated stats from all sources"; GET /api/stats/home, stats.ts).
// Until AgentHydra's answer comes, or when it does not answer, it shows Hydra Desk's own chats (six
// tiles) and says so.
const props = defineProps<{ chats: ChatSummary[] }>()
const src = useShellSource()

const tab = ref<'overview' | 'models'>('overview')
const range = ref<StatsRange>('all')
const desk = computed(() => computeStats(props.chats, range.value))

// Each range's last answer: the one this browser kept paints at once, the server's replaces it.
const answers = reactive<Partial<Record<StatsRange, HomeStats>>>({})
const failed = reactive<Partial<Record<StatsRange, string>>>({})
function load(r: StatsRange): void {
  if (!src.homeStats) return
  const kept = answers[r] ?? recentAnswers.get(r) ?? src.cachedHomeStats?.(r)
  if (kept) answers[r] = kept
  src.homeStats(r).then(
    (stats) => {
      answers[r] = stats
      recentAnswers.set(r, stats)
      delete failed[r]
    },
    (err: unknown) => {
      failed[r] = err instanceof Error ? err.message : String(err)
    }
  )
}
watch(range, (r) => load(r), { immediate: true })

/** AgentHydra's figures for the range, or null while Hydra Desk's own stand in. */
const home = computed(() => (failed[range.value] ? null : (answers[range.value] ?? null)))
const tiles = computed(() => (home.value ? homeTiles(home.value) : statsTiles(desk.value)))
const sources = computed(() => (home.value ? homeSources(home.value) : []))
const models = computed(() => (home.value ? homeModels(home.value) : desk.value.models))

// 27 weeks of 7 days, filled column by column (oldest week on the left).
const HEAT = ['var(--fill-secondary)', '#8fb8f0', 'var(--accent-text)', 'var(--accent-hover)', 'var(--accent)']
const heat = computed(() => home.value?.heat ?? desk.value.heat)
// Each square names its day and its number on hover (owner, 2026-10-05: "Each of the squares ... need to
// have a number I can read when I hover over them"): model turns from AgentHydra, chats touched from Desk.
const heatUnit = computed<[string, string]>(() => (home.value ? ['message', 'messages'] : ['chat', 'chats']))
// Every square's hover title is worked out once per change of the grid, not once per render.
const heatCells = computed(() => {
  const unit = heatUnit.value
  return heat.value.map((cell) => ({ day: cell.day, level: cell.level, title: heatTitle(cell, ...unit) }))
})

// The Sources list folds, folded by default, and the choice is kept (owner, 2026-10-05: "The sources need
// to be collapsible and collapsed by default").
const SOURCES_OPEN_KEY = 'hydra-desk.stats.sources-open'
let openAtStart = false
try {
  openAtStart = localStorage.getItem(SOURCES_OPEN_KEY) === '1'
} catch {
  // floor-ok: storage blocked; the list starts folded
}
const sourcesOpen = ref(openAtStart)
function toggleSources(): void {
  sourcesOpen.value = !sourcesOpen.value
  try {
    localStorage.setItem(SOURCES_OPEN_KEY, sourcesOpen.value ? '1' : '0')
  } catch {
    // floor-ok: storage full or blocked; the choice holds for this window only
  }
}
const maxModel = computed(() => Math.max(1, ...models.value.map((m) => m.sessions)))

const footer = computed(() => {
  if (home.value) return homeFooter(home.value)
  if (!src.homeStats) return [statsFooter(desk.value)]
  return [statsFooter(desk.value), failed[range.value] ? DESK_ONLY_OFFLINE : DESK_ONLY_WAITING]
})
const footerTitle = computed(() => (home.value ? undefined : failed[range.value]))

const SOURCE_COLS = 'grid grid-cols-[minmax(0,1fr)_52px_56px_64px] items-center gap-x-2 px-1.5'

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
      <div v-if="sources.length" class="mt-[6px] flex flex-col gap-[2px]">
        <button type="button" class="flex h-5 items-center gap-1 px-1.5 text-left text-[11px] leading-4 text-text-muted hover:text-text-2" :aria-expanded="sourcesOpen" aria-controls="stats-sources" @click="toggleSources">
          <ChevronRight class="size-3 transition-transform" :class="sourcesOpen ? 'rotate-90' : ''" aria-hidden="true" />
          <span>Sources</span>
          <span class="tnum">{{ sources.length }}</span>
        </button>
        <div v-if="sourcesOpen" id="stats-sources" class="flex flex-col gap-[2px]" role="table" aria-label="Sources">
          <div role="row" :class="SOURCE_COLS" class="h-4 text-[11px] leading-4 text-text-muted">
            <span role="columnheader">Source</span>
            <span role="columnheader" class="text-right">Sessions</span>
            <span role="columnheader" class="text-right">Tokens</span>
            <span role="columnheader" class="text-right">Cost</span>
          </div>
          <div v-for="s in sources" :key="s.key" role="row" :title="s.title" :class="SOURCE_COLS" class="relative h-[22px] overflow-hidden rounded-[var(--radius-6)] bg-[var(--fill-secondary)] text-[12px] leading-4">
            <span class="absolute bottom-0 left-0 h-[2px] bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]" :style="{ width: `${s.share * 100}%` }" />
            <span role="cell" class="relative truncate text-text">{{ s.label }}</span>
            <span role="cell" class="tnum relative text-right text-text-2">{{ s.sessions }}</span>
            <span role="cell" class="tnum relative text-right text-text-2">{{ s.tokens }}</span>
            <span role="cell" class="tnum relative text-right text-text-2">{{ s.cost }}</span>
          </div>
        </div>
      </div>
      <div class="mt-[6px] grid grid-flow-col grid-rows-7 justify-between gap-y-[3px]" role="img" aria-label="Activity over the last 27 weeks">
        <span v-for="cell in heatCells" :key="cell.day" :title="cell.title" class="size-[15px] rounded-[2px]" :style="{ background: HEAT[cell.level] }" />
      </div>
    </template>

    <div v-else class="mt-[18px] flex min-h-[217px] flex-col gap-[5px]">
      <div v-for="m in models" :key="m.label" class="relative flex h-7 items-center overflow-hidden rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[13px] leading-[19px]">
        <span class="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]" :style="{ width: `${(m.sessions / maxModel) * 100}%` }" />
        <span class="relative min-w-0 flex-1 truncate text-text">{{ m.label }}</span>
        <span class="tnum relative text-text-2">{{ m.sessions.toLocaleString('en-US') }}</span>
      </div>
      <p v-if="!models.length" class="text-[12px] leading-4 text-text-muted">No sessions in this range yet.</p>
    </div>

    <div class="mt-2 text-[11px] leading-4 text-text-muted" :title="footerTitle">
      <p v-for="line in footer" :key="line">{{ line }}</p>
    </div>
  </section>
</template>
