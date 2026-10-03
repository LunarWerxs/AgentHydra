<script setup lang="ts">
// The Instances landing page: a quick, at-a-glance look as stat tiles. Analytics is the advanced page.
// Every number comes from an API the other views already read; a tile with a detail page emits
// `navigate` with that view's id and the nav opens it.
//   Desktop / CLI accounts: useInstances (/api/instances), useCliInstances (/api/cli-instances) and
//     useUsage (/api/usage cache), pooled with lib/usage-pool like the folded CLI table's header.
//   CliMayte: /api/corch/totals (tokens, tasks) and /api/corch/workers (running, last hour).
//   Sessions: /api/sessions (period 24h): now, last hour, last 24 hours.
import {
  Bot,
  CheckCheck,
  Clock,
  Coins,
  History,
  Layers,
  Monitor,
  RefreshCw,
  Terminal,
  Zap,
} from '@lucide/vue'
import { useDocumentVisibility, useElementVisibility } from '@vueuse/core'
import { type Component, computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import SwarmStatsCard from '@/components/swarm-stats/SwarmStatsCard.vue'
import { Button } from '@/components/ui/button'
import { useCliInstances } from '@/composables/useCliInstances'
import { useInstances } from '@/composables/useInstances'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import {
  type CliMayteTotals,
  type CliMayteWorkerView,
  getCliMayteTotals,
  getSessions,
  listCliMayteWorkers,
  type SessionSummary,
} from '@/lib/api'
import { seriesColor } from '@/lib/chart'
import { formatTokens, isCliMayteActive, modelName } from '@/lib/climayte-status'
import { formatUsd } from '@/lib/format'
import {
  countPerHour,
  type HeadroomRow,
  hourStarts,
  severityOf,
  sortHeadroom,
  usedPct,
  workersPerHour,
} from '@/lib/home-charts'
import { useHswarmApi } from '@/lib/hswarm-api'
import { useSwarmStats } from '@/lib/swarm-stats'
import { pooledRemaining } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

type HomeView = 'cli' | 'instances' | 'climayte' | 'sessions' | 'analytics' | 'hswarm'
const emit = defineEmits<{ navigate: [view: HomeView] }>()

const { t } = useI18n()
const REFRESH_MS = 20_000
const HOUR_MS = 3_600_000
const NOW_MS = 300_000

const { instances: desktopInstances, refreshInstances } = useInstances()
const { cliInstances, refreshCliInstances } = useCliInstances()
const { snapshotFor, hydrate } = useUsage()
const { now } = useUsageMode(true)

const { fetchAccountNames } = useHswarmApi()
const { stats: swarmStats } = useSwarmStats(14)
const accountNames = ref<Record<string, { num: number; label: string; kind: string }>>({})
onMounted(async () => {
  accountNames.value = await fetchAccountNames()
})
const swarmRows = computed(() =>
  [...(swarmStats.value?.accounts?.rows ?? [])]
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 8)
    .map((r) => {
      const n = accountNames.value[r.account]
      return {
        key: r.account,
        name: n ? `#${n.num} ${n.label}` : r.account,
        runs: r.runs,
        tasks: r.tasks,
        saved: formatUsd(r.est_usd - r.worker_usd),
        last: r.last ? String(r.last).slice(0, 10) : '–',
      }
    }),
)

const totals = ref<CliMayteTotals | null>(null)
const workers = ref<CliMayteWorkerView[]>([])
const sessions = ref<SessionSummary[]>([])
const failed = ref(false)
const refreshing = ref(false)
/** Wall clock for the "last hour" cuts, taken at each refresh so a tile never changes between them. */
const asOf = ref(Date.now())

