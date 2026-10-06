<script setup lang="ts">
// The Instances landing page: a small stats page read top to bottom, the accounts first (owner,
// 2026-10-05: "my eyeballs don't know what to focus on ... There's just a ton of blue. And no, adding
// a thousand colors to it isn't gonna help"). Analytics is the advanced page. Each part answers one
// question:
//   Accounts: can work start right now? Per kind, how many accounts are usable now, and what is left
//     of the 5-hour and weekly limits across them, pooled by plan size like the folded CLI table's
//     header (lib/usage-pool).
//   Nearest their limit: which accounts are about to stop? Every signed-in account with a reading,
//     the most used first; the top few shown, the rest behind "+N more".
//   CliMayte: how much went through it, and what is it doing now?
//   Sessions on this PC: how busy is this PC now, in the last hour, in the last day?
//   The 24-hour charts: when did it happen, and on which models?
//   HSwarm: what did the swarm save, and on which accounts?
// Colour only where it means something: greys by default, the accent on an account near its limit,
// the warning tones only for a real warning (a pool running low, no usable account, a failed task).
// Every number comes from an API the other views already read; a part with a detail page emits
// `navigate` with that view's id and the nav opens it.
//   Desktop / CLI accounts: useInstances (/api/instances), useCliInstances (/api/cli-instances) and
//     useUsage (/api/usage cache).
//   CliMayte: /api/corch/totals (tokens, tasks) and /api/corch/workers (running, last hour).
//   Sessions: /api/sessions (period 24h): now, last hour, last 24 hours.
import { Monitor, RefreshCw, Terminal } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import SwarmStatsCard from '@/components/swarm-stats/SwarmStatsCard.vue'
import { Button } from '@/components/ui/button'
import UsageBar from '@/components/UsageBar.vue'
import { useCliInstances } from '@/composables/useCliInstances'
import { useCliMayteData } from '@/composables/useCliMayteData'
import { useHomeSessions } from '@/composables/useHomeSessions'
import { useInstances } from '@/composables/useInstances'
import { pii } from '@/composables/usePrivacy'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import { isCliMayteActive, modelName, tokenTotal } from '@/lib/climayte-status'
import {
  countPerHour,
  type HeadroomRow,
  hourStarts,
  severityOf,
  sortHeadroom,
  usableNow,
  usedPct,
  workersPerHour,
} from '@/lib/home-charts'
import { accountDisplay, useHswarmApi } from '@/lib/hswarm-api'
import { formatTokens, formatUsd, useKitSourceTokens } from '@/lib/kit'
import { accountSaved, useSwarmStats } from '@/lib/swarm-stats'
import { usageBadgeVariant } from '@/lib/usage'
import { type PooledRemaining, pooledRemaining } from '@/lib/usage-pool'
import type { WaitSeverity } from '@/lib/usage-reset'
import { refreshWarm } from '@/lib/warm-data'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

type HomeView = 'cli' | 'instances' | 'climayte' | 'sessions' | 'analytics' | 'hswarm'
const emit = defineEmits<{ navigate: [view: HomeView] }>()

const { t } = useI18n()
const HOUR_MS = 3_600_000
const NOW_MS = 300_000
/** How many rows a per-account list shows before "+N more": he runs about 15 to 50 accounts. */
const TOP = 5

// Every figure is a shared copy kept warm by lib/warm-data.ts; this page only reads them.
const { instances: desktopInstances } = useInstances()
const { cliInstances } = useCliInstances()
const { snapshotFor } = useUsage()
const { totals, workers, unreachable, listedAt } = useCliMayteData()
const { sessionTimes } = useHomeSessions()
const { now } = useUsageMode(true)

const { accountNames } = useHswarmApi()
const { stats: swarmStats } = useSwarmStats(14)
const kitTokens = useKitSourceTokens('climayte')

const failed = computed(() => unreachable.value)
const refreshing = ref(false)
/** Wall clock for the "last hour" cuts, taken at each refresh so a number never changes between them. */
const asOf = ref(Date.now())

