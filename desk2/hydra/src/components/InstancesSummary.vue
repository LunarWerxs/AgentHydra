<script setup lang="ts">
// The usage-history card above the Instances table. Owner, 2026-10-07: the account counts, pooled gauges
// and "nearest their limit" list were current numbers he did not want; he wants historical charts only.
// Collapsed (the default, remembered): one line, the fleet's weekly use over the last 7 days as a
// sparkline. Expanded: the 7-day fleet chart (weekly and 5-hour use, with gaps where nothing was sampled)
// and tokens per day over the last 14 days, stacked by source. The usage history and the daily tokens are
// both fetched on mount, so the chart is ready by the time the card is opened: the tokens are one request
// for the 14 days, not one spend report per source. With the Free accounts on screen it shows theirs first (FreeSummary):
// their token totals and success rate in the header, the totals, accounts, models and tokens per day when open.
import type { FleetUsageHistory } from '@agenthydra/server/types'
import { ChevronRight } from '@lucide/vue'
import { useElementSize, useStorage } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import FreeSummary from '@/components/FreeSummary.vue'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { FREE_STAT_DAYS, refreshFreeStats, useFreeStats } from '@/composables/useFreeStats'
import { useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { getFleetUsageHistory, getTokensByDay } from '@/lib/api'
import { axisMax, seriesColor, ticks } from '@/lib/chart'
import { answeredShare, summarizeFree } from '@/lib/free-stats'
import { formatTokens } from '@/lib/kit'
import { dayLabel, formatAt, type PlotBox, segmentPaths } from '@/lib/usage-history'

const props = defineProps<{ /** The Free accounts are on screen. */ free?: boolean }>()
const { t } = useI18n()
const open = useStorage('agenthydra.instances.summaryOpen', false)

// The Free record is read again whenever an account's numbers move (a message ended), while the Free rows show.
const { instances: freeInstances, tokens: freeTokens, health: freeHealth } = useFreeInstances()
const { rows: freeRows } = useFreeStats()
const tokenWindow = useDesktopTokenWindow()
watch([() => props.free, freeTokens, freeHealth], ([free]) => { if (free) void refreshFreeStats() }, { immediate: true })
const freeLine = computed(() => {
  if (!props.free || !freeInstances.value.length) return ''
  const all = summarizeFree(freeRows.value ?? [], freeInstances.value, freeTokens.value, tokenWindow.value, FREE_STAT_DAYS, Date.now()).totals.all
  const share = answeredShare(all)
  return t('freeInstances.stats.headerLine', { tokens: formatTokens(all.tokens), answered: share === null ? '–' : `${Math.round(share * 100)}%`, days: FREE_STAT_DAYS })
})

const TOKEN_SOURCES = ['desktop', 'cli', 'climayte', 'hswarm'] as const
type TokenSource = (typeof TOKEN_SOURCES)[number]
const FLEET_ORDER = ['week', 'session'] as const

const sourceLabel = (s: TokenSource) =>
  ({
    desktop: t('instances.summary.sourceDesktop'),
    cli: t('instances.summary.sourceCli'),
    climayte: t('instances.summary.sourceClimayte'),
    hswarm: t('instances.summary.sourceHswarm'),
  })[s]

const history = ref<FleetUsageHistory | null>(null)
const historyFailed = ref(false)
const tokenDays = ref<Array<{ key: string; values: number[] }> | null>(null)
const tokensFailed = ref(false)

async function loadHistory() {
  try {
    history.value = await getFleetUsageHistory(168)
  } catch {
    historyFailed.value = true
  }
}

async function loadTokens() {
  try {
    const report = await getTokensByDay(14)
    tokenDays.value = report.days.map((d) => ({
      key: d.key,
      values: TOKEN_SOURCES.map((s) => d.bySource[s]),
    }))
  } catch {
    tokensFailed.value = true
  }
}

onMounted(() => {
  void loadHistory()
  void loadTokens()
})

const points = computed(() => history.value?.points ?? [])
const weekValues = computed(() => points.value.map((p) => p.week))
const sessionValues = computed(() => points.value.map((p) => p.session))
const hasFleetData = computed(() => points.value.some((p) => p.week !== null || p.session !== null))

const SPARK: PlotBox = { left: 0, top: 1, width: 120, height: 22 }
const sparkPaths = computed(() => segmentPaths(weekValues.value, SPARK, 100))

// The chart is drawn at the card's own width, one SVG unit per pixel, so it fills the card at any size.
const fleetEl = ref<HTMLElement | null>(null)
const { width: fleetWidth } = useElementSize(fleetEl)
const FLEET_HEIGHT = 160
const fleetView = computed(() => ({ width: Math.max(320, Math.round(fleetWidth.value) || 600), height: FLEET_HEIGHT }))
const fleetBox = computed<PlotBox>(() => ({ left: 34, top: 8, width: fleetView.value.width - 42, height: FLEET_HEIGHT - 16 }))
const fleetMax = computed(() => {
  const all = [...weekValues.value, ...sessionValues.value].filter((v): v is number => v !== null)
  return axisMax(Math.max(100, ...all))
})
const fleetTicks = computed(() => ticks(fleetMax.value))
const yAt = (v: number) =>
  fleetBox.value.top + fleetBox.value.height - (v / fleetMax.value) * fleetBox.value.height
const weekPaths = computed(() => segmentPaths(weekValues.value, fleetBox.value, fleetMax.value))
const sessionPaths = computed(() => segmentPaths(sessionValues.value, fleetBox.value, fleetMax.value))
const pctOrGap = (v: number | null) => (v === null ? t('instances.summary.noSample') : `${Math.round(v)}%`)
const fleetHits = computed(() => {
  const n = points.value.length
  const box = fleetBox.value
  const slot = box.width / Math.max(1, n)
  return points.value.map((p, i) => ({
    x: box.left + (i / Math.max(1, n - 1)) * box.width - slot / 2,
    tip: t('instances.summary.tipPoint', {
      time: formatAt(p.t),
      week: pctOrGap(p.week),
      session: pctOrGap(p.session),
    }),
  }))
})
const fleetLegend = computed(() => [
  { key: 'week', label: t('instances.summary.fleetWeek'), color: seriesColor('week', FLEET_ORDER) },
  { key: 'session', label: t('instances.summary.fleetSession'), color: seriesColor('session', FLEET_ORDER) },
])
const fleetSpan = computed(() => {
  const first = points.value[0]?.t
  const last = points.value[points.value.length - 1]?.t
  return { first: first ? formatAt(first) : '', last: last ? formatAt(last) : '' }
})

const tokenSeries = computed(() =>
  TOKEN_SOURCES.map((s) => ({ key: s, label: sourceLabel(s), color: seriesColor(s, TOKEN_SOURCES) })),
)
const tokenHours = computed(() =>
  (tokenDays.value ?? []).map((d) => ({ label: dayLabel(d.key), values: d.values })),
)
const tokensEmpty = computed(
  () => tokenDays.value !== null && tokenDays.value.every((d) => d.values.every((v) => v === 0)),
)
</script>

<template>
  <section class="m-4 rounded-lg border bg-card">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-start focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight
        class="size-4 shrink-0 text-muted-foreground transition-transform"
        :class="{ 'rotate-90': open }"
      />
      <span class="text-xs font-semibold whitespace-nowrap">{{ $t('instances.summary.title') }}</span>
      <span v-if="freeLine" class="truncate text-2xs text-muted-foreground tabular-nums">{{ freeLine }}</span>
      <svg
        v-if="sparkPaths.length"
        class="ms-auto shrink-0 overflow-visible text-primary"
        width="120"
        height="24"
        :viewBox="`0 0 ${SPARK.width} 24`"
        role="img"
        :aria-label="$t('instances.summary.sparklineLabel')"
      >
        <path
          v-for="(d, k) in sparkPaths"
          :key="k"
          :d="d"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    </button>

    <div v-if="open" class="space-y-4 border-t p-3">
      <FreeSummary v-if="free" />
      <div>
        <h3 class="mb-1 text-xs font-semibold">{{ $t('instances.summary.fleetTitle') }}</h3>
        <p v-if="historyFailed" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.unavailable') }}
        </p>
        <p v-else-if="!history" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.loading') }}
        </p>
        <p v-else-if="!hasFleetData" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.noData') }}
        </p>
        <div v-else ref="fleetEl">
          <svg
            :viewBox="`0 0 ${fleetView.width} ${fleetView.height}`"
            class="h-40 w-full overflow-visible"
            role="img"
            :aria-label="$t('instances.summary.fleetTitle')"
          >
            <g v-for="tk in fleetTicks" :key="tk">
              <line
                :x1="fleetBox.left"
                :x2="fleetBox.left + fleetBox.width"
                :y1="yAt(tk)"
                :y2="yAt(tk)"
                class="stroke-border"
                stroke-width="1"
              />
              <text
                :x="fleetBox.left - 6"
                :y="yAt(tk) + 3"
                text-anchor="end"
                class="fill-muted-foreground"
                font-size="10"
              >{{ tk }}%</text>
            </g>
            <path
              v-for="(d, k) in weekPaths"
              :key="`w${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              class="stroke-(--line-c)"
              :style="{ '--line-c': seriesColor('week', FLEET_ORDER) }"
            />
            <path
              v-for="(d, k) in sessionPaths"
              :key="`s${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              class="stroke-(--line-c)"
              :style="{ '--line-c': seriesColor('session', FLEET_ORDER) }"
            />
            <rect
              v-for="(h, i) in fleetHits"
              :key="i"
              :x="h.x"
              :y="fleetBox.top"
              :width="fleetBox.width / Math.max(1, points.length)"
              :height="fleetBox.height"
              fill="transparent"
            >
              <title>{{ h.tip }}</title>
            </rect>
          </svg>
          <div class="mt-0.5 flex justify-between ps-8.5 text-3xs text-muted-foreground tabular-nums">
            <span>{{ fleetSpan.first }}</span>
            <span>{{ fleetSpan.last }}</span>
          </div>
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="l in fleetLegend" :key="l.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': l.color }"></span>
              {{ l.label }}
            </li>
          </ul>
        </div>
      </div>

      <div>
        <h3 class="mb-1 text-xs font-semibold">{{ $t('instances.summary.tokensTitle') }}</h3>
        <p v-if="tokensFailed" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.unavailable') }}
        </p>
        <p v-else-if="!tokenDays" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.loading') }}
        </p>
        <p v-else-if="tokensEmpty" class="py-6 text-center text-2xs text-muted-foreground">
          {{ $t('instances.summary.noData') }}
        </p>
        <template v-else>
          <HourBars
            :hours="tokenHours"
            :series="tokenSeries"
            height-class="h-32"
            :format-value="formatTokens"
          />
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="s in tokenSeries" :key="s.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': s.color }"></span>
              {{ s.label }}
            </li>
          </ul>
        </template>
      </div>
    </div>
  </section>
</template>