function poolLine(which: 'desktop' | 'cli'): string {
  const rows =
    which === 'cli'
      ? cliInstances.value.map((i) => ({
          signedIn: i.loggedIn,
          planLabel: i.planLabel,
          usage: snapshotFor(`cli:${i.id}`),
        }))
      : desktopInstances.value.map((i) => ({
          signedIn: !!i.account,
          planLabel: i.account?.planLabel,
          usage: snapshotFor(`desktop:${i.dir}`),
        }))
  const pct = (w: 'session' | 'weekAll') => {
    const p = pooledRemaining(
      rows.map((r) => ({ signedIn: r.signedIn, planLabel: r.planLabel, limit: r.usage?.[w] })),
      now.value,
    ).pct
    return p === null ? t('instances.home.poolNone') : `${p}%`
  }
  return t('instances.home.poolLine', { session: pct('session'), week: pct('weekAll') })
}

async function load() {
  if (refreshing.value) return
  refreshing.value = true
  const results = await Promise.allSettled([
    refreshInstances({ silent: true }),
    refreshCliInstances({ silent: true }),
    hydrate(),
    getCliMayteTotals().then((v) => {
      totals.value = v
    }),
    listCliMayteWorkers().then((v) => {
      workers.value = v
    }),
    getSessions(1000, '', 'hide', '24h').then((v) => {
      sessions.value = v
    }),
  ])
  failed.value = results.some((r) => r.status === 'rejected')
  asOf.value = Date.now()
  refreshing.value = false
}

const sessionsSince = (ms: number) =>
  sessions.value.filter((s) => s.last_activity_at >= asOf.value - ms).length
const workersTouched = computed(() =>
  workers.value.filter((w) => w.updatedAt >= asOf.value - HOUR_MS),
)

interface Tile {
  key: string
  icon: Component
  value: string
  label: string
  sub?: string
  to?: HomeView
}
// --- charts band ---
const HOURS = 24
const hourLabel = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:00`
const hourLabels = computed(() => hourStarts(asOf.value, HOURS).map(hourLabel))

const headroom = computed(() => {
  const at = now.value.getTime()
  const row = (
    key: string,
    label: string,
    snap: ReturnType<typeof snapshotFor>,
    to: HeadroomRow['to'],
  ): HeadroomRow => ({
    key,
    label,
    session: usedPct(snap?.session, at),
    week: usedPct(snap?.weekAll, at),
    to,
  })
  return sortHeadroom([
    ...cliInstances.value
      .filter((i) => i.loggedIn)
      .map((i) => row(`cli:${i.id}`, `#${i.num} ${i.name}`, snapshotFor(`cli:${i.id}`), 'cli')),
    ...desktopInstances.value
      .filter((i) => i.account)
      .map((i) =>
        row(
          `desktop:${i.dir}`,
          `#${i.num} ${i.name}`,
          snapshotFor(`desktop:${i.dir}`),
          'instances',
        ),
      ),
  ])
})
const sevClass = (pct: number | null) =>
  pct === null
    ? 'bg-muted'
    : { ok: 'bg-emerald-500', warn: 'bg-amber-500', high: 'bg-red-500' }[severityOf(pct)]

const outcomeSeries = computed(() => [
  { key: 'done', label: t('instances.home.outDone'), color: '#10b981' },
  { key: 'failed', label: t('instances.home.outFailed'), color: '#ef4444' },
  { key: 'running', label: t('instances.home.outRunning'), color: '#0ea5e9' },
])
const workerHours = computed(() => {
  const per = workersPerHour(workers.value, asOf.value, HOURS)
  return per.map((b, i) => ({
    label: hourLabels.value[i] ?? '',
    values: [b.done, b.failed, b.running],
  }))
})
const workersDay = computed(() =>
  workerHours.value.reduce((n, h) => n + h.values.reduce((a, b) => a + b, 0), 0),
)
const sessionSeries = computed(() => [
  { key: 'sessions', label: t('instances.home.sessionsUnit'), color: 'var(--viz-seq)' },
])
const sessionHours = computed(() =>
  countPerHour(
    sessions.value.map((s) => s.last_activity_at),
    asOf.value,
    HOURS,
  ).map((n, i) => ({ label: hourLabels.value[i] ?? '', values: [n] })),
)