/** The refresh button: every kind this page shows, read now. */
async function load() {
  if (refreshing.value) return
  refreshing.value = true
  await Promise.all((['cli', 'desktop', 'climayte', 'hswarm'] as const).map((k) => refreshWarm(k)))
  asOf.value = Date.now()
  refreshing.value = false
}
// The warm refreshes move the "last hour" cuts along: a number never changes between them.
watch(listedAt, () => {
  asOf.value = Date.now()
})

const sessionsSince = (ms: number) =>
  sessionTimes.value.filter((at) => at >= asOf.value - ms).length
const workersTouched = computed(() =>
  workers.value.filter((w) => w.updatedAt >= asOf.value - HOUR_MS),
)

// --- accounts ---

interface PoolInput {
  signedIn: boolean
  planLabel?: string | null
  usage: ReturnType<typeof snapshotFor>
}
interface Gauge {
  key: 'session' | 'week'
  pct: number | null
  variant: WaitSeverity | 'neutral'
  label: string
  tip: string
  counted: string
  leftOut?: string
}

/** One window's pooled gauge. Grey while plenty is left; the CLI table's own warning tones
 *  (usageBadgeVariant) only once the pool runs low, so a coloured bar here always means something. */
function gauge(key: Gauge['key'], pool: PooledRemaining): Gauge {
  const pct = pool.pct
  const tone = pct === null ? 'success' : usageBadgeVariant(100 - pct)
  const session = key === 'session'
  let label: string
  let tip: string
  if (pct === null) {
    label = session ? t('instances.home.pool5hEmpty') : t('instances.home.poolWeekEmpty')
    tip = session ? t('instances.home.pool5hNone') : t('instances.home.poolWeekNone')
  } else {
    label = session
      ? t('instances.home.pool5hLabel', { pct })
      : t('instances.home.poolWeekLabel', { pct })
    tip = session
      ? t('instances.home.pool5hTip', { pct })
      : t('instances.home.poolWeekTip', { pct })
  }
  return {
    key,
    pct,
    variant: tone === 'success' ? 'neutral' : tone,
    label,
    tip,
    counted: t('instances.home.poolCounted', { n: pool.counted }),
    leftOut:
      pool.signedOut + pool.unread > 0
        ? t('instances.home.poolLeftOut', { signedOut: pool.signedOut, unread: pool.unread })
        : undefined,
  }
}

/** One kind's line: usable now (home-charts usableNow), the breakdown, the two gauges. */
function accountLine(rows: PoolInput[]) {
  const { signedIn, spent, usable } = usableNow(
    rows.map((r) => ({ signedIn: r.signedIn, session: r.usage?.session, week: r.usage?.weekAll })),
    now.value.getTime(),
  )
  const pool = (w: 'session' | 'weekAll') =>
    pooledRemaining(
      rows.map((r) => ({ signedIn: r.signedIn, planLabel: r.planLabel, limit: r.usage?.[w] })),
      now.value,
    )
  return {
    total: rows.length,
    usable,
    detail: t('instances.home.usableDetail', {
      signedIn,
      spent,
      signedOut: rows.length - signedIn,
    }),
    gauges: [gauge('session', pool('session')), gauge('week', pool('weekAll'))],
  }
}
// One computed per kind, so a CLI poll does not redo the desktop line. A CLI login's plan falls back
// to its linked desktop row's, as the CLI table's header does, so the two read the same pool.
const desktopByDir = computed(() => new Map(desktopInstances.value.map((d) => [d.dir, d])))
const cliLine = computed(() => {
  const line = accountLine(
    cliInstances.value.map((i) => ({
      signedIn: i.loggedIn,
      planLabel:
        i.planLabel ??
        (i.associatedDesktopDir
          ? desktopByDir.value.get(i.associatedDesktopDir)?.account?.planLabel
          : null),
      usage: snapshotFor(`cli:${i.id}`),
    })),
  )
  return {
    ...line,
    key: 'cli' as const,
    title: t('instances.home.cliTitle'),
    text: t('instances.home.cliUsable', { total: line.total }),
    to: 'cli' as const,
  }
})
const desktopLine = computed(() => {
  const line = accountLine(
    desktopInstances.value.map((i) => ({
      signedIn: !!i.account,
      planLabel: i.account?.planLabel,
      usage: snapshotFor(`desktop:${i.dir}`),
    })),
  )
  return {
    ...line,
    key: 'desktop' as const,
    title: t('instances.home.desktopTitle'),
    text: t('instances.home.desktopUsable', { total: line.total }),
    to: 'instances' as const,
  }
})
const accountLines = computed(() => [cliLine.value, desktopLine.value].filter((l) => l.total > 0))

