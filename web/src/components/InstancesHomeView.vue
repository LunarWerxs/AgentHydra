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
import { formatTokens, isCliMayteActive } from '@/lib/climayte-status'
import { pooledRemaining } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

type HomeView = 'cli' | 'instances' | 'climayte' | 'sessions' | 'analytics'
const emit = defineEmits<{ navigate: [view: HomeView] }>()

const { t } = useI18n()
const REFRESH_MS = 20_000
const HOUR_MS = 3_600_000
const NOW_MS = 300_000

const { instances: desktopInstances, refreshInstances } = useInstances()
const { cliInstances, refreshCliInstances } = useCliInstances()
const { snapshotFor, hydrate } = useUsage()
const { now } = useUsageMode(true)

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
  <div ref="root" class="flex flex-col gap-3 p-4">
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
    <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
      <button
        v-for="tile in tiles"
        :key="tile.key"
        type="button"
        class="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        :aria-label="tile.to ? $t('instances.home.open', { name: tile.label }) : tile.label"
        @click="tile.to && emit('navigate', tile.to)"
      >
        <component :is="tile.icon" class="size-5 shrink-0 text-muted-foreground" />
        <span class="min-w-0">
          <span class="block text-2xl leading-none font-semibold tabular-nums">{{ tile.value }}</span>
          <span class="mt-1 block truncate text-xs text-muted-foreground">{{ tile.label }}</span>
          <span v-if="tile.sub" class="block truncate text-[11px] text-muted-foreground/70">{{ tile.sub }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
