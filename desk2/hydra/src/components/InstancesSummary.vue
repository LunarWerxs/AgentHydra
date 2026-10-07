<script setup lang="ts">
// The usage-history card above the Instances table. Owner, 2026-10-07: the account counts, pooled gauges
// and "nearest their limit" list were current numbers he did not want; he wants historical charts only.
// Collapsed (the default, remembered): one line, the fleet's weekly use over the last 7 days as a
// sparkline. Expanded: the 7-day fleet chart (weekly and 5-hour use, with gaps where nothing was sampled)
// and tokens per day over the last 14 days, stacked by source. The usage history is fetched once, for
// the sparkline; the per-source spend is fetched only the first time the card is opened.
import type { FleetUsageHistory } from '@agenthydra/server/types'
import { ChevronRight } from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import { getFleetUsageHistory, getSpend } from '@/lib/api'
import { axisMax, seriesColor, ticks } from '@/lib/chart'
import {
  dailyTokens,
  dayLabel,
  formatAt,
  lastDays,
  type PlotBox,
  segmentPaths,
} from '@/lib/usage-history'

const { t } = useI18n()
const open = useStorage('agenthydra.instances.summaryOpen', false)

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
let tokensRequested = false

async function loadHistory() {
  try {
    history.value = await getFleetUsageHistory(168)
  } catch {
    historyFailed.value = true
  }
}

async function loadTokens() {
  try {
    const reports = await Promise.all(TOKEN_SOURCES.map((s) => getSpend('30d', s)))
    tokenDays.value = dailyTokens(
      TOKEN_SOURCES.map((_, i) => ({ byDay: reports[i]?.byDay ?? [] })),
      lastDays(new Date(), 14),
    )
  } catch {
    tokensFailed.value = true
  }
}

onMounted(loadHistory)
watch(
  open,
  (v) => {
    if (!v || tokensRequested) return
    tokensRequested = true
    void loadTokens()
  },
  { immediate: true },
)

const points = computed(() => history.value?.points ?? [])
const weekValues = computed(() => points.value.map((p) => p.week))
const sessionValues = computed(() => points.value.map((p) => p.session))
const hasFleetData = computed(() => points.value.some((p) => p.week !== null || p.session !== null))

const SPARK: PlotBox = { left: 0, top: 1, width: 120, height: 22 }
const sparkPaths = computed(() => segmentPaths(weekValues.value, SPARK, 100))

const FLEET_BOX: PlotBox = { left: 34, top: 8, width: 558, height: 128 }
const FLEET_VIEW = { width: 600, height: 144 }
const fleetMax = computed(() => {
  const all = [...weekValues.value, ...sessionValues.value].filter((v): v is number => v !== null)
  return axisMax(Math.max(100, ...all))
})
const fleetTicks = computed(() => ticks(fleetMax.value))
const yAt = (v: number) => FLEET_BOX.top + FLEET_BOX.height - (v / fleetMax.value) * FLEET_BOX.height
const weekPaths = computed(() => segmentPaths(weekValues.value, FLEET_BOX, fleetMax.value))
const sessionPaths = computed(() => segmentPaths(sessionValues.value, FLEET_BOX, fleetMax.value))
const pctOrGap = (v: number | null) => (v === null ? t('instances.summary.noSample') : `${Math.round(v)}%`)
const fleetHits = computed(() => {
  const n = points.value.length
  const slot = FLEET_BOX.width / Math.max(1, n)
  return points.value.map((p, i) => ({
    x: FLEET_BOX.left + (i / Math.max(1, n - 1)) * FLEET_BOX.width - slot / 2,
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
      <svg
        v-if="sparkPaths.length"
        class="ml-auto shrink-0 overflow-visible text-primary"
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

    <div v-if="open" class="space-y-4 border-t px-3 py-3">
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
        <template v-else>
          <svg
            :viewBox="`0 0 ${FLEET_VIEW.width} ${FLEET_VIEW.height}`"
            class="h-40 w-full overflow-visible"
            role="img"
            :aria-label="$t('instances.summary.fleetTitle')"
          >
            <g v-for="tk in fleetTicks" :key="tk">
              <line
                :x1="FLEET_BOX.left"
                :x2="FLEET_BOX.left + FLEET_BOX.width"
                :y1="yAt(tk)"
                :y2="yAt(tk)"
                class="stroke-border"
                stroke-width="1"
              />
              <text
                :x="FLEET_BOX.left - 6"
                :y="yAt(tk) + 3"
                text-anchor="end"
                class="fill-muted-foreground"
                font-size="9"
              >{{ tk }}%</text>
            </g>
            <path
              v-for="(d, k) in weekPaths"
              :key="`w${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              :style="{ stroke: seriesColor('week', FLEET_ORDER) }"
            />
            <path
              v-for="(d, k) in sessionPaths"
              :key="`s${k}`"
              :d="d"
              fill="none"
              stroke-width="1.75"
              stroke-linejoin="round"
              :style="{ stroke: seriesColor('session', FLEET_ORDER) }"
            />
            <rect
              v-for="(h, i) in fleetHits"
              :key="i"
              :x="h.x"
              :y="FLEET_BOX.top"
              :width="FLEET_BOX.width / Math.max(1, points.length)"
              :height="FLEET_BOX.height"
              fill="transparent"
            >
              <title>{{ h.tip }}</title>
            </rect>
          </svg>
          <div class="mt-0.5 flex justify-between text-3xs text-muted-foreground tabular-nums">
            <span>{{ fleetSpan.first }}</span>
            <span>{{ fleetSpan.last }}</span>
          </div>
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="l in fleetLegend" :key="l.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm" :style="{ background: l.color }"></span>
              {{ l.label }}
            </li>
          </ul>
        </template>
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
          <HourBars :hours="tokenHours" :series="tokenSeries" height-class="h-32" />
          <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
            <li v-for="s in tokenSeries" :key="s.key" class="flex items-center gap-1">
              <span class="inline-block size-2 rounded-sm" :style="{ background: s.color }"></span>
              {{ s.label }}
            </li>
          </ul>
        </template>
      </div>
    </div>
  </section>
</template>