// --- nearest their limit ---

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
  // A CLI instance is usually named by its account's address: masked in privacy mode.
  return sortHeadroom([
    ...cliInstances.value
      .filter((i) => i.loggedIn)
      .map((i) =>
        row(`cli:${i.id}`, `#${i.num} ${pii(i.name)}`, snapshotFor(`cli:${i.id}`), 'cli'),
      ),
    ...desktopInstances.value
      .filter((i) => i.account)
      .map((i) =>
        row(
          `desktop:${i.dir}`,
          `#${i.num} ${pii(i.name)}`,
          snapshotFor(`desktop:${i.dir}`),
          'instances',
        ),
      ),
  ])
})
const limitsOpen = ref(false)
const limitRows = computed(() => (limitsOpen.value ? headroom.value : headroom.value.slice(0, TOP)))
const limitMore = computed(() => Math.max(0, headroom.value.length - TOP))
/** 70% used or more (home-charts severityOf): the one place this page spends the accent. */
const nearLimit = (pct: number | null) => pct !== null && severityOf(pct) !== 'ok'
const worstOf = (r: HeadroomRow) => Math.max(r.session ?? 0, r.week ?? 0)
const pctText = (pct: number | null) => (pct === null ? '–' : `${Math.round(pct)}%`)

// --- CliMayte and sessions ---

interface Stat {
  key: string
  label: string
  value: string
  title?: string
  to: HomeView
}
const climayteStats = computed<Stat[]>(() => {
  const tk = totals.value?.tokens
  const tokens = kitTokens.value ?? (tk ? tokenTotal(tk) : null)
  return [
    {
      key: 'tokens',
      label: t('instances.home.climayteTokens'),
      value: tokens === null ? '–' : formatTokens(tokens),
      title: tokens === null ? undefined : tokens.toLocaleString(),
      to: 'climayte',
    },
    {
      key: 'tasks',
      label: t('instances.home.climayteTasks'),
      value: totals.value ? String(totals.value.tasks) : '–',
      to: 'climayte',
    },
    {
      key: 'running',
      label: t('instances.home.climayteRunning'),
      value: String(workers.value.filter(isCliMayteActive).length),
      to: 'climayte',
    },
    {
      key: 'done',
      label: t('instances.home.climayteDone'),
      value: String(workersTouched.value.filter((w) => w.status === 'done').length),
      to: 'climayte',
    },
    {
      key: 'cmsessions',
      label: t('instances.home.climayteSessions'),
      value: String(new Set(workersTouched.value.map((w) => w.sessionId).filter(Boolean)).size),
      to: 'climayte',
    },
  ]
})
const sessionStats = computed<Stat[]>(() => [
  {
    key: 'now',
    label: t('instances.home.sessionsNow'),
    value: String(sessionsSince(NOW_MS)),
    title: t('instances.home.sessionsNowSub'),
    to: 'sessions',
  },
  {
    key: 'hour',
    label: t('instances.home.sessionsHour'),
    value: String(sessionsSince(HOUR_MS)),
    to: 'sessions',
  },
  {
    key: 'day',
    label: t('instances.home.sessionsDay'),
    value: String(sessionTimes.value.length),
    to: 'analytics',
  },
])
const activity = computed(() => [
  {
    key: 'climayte',
    title: t('instances.home.climayteGroup'),
    hint: undefined as string | undefined,
    stats: climayteStats.value,
  },
  {
    key: 'sessions',
    title: t('instances.home.sessionsGroup'),
    hint: t('instances.home.sessionsLocalOnly'),
    stats: sessionStats.value,
  },
])