/** Workers by model (reported, else requested, else the CLI default): top 4, the rest as one. */
const modelSplit = computed(() => {
  const counts = new Map<string, number>()
  for (const w of workers.value) {
    const id = w.reportedModel ?? w.model
    const name = id ? modelName(id) : t('instances.home.modelDefault')
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const head = sorted.slice(0, 4)
  const rest = sorted.slice(4).reduce((n, [, c]) => n + c, 0)
  if (rest > 0) head.push([t('instances.home.modelOther'), rest])
  const order = head.map(([k]) => k)
  const total = head.reduce((n, [, c]) => n + c, 0)
  return head.map(([key, n]) => ({
    key,
    n,
    pct: total ? (n / total) * 100 : 0,
    color: seriesColor(key, order),
  }))
})

const tiles = computed<Tile[]>(() => {
  const signedDesktop = desktopInstances.value.filter((i) => i.account).length
  const signedCli = cliInstances.value.filter((i) => i.loggedIn).length
  const tk = totals.value?.tokens
  return [
    {
      key: 'desktop',
      icon: Monitor,
      value: String(desktopInstances.value.length),
      label: t('instances.home.desktopTitle'),
      sub: `${t('instances.home.desktopSignedIn', { n: signedDesktop })} · ${poolLine('desktop')}`,
      to: 'instances',
    },
    {
      key: 'cli',
      icon: Terminal,
      value: String(cliInstances.value.length),
      label: t('instances.home.cliTitle'),
      sub: `${t('instances.home.cliSignedIn', { n: signedCli })} · ${poolLine('cli')}`,
      to: 'cli',
    },
    {
      key: 'tokens',
      icon: Coins,
      value: tk ? formatTokens(tk.input + tk.output + tk.cacheRead + tk.cacheWrite) : '–',
      label: t('instances.home.climayteTokens'),
      sub: totals.value
        ? t('instances.home.climayteTokensSub', { tasks: totals.value.tasks })
        : undefined,
      to: 'climayte',
    },
    {
      key: 'running',
      icon: Zap,
      value: String(workers.value.filter(isCliMayteActive).length),
      label: t('instances.home.climayteRunning'),
      to: 'climayte',
    },
    {
      key: 'done',
      icon: CheckCheck,
      value: String(workersTouched.value.filter((w) => w.status === 'done').length),
      label: t('instances.home.climayteDone'),
      to: 'climayte',
    },
    {
      key: 'cmsessions',
      icon: Bot,
      value: String(new Set(workersTouched.value.map((w) => w.sessionId).filter(Boolean)).size),
      label: t('instances.home.climayteSessions'),
      to: 'climayte',
    },
    {
      key: 'now',
      icon: Clock,
      value: String(sessionsSince(NOW_MS)),
      label: t('instances.home.sessionsNow'),
      sub: t('instances.home.sessionsNowSub'),
      to: 'sessions',
    },
    {
      key: 'hour',
      icon: History,
      value: String(sessionsSince(HOUR_MS)),
      label: t('instances.home.sessionsHour'),
      to: 'sessions',
    },
    {
      key: 'day',
      icon: Layers,
      value: String(sessions.value.length),
      label: t('instances.home.sessionsDay'),
      to: 'analytics',
    },
  ]
})

// Refresh on an interval, and only while the page is on screen and the tab is in front.
const root = ref<HTMLElement | null>(null)
const elementVisible = useElementVisibility(root)
const tabVisibility = useDocumentVisibility()
const active = computed(() => elementVisible.value && tabVisibility.value === 'visible')
let timer: number | null = null
function stop() {
  if (timer !== null) window.clearInterval(timer)
  timer = null
}
function start() {
  stop()
  void load()
  timer = window.setInterval(() => void load(), REFRESH_MS)
}
watch(active, (on) => (on ? start() : stop()))
onMounted(() => {
  if (active.value) start()
})
onUnmounted(stop)
</script>

<template>
  <div ref="root" class="@container flex flex-col gap-2 p-3">
    <div class="flex items-center gap-1.5">
      <h2 class="text-sm font-semibold">{{ $t('instances.home.title') }}</h2>
      <InfoHint :text="`${$t('instances.home.refreshHint')} ${$t('instances.home.sessionsLocalOnly')}`" />
      <span v-if="failed" class="text-xs text-muted-foreground">{{ $t('instances.home.loadFailed') }}</span>
      <IconTooltip :label="$t('instances.home.refresh')">
        <Button
          class="ml-auto"
          variant="outline"
          size="icon"
          :aria-label="$t('instances.home.refresh')"
          :disabled="refreshing"
          @click="load()"
        >
          <RefreshCw :class="{ 'animate-spin': refreshing }" />
        </Button>
      </IconTooltip>
    </div>
    <SwarmStatsCard @open="emit('navigate', 'hswarm')" />
    <!-- 1, 2 or all-in-a-row columns by the view's own width, never 3 + 1: a lone chart on its own row
         wasted a band of the page (owner, 2026-10-03: the at-a-glance page must stay compact). -->
    <div class="grid grid-cols-1 gap-2 @2xl:grid-cols-2" :class="modelSplit.length ? '@6xl:grid-cols-4' : '@6xl:grid-cols-3'">
      <section class="rounded-lg border bg-card px-3 py-1.5">
        <h3 class="mb-1 flex items-center gap-2 text-xs font-semibold">
          {{ $t('instances.home.chartHeadroom') }}
          <span class="ml-auto flex items-center gap-2 text-3xs font-normal text-muted-foreground">
            <span class="flex items-center gap-1"><i class="inline-block h-1.5 w-3 rounded-full bg-foreground/70"></i>{{ $t('instances.home.chart5h') }}</span>
            <span class="flex items-center gap-1"><i class="inline-block h-1.5 w-3 rounded-full bg-foreground/35"></i>{{ $t('instances.home.chartWeek') }}</span>
          </span>
        </h3>
        <ul v-if="headroom.length" class="max-h-[7.5rem] space-y-0.5 overflow-y-auto">
          <li v-for="r in headroom" :key="r.key">
            <button
              type="button"
              class="grid w-full grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-start text-2xs hover:bg-accent/50"
              :aria-label="$t('instances.home.open', { name: r.label })"
              @click="emit('navigate', r.to)"
            >
              <span class="flex min-w-0 items-center gap-1 text-muted-foreground">
                <component :is="r.to === 'cli' ? Terminal : Monitor" class="size-3 shrink-0" />
                <span class="truncate">{{ r.label }}</span>
              </span>
              <span class="flex flex-col gap-0.5">
                <span class="h-1 overflow-hidden rounded-full bg-muted">
                  <span class="block h-full rounded-full" :class="sevClass(r.session)" :style="{ width: `${r.session ?? 0}%` }"></span>
                </span>
                <span class="h-1 overflow-hidden rounded-full bg-muted">
                  <span class="block h-full rounded-full opacity-60" :class="sevClass(r.week)" :style="{ width: `${r.week ?? 0}%` }"></span>
                </span>
              </span>
              <span class="w-14 text-end tabular-nums">{{ r.session === null ? '–' : Math.round(r.session) }}/{{ r.week === null ? '–' : Math.round(r.week) }}%</span>
            </button>
          </li>
        </ul>
        <p v-else class="py-4 text-center text-2xs text-muted-foreground">{{ $t('instances.home.chartHeadroomEmpty') }}</p>
      </section>

      <section class="cursor-pointer rounded-lg border bg-card px-3 py-1.5" @click="emit('navigate', 'climayte')">
        <h3 class="mb-1 flex items-center gap-2 text-xs font-semibold">
          {{ $t('instances.home.chartWorkers') }}
          <span class="text-3xs font-normal text-muted-foreground tabular-nums">{{ workersDay }}</span>
          <span class="ml-auto flex items-center gap-2 text-3xs font-normal text-muted-foreground">
            <span v-for="s in outcomeSeries" :key="s.key" class="flex items-center gap-1">
              <i class="inline-block size-1.5 rounded-full" :style="{ background: s.color }"></i>{{ s.label }}
            </span>
          </span>
        </h3>
        <HourBars :hours="workerHours" :series="outcomeSeries" height-class="h-[5.5rem]" />
      </section>

      <section
        class="cursor-pointer rounded-lg border bg-card px-3 py-1.5"
        :class="{ '@2xl:@max-6xl:col-span-2': !modelSplit.length }"
        @click="emit('navigate', 'sessions')"
      >
        <h3 class="mb-1 flex items-center gap-2 text-xs font-semibold">
          {{ $t('instances.home.chartSessions') }}
          <span class="text-3xs font-normal text-muted-foreground tabular-nums">{{ sessions.length }}</span>
        </h3>
        <HourBars :hours="sessionHours" :series="sessionSeries" height-class="h-[5.5rem]" />
      </section>

      <section v-if="modelSplit.length" class="cursor-pointer rounded-lg border bg-card px-3 py-1.5" @click="emit('navigate', 'climayte')">
        <h3 class="mb-1.5 text-xs font-semibold">{{ $t('instances.home.chartModels') }}</h3>
        <div class="flex h-3 w-full gap-px overflow-hidden rounded-full bg-muted">
          <div
            v-for="m in modelSplit"
            :key="m.key"
            class="h-full"
            :style="{ width: `${m.pct}%`, background: m.color }"
            :title="`${m.key}: ${m.n}`"
          ></div>
        </div>
        <ul class="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
          <li v-for="m in modelSplit" :key="m.key" class="flex min-w-0 items-center gap-1.5">
            <i class="inline-block size-1.5 shrink-0 rounded-full" :style="{ background: m.color }"></i>
            <span class="truncate text-muted-foreground">{{ m.key }}</span>
            <span class="ml-auto tabular-nums">{{ m.n }}</span>
          </li>
        </ul>
      </section>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-1.5">
      <button
        v-for="tile in tiles"
        :key="tile.key"
        type="button"
        class="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        :title="tile.sub ? `${tile.label}: ${tile.sub}` : tile.label"
        :aria-label="tile.to ? $t('instances.home.open', { name: tile.label }) : tile.label"
        @click="tile.to && emit('navigate', tile.to)"
      >
        <component :is="tile.icon" class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-base leading-none font-semibold tabular-nums">{{ tile.value }}</span>
        <span class="min-w-0 truncate text-2xs text-muted-foreground">{{ tile.label }}</span>
      </button>
    </div>
    <div v-if="swarmRows.length" class="rounded-lg border bg-card px-3 py-1.5">
      <div class="mb-1 text-xs font-semibold">{{ $t('swarmStats.byAccount') }}</div>
      <table class="w-full text-xs tabular-nums">
        <thead class="text-start text-[11px] text-muted-foreground">
          <tr>
            <th class="py-0.5 text-start font-normal">{{ $t('swarmStats.colAccount') }}</th>
            <th class="py-0.5 text-end font-normal">{{ $t('swarmStats.colRuns') }}</th>
            <th class="py-0.5 text-end font-normal">{{ $t('swarmStats.colTasks') }}</th>
            <th class="py-0.5 text-end font-normal">{{ $t('swarmStats.colSaved') }}</th>
            <th class="py-0.5 text-end font-normal">{{ $t('swarmStats.colLast') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in swarmRows" :key="r.key" class="border-t border-border/50">
            <td class="max-w-0 truncate py-0.5">{{ r.name }}</td>
            <td class="py-0.5 text-end">{{ r.runs }}</td>
            <td class="py-0.5 text-end">{{ r.tasks }}</td>
            <td class="py-0.5 text-end">{{ r.saved }}</td>
            <td class="py-0.5 text-end text-muted-foreground">{{ r.last }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