// --- the 24-hour charts ---

const HOURS = 24
const hourLabel = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:00`
const hourLabels = computed(() => hourStarts(asOf.value, HOURS).map(hourLabel))

// Greys for plain counts; red only for failed tasks, the one bar here that is a warning.
const GREY = 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)'
const outcomeSeries = computed(() => [
  { key: 'done', label: t('instances.home.outDone'), color: GREY },
  { key: 'failed', label: t('instances.home.outFailed'), color: 'var(--destructive)' },
  { key: 'running', label: t('instances.home.outRunning'), color: 'var(--muted-foreground)' },
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
  { key: 'sessions', label: t('instances.home.sessionsUnit'), color: GREY },
])
const sessionHours = computed(() =>
  countPerHour(
    sessionTimes.value,
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
  const total = head.reduce((n, [, c]) => n + c, 0)
  return head.map(([key, n]) => ({ key, n, pct: total ? (n / total) * 100 : 0 }))
})

// --- HSwarm by account ---

const swarmAll = computed(() =>
  [...(swarmStats.value?.accounts?.rows ?? [])]
    .sort((a, b) => b.runs - a.runs)
    .map((r) => {
      const shown = accountDisplay(r.account, accountNames.value, t)
      return {
        key: r.account,
        name: shown.text,
        muted: shown.muted || !accountNames.value[r.account],
        title: shown.title,
        runs: r.runs,
        tasks: r.tasks,
        saved: formatUsd(accountSaved(r)),
        last: r.last ? String(r.last).slice(0, 10) : '–',
      }
    }),
)
const swarmOpen = ref(false)
const swarmRows = computed(() => (swarmOpen.value ? swarmAll.value : swarmAll.value.slice(0, TOP)))
const swarmMore = computed(() => Math.max(0, swarmAll.value.length - TOP))
</script>

<template>
  <div class="@container flex flex-col gap-2 p-3">
    <div class="flex items-center gap-1.5">
      <h2 class="text-sm font-semibold">{{ $t('instances.home.title') }}</h2>
      <InfoHint :text="$t('instances.home.refreshHint')" />
      <span v-if="failed" class="text-xs text-warning">{{ $t('instances.home.loadFailed') }}</span>
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

    <!-- The accounts lead (owner, 2026-10-05): how many can work now, the pool's 5h and week, and who
         is about to stop. The activity numbers sit beside them on a wide page, under them on a narrow one. -->
    <div class="grid gap-2 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section class="rounded-lg border bg-card px-3 py-2">
        <h3 class="flex items-center gap-1.5 text-xs font-semibold">
          {{ $t('instances.home.accounts') }}
          <InfoHint :text="$t('instances.home.accountsHint')" />
        </h3>
        <ul v-if="accountLines.length" class="mt-1.5 space-y-1.5">
          <li
            v-for="line in accountLines"
            :key="line.key"
            class="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <IconTooltip :label="line.title" :description="line.detail">
              <button
                type="button"
                class="flex min-w-0 items-baseline gap-1.5 rounded-sm text-start hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                @click="emit('navigate', line.to)"
              >
                <component
                  :is="line.key === 'cli' ? Terminal : Monitor"
                  class="size-3.5 shrink-0 self-center text-muted-foreground"
                />
                <span
                  class="text-xl leading-none font-semibold tabular-nums"
                  :class="{ 'text-warning': line.usable === 0 }"
                >{{ line.usable }}</span>
                <span class="truncate text-xs text-muted-foreground">{{ line.text }}</span>
              </button>
            </IconTooltip>
            <div class="ml-auto flex items-center gap-1.5">
              <IconTooltip
                v-for="g in line.gauges"
                :key="g.key"
                :label="g.tip"
                :description="g.counted"
                :detail="g.leftOut"
              >
                <div class="w-24 shrink-0">
                  <UsageBar :fill-pct="g.pct ?? 0" :variant="g.variant" :label="g.label" />
                </div>
              </IconTooltip>
            </div>
          </li>
        </ul>
        <p v-else class="py-2 text-2xs text-muted-foreground">{{ $t('instances.home.noAccounts') }}</p>

        <div class="mt-2 border-t pt-1.5">
          <div class="grid grid-cols-[minmax(0,10rem)_minmax(2rem,1fr)_3.5rem_3.5rem] items-center gap-x-2 px-1 pb-0.5">
            <h3 class="col-span-2 flex items-center gap-1.5 text-xs font-semibold">
              {{ $t('instances.home.nearest') }}
              <InfoHint :text="$t('instances.home.nearestHint')" />
            </h3>
            <span class="whitespace-nowrap text-end text-3xs text-muted-foreground">{{ $t('instances.home.chart5h') }}</span>
            <span class="whitespace-nowrap text-end text-3xs text-muted-foreground">{{ $t('instances.home.chartWeek') }}</span>
          </div>
          <ul v-if="headroom.length">
            <li v-for="r in limitRows" :key="r.key">
              <button
                type="button"
                class="grid w-full grid-cols-[minmax(0,10rem)_minmax(2rem,1fr)_3.5rem_3.5rem] items-center gap-x-2 rounded-sm px-1 py-px text-start text-2xs hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                :aria-label="
                  $t('instances.home.openLimit', {
                    name: r.label,
                    session: pctText(r.session),
                    week: pctText(r.week),
                  })
                "
                @click="emit('navigate', r.to)"
              >
                <span class="flex min-w-0 items-center gap-1">
                  <component
                    :is="r.to === 'cli' ? Terminal : Monitor"
                    class="size-3 shrink-0 text-muted-foreground"
                  />
                  <span class="truncate">{{ r.label }}</span>
                </span>
                <span class="h-1 overflow-hidden rounded-full bg-muted-foreground/10">
                  <span
                    class="block h-full rounded-full"
                    :class="nearLimit(worstOf(r)) ? 'bg-primary' : 'bg-muted-foreground/35'"
                    :style="{ width: `${worstOf(r)}%` }"
                  ></span>
                </span>
                <span
                  class="text-end tabular-nums"
                  :class="nearLimit(r.session) ? 'font-semibold text-foreground' : 'text-muted-foreground'"
                >{{ pctText(r.session) }}</span>
                <span
                  class="text-end tabular-nums"
                  :class="nearLimit(r.week) ? 'font-semibold text-foreground' : 'text-muted-foreground'"
                >{{ pctText(r.week) }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="py-2 text-center text-2xs text-muted-foreground">{{ $t('instances.home.chartHeadroomEmpty') }}</p>
          <button
            v-if="limitMore > 0"
            type="button"
            class="mt-0.5 rounded-sm px-1 text-2xs text-muted-foreground hover:text-foreground hover:underline"
            :aria-expanded="limitsOpen"
            @click="limitsOpen = !limitsOpen"
          >
            {{ limitsOpen ? $t('instances.home.fewer') : $t('instances.home.more', { n: limitMore }) }}
          </button>
        </div>
      </section>

      <section class="grid content-start gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 @xl:grid-cols-2 @4xl:grid-cols-1">
        <div v-for="g in activity" :key="g.key">
          <h3 class="mb-0.5 flex items-center gap-1.5 text-xs font-semibold">
            {{ g.title }}
            <InfoHint v-if="g.hint" :text="g.hint" />
          </h3>
          <ul class="-mx-1">
            <li v-for="s in g.stats" :key="s.key">
              <button
                type="button"
                class="flex w-full items-baseline gap-2 rounded-sm px-1 text-start hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                :title="s.title"
                @click="emit('navigate', s.to)"
              >
                <span class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{{ s.label }}</span>
                <span class="text-xs font-semibold tabular-nums">{{ s.value }}</span>
              </button>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- One row of charts or one column, never 2 + 1: a lone chart on its own row wasted a band of the
         page (owner, 2026-10-03: the at-a-glance page must stay compact). -->
    <div
      class="grid grid-cols-1 gap-2"
      :class="modelSplit.length ? '@4xl:grid-cols-3' : '@2xl:grid-cols-2'"
    >
      <section class="cursor-pointer rounded-lg border bg-card px-3 py-1.5" @click="emit('navigate', 'climayte')">
        <h3 class="mb-1 flex flex-wrap items-center gap-x-2 text-xs font-semibold">
          {{ $t('instances.home.chartWorkers') }}
          <span class="text-3xs font-normal text-muted-foreground tabular-nums">{{ workersDay }}</span>
          <span class="ml-auto flex items-center gap-2 text-3xs font-normal text-muted-foreground">
            <span v-for="s in outcomeSeries" :key="s.key" class="flex items-center gap-1">
              <i class="inline-block size-1.5 rounded-full" :style="{ background: s.color }"></i>{{ s.label }}
            </span>
          </span>
        </h3>
        <HourBars :hours="workerHours" :series="outcomeSeries" height-class="h-14" />
      </section>

      <section class="cursor-pointer rounded-lg border bg-card px-3 py-1.5" @click="emit('navigate', 'sessions')">
        <h3 class="mb-1 flex items-center gap-2 text-xs font-semibold">
          {{ $t('instances.home.chartSessions') }}
          <span class="text-3xs font-normal text-muted-foreground tabular-nums">{{ sessionTimes.length }}</span>
        </h3>
        <HourBars :hours="sessionHours" :series="sessionSeries" height-class="h-14" />
      </section>

      <section v-if="modelSplit.length" class="cursor-pointer rounded-lg border bg-card px-3 py-1.5" @click="emit('navigate', 'climayte')">
        <h3 class="mb-1 text-xs font-semibold">{{ $t('instances.home.chartModels') }}</h3>
        <ul class="space-y-0.5 text-2xs">
          <li
            v-for="m in modelSplit"
            :key="m.key"
            class="grid grid-cols-[minmax(0,7rem)_minmax(2rem,1fr)_auto] items-center gap-2"
          >
            <span class="truncate text-muted-foreground">{{ m.key }}</span>
            <span class="h-1 overflow-hidden rounded-full bg-muted-foreground/10">
              <span class="block h-full rounded-full bg-muted-foreground/35" :style="{ width: `${m.pct}%` }"></span>
            </span>
            <span class="tabular-nums">{{ m.n }}</span>
          </li>
        </ul>
      </section>
    </div>

    <SwarmStatsCard @open="emit('navigate', 'hswarm')" />
    <div v-if="swarmAll.length" class="rounded-lg border bg-card px-3 py-1.5">
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
            <td
              class="max-w-0 truncate py-0.5"
              :class="r.muted ? 'text-muted-foreground' : ''"
              :title="r.title"
            >{{ r.name }}</td>
            <td class="py-0.5 text-end">{{ r.runs }}</td>
            <td class="py-0.5 text-end">{{ r.tasks }}</td>
            <td class="py-0.5 text-end">{{ r.saved }}</td>
            <td class="py-0.5 text-end text-muted-foreground">{{ r.last }}</td>
          </tr>
        </tbody>
      </table>
      <button
        v-if="swarmMore > 0"
        type="button"
        class="mt-0.5 rounded-sm text-2xs text-muted-foreground hover:text-foreground hover:underline"
        :aria-expanded="swarmOpen"
        @click="swarmOpen = !swarmOpen"
      >
        {{ swarmOpen ? $t('instances.home.fewer') : $t('instances.home.more', { n: swarmMore }) }}
      </button>
    </div>
  </div>
</template>
