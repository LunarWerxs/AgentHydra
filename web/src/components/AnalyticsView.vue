<script setup lang="ts">
// The analytics tab. Everything here reads per-session TOTALS the daemon computed in the background
// (server/src/analytics.ts) — no transcript is opened to draw any of it, which is why the charts are
// instant on a store with thousands of sessions in it.
//
// COVERAGE IS ALWAYS ON SCREEN. A chart drawn from a half-warmed store looks exactly like one drawn
// from a complete store, so the header says how many sessions are actually behind the numbers. A
// dashboard that hides that is the most confident way to be wrong.
//
// PRICES ARE LIST PRICES. These are subscription accounts; nobody is billed per token. The figure
// answers "what would this have cost on the API", which is the useful comparison, and the header
// says so rather than letting a dollar sign imply a bill.
import {
  BarChart3,
  Boxes,
  Coins,
  FileEdit,
  FolderGit2,
  Hourglass,
  Layers,
  RefreshCw,
  Wrench,
} from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AreaLine from '@/components/charts/AreaLine.vue'
import BarRows from '@/components/charts/BarRows.vue'
import EditsFeed from '@/components/charts/EditsFeed.vue'
import HourGrid from '@/components/charts/HourGrid.vue'
import TimeBars from '@/components/charts/TimeBars.vue'
import TokenSplit from '@/components/charts/TokenSplit.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAnalyticsPrefs } from '@/composables/useAnalyticsPrefs'
import type {
  ActivityReport,
  AgentPresence,
  ConcurrencyPoint,
  EditEntry,
  SessionPeriod,
  SpendReport,
} from '@/lib/api'
import * as api from '@/lib/api'
import { modelVendor, shortUsd, vendorLabel } from '@/lib/chart'
import { baseName, formatCompact, formatUsd } from '@/lib/format'
import IconTooltip from '@/shell/IconTooltip.vue'

const { t } = useI18n()
const { analyticsPeriod } = useAnalyticsPrefs()

/** Narrow every cost/model chart to one vendor. Client-side over the report already fetched: the
 *  vendor is derived from the model id, so the daemon has nothing extra to compute. */
const vendorFilter = ref<string>('all')

const spend = ref<SpendReport | null>(null)
const activity = ref<ActivityReport | null>(null)
const concurrency = ref<ConcurrencyPoint[]>([])
const edits = ref<EditEntry[]>([])
/** Tools found on this machine, readable or not. Independent of the period filter: an install is
 *  not something that happened in the last 30 days. */
const agentTools = ref<AgentPresence[]>([])

/** Why a detected tool is not read. Written as a switch over literal keys rather than an
 *  interpolated one so the i18n checker can see every string that is actually used. */
function toolNoteLabel(note: string | undefined): string {
  if (note === 'encrypted') return t('analytics.toolNoteEncrypted')
  if (note === 'credits') return t('analytics.toolNoteCredits')
  if (note === 'opt-in') return t('analytics.toolNoteOptIn')
  return t('analytics.toolUnread')
}
const loading = ref(true)
const refreshing = ref(false)

async function load() {
  loading.value = true
  const period = analyticsPeriod.value
  try {
    // In parallel: independent reads of the same warmed table, so serialising them would just add
    // round trips to a page that is otherwise instant. The tool scan is the one that touches disk;
    // it is capped and cached server-side, and its failure must not take the charts with it.
    const [s, a, c, e, tools] = await Promise.all([
      api.getSpend(period),
      api.getActivity(period),
      api.getConcurrency(period, period === '24h' ? 60 : 180),
      api.getRecentEdits(120),
      api.getAgentTools().catch(() => ({ tools: [] })),
    ])
    if (analyticsPeriod.value !== period) return // the window moved on while we were fetching
    spend.value = s
    activity.value = a
    concurrency.value = c.buckets
    edits.value = e.edits
    agentTools.value = tools.tools
  } catch {
    spend.value = null
    activity.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(analyticsPeriod, load)

async function rescan() {
  refreshing.value = true
  try {
    const r = await api.refreshAnalytics()
    // A failure count is surfaced rather than swallowed: a warm where EVERY file failed reports the
    // same "scanned 0" as a warm with nothing to do, and those are very different states.
    if (r.failed > 0) toast.warning(t('analytics.rescanFailedSome', { n: r.failed }))
    else
      toast.success(
        r.budgetExhausted
          ? t('analytics.rescanPartial', { n: r.scanned })
          : t('analytics.rescanDone', { n: r.scanned }),
      )
    await load()
  } catch {
    toast.error(t('analytics.rescanFailed'))
  } finally {
    refreshing.value = false
  }
}

const PERIOD_LABEL: Record<SessionPeriod, string> = {
  '24h': 'sessions.period24h',
  '7d': 'sessions.period7d',
  '30d': 'sessions.period30d',
  all: 'sessions.periodAll',
}
const periodLabel = computed(() => t(PERIOD_LABEL[analyticsPeriod.value]))

const coverage = computed(() => spend.value?.coverage ?? activity.value?.coverage ?? null)
const complete = computed(() => {
  const c = coverage.value
  return !!c && c.total > 0 && c.sessions >= c.total
})

/** Fixed colour order for the model series: assigned by model id, so narrowing the window cannot
 *  repaint the models that remain. */
const modelOrder = computed(() => (spend.value?.byModel ?? []).map((b) => b.key))

/** Tokens, for the models a price table cannot reach. Magnitude, so one hue. */
const unpricedBuckets = computed(() =>
  unpricedModelRows.value
    .filter((b) => matchesVendor(b.key))
    .map((b) => ({
      key: b.key,
      label: b.key,
      value: b.tokens?.total ?? b.weighted,
      detail: t('analytics.modelDetail', { turns: b.turns, sessions: b.sessions }),
    })),
)
const unpricedTokenRows = computed(() => unpricedBuckets.value.slice(0, 6))
const unpricedMore = computed(() => unpricedBuckets.value.slice(6))

/**
 * A COST chart contains only things that have a cost.
 *
 * Models with no published price used to be drawn at $0, which does not mean "we could not price
 * this" — it means "this was free", and for a month of GPT usage that is simply a false statement.
 * They are named underneath instead, so their absence is explained rather than silent, and their
 * tokens still appear in the split and the per-tool chart above.
 */
const pricedModels = computed(() => (spend.value?.byModel ?? []).filter((b) => b.costUsd !== null))
const unpricedModelRows = computed(() =>
  (spend.value?.byModel ?? []).filter((b) => b.costUsd === null),
)

/** Every vendor present, for the filter. Built from the UNFILTERED report, so the control can never
 *  hide the option that would bring the rest back. */
const vendors = computed(() => {
  const seen = new Map<string, number>()
  for (const b of spend.value?.byModel ?? []) {
    const v = modelVendor(b.key)
    seen.set(v, (seen.get(v) ?? 0) + (b.tokens?.total ?? 0))
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => ({ key, label: vendorLabel(key) }))
})
const matchesVendor = (model: string) =>
  vendorFilter.value === 'all' || modelVendor(model) === vendorFilter.value

const modelBuckets = computed(() =>
  pricedModels.value
    .filter((b) => matchesVendor(b.key))
    .map((b) => ({
      key: b.key,
      label: b.key,
      value: b.costUsd ?? 0,
      detail: t('analytics.modelDetail', { turns: b.turns, sessions: b.sessions }),
    })),
)
const modelRows = computed(() => modelBuckets.value.slice(0, 5))
const modelMore = computed(() => modelBuckets.value.slice(5))

const projectBuckets = computed(() =>
  (spend.value?.byProject ?? []).map((b) => ({
    key: b.key,
    label: baseName(b.key) || b.key,
    value: b.costUsd ?? 0,
    detail: b.key,
  })),
)
const projectRows = computed(() => projectBuckets.value.slice(0, 8))
const projectMore = computed(() => projectBuckets.value.slice(8))

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'sessions.sourceClaude',
  codex: 'sessions.sourceCodex',
  opencode: 'sessions.sourceOpenCode',
  hermes: 'sessions.sourceHermes',
}
/** Every provider that has usage, so "my stats only show Claude" is answerable at a glance. */
const providerRows = computed(() =>
  (spend.value?.byProvider ?? []).map((p) => ({
    key: p.key,
    label: t(PROVIDER_LABEL[p.key] ?? 'sessions.sourceAll'),
    value: p.tokens.total,
    detail: t('analytics.providerDetail', {
      sessions: p.sessions,
      cost: p.costUsd === null ? '—' : formatUsd(p.costUsd),
    }),
  })),
)

const accountRows = computed(() =>
  (spend.value?.byAccount ?? []).map((b) => ({
    key: b.key,
    label: b.key,
    value: b.costUsd ?? 0,
    detail: t('analytics.accountDetail', { sessions: b.sessions }),
  })),
)

const toolBuckets = computed(() =>
  (activity.value?.tools ?? []).map((tRow) => ({
    key: tRow.key,
    label: tRow.key.startsWith('mcp__') ? tRow.key.split('__').slice(-1)[0] || tRow.key : tRow.key,
    value: tRow.count,
    detail: tRow.key,
  })),
)
const toolRows = computed(() => toolBuckets.value.slice(0, 10))
const toolMore = computed(() => toolBuckets.value.slice(10))

/**
 * Cost over time, by day or by month.
 *
 * ROLLED UP TO MONTHS PAST A THRESHOLD, because a bar per day stops being a chart and becomes a
 * texture: a year is 365 bars a couple of pixels wide, and nobody reads a single day out of that.
 * The threshold is on the number of buckets rather than on the selected window, so a sparse "all
 * time" over three weeks still shows its days and a dense one does not.
 */
const MAX_DAY_BARS = 70

/** 'auto' rolls up only once a day chart would stop being readable; the other two are the reader
 *  saying they know better, which on a window of a month or two they often do. */
const timeGrain = ref<'auto' | 'day' | 'month'>('auto')
const groupedByMonth = computed(() => {
  if (timeGrain.value !== 'auto') return timeGrain.value === 'month'
  return (spend.value?.byDay ?? []).length > MAX_DAY_BARS
})

const dayPoints = computed(() => {
  const days = spend.value?.byDay ?? []
  if (!groupedByMonth.value)
    return days.map((b) => ({
      key: b.key,
      // "12 Aug" rather than the ISO key: the axis has two labels on it and they are for orienting,
      // not for reading a date off.
      label: new Date(`${b.key}T00:00:00`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      }),
      value: b.costUsd ?? 0,
    }))
  // Summed, not averaged: the question a cost chart answers is "what did that month cost".
  const months = new Map<string, number>()
  for (const b of days) {
    const month = b.key.slice(0, 7)
    months.set(month, (months.get(month) ?? 0) + (b.costUsd ?? 0))
  }
  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => ({
      key,
      label: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        year: '2-digit',
      }),
      value,
    }))
})

const concurrencyPoints = computed(() =>
  concurrency.value.map((p) => ({ at: p.at, value: p.sessions })),
)

/** Grouped by project, because "which repo has been getting attention" is the question a feed of
 *  bare paths cannot answer. */
const editGroups = computed(() => {
  const groups = new Map<string, EditEntry[]>()
  for (const e of edits.value) {
    const key = e.project || 'unknown'
    const list = groups.get(key) ?? []
    if (list.length < 8) list.push(e)
    groups.set(key, list)
  }
  return [...groups.entries()].slice(0, 8)
})

const clockLabel = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
const agentHours = computed(() => Math.round((activity.value?.agentMinutes ?? 0) / 60))
</script>

<template>
  <div class="scroll-slim h-full overflow-y-auto">
    <div class="mx-auto w-full max-w-5xl space-y-4 p-4">
      <!-- filters in one row above the charts -->
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="mr-auto flex items-center gap-2 text-sm font-semibold">
          <BarChart3 class="size-4" />{{ $t('analytics.title') }}
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm">{{ periodLabel }}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-48">
            <DropdownMenuRadioGroup v-model="analyticsPeriod">
              <DropdownMenuRadioItem value="24h">{{ $t('sessions.period24h') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="7d">{{ $t('sessions.period7d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="30d">{{ $t('sessions.period30d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all">{{ $t('sessions.periodAll') }}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu v-if="vendors.length > 1">
          <DropdownMenuTrigger as-child>
            <Button :variant="vendorFilter === 'all' ? 'outline' : 'secondary'" size="sm">
              {{ vendorFilter === 'all' ? $t('analytics.allVendors') : vendorLabel(vendorFilter) }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-52">
            <DropdownMenuRadioGroup v-model="vendorFilter">
              <DropdownMenuRadioItem value="all">{{ $t('analytics.allVendors') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem v-for="v in vendors" :key="v.key" :value="v.key">
                {{ v.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconTooltip :label="$t('analytics.rescan')" :description="$t('analytics.rescanHint')">
          <Button variant="outline" size="sm" :disabled="refreshing" @click="rescan">
            <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
          </Button>
        </IconTooltip>
      </div>

      <!-- what the numbers are and are not, before any chart -->
      <p v-if="coverage" class="text-[11px] leading-snug text-muted-foreground">
        {{ $t('analytics.listPrice') }}
        <span v-if="!complete">
          {{ $t('analytics.partial', { n: coverage.sessions, total: coverage.total }) }}
        </span>
        <span v-else>{{ $t('analytics.complete', { n: coverage.sessions }) }}</span>
      </p>

      <template v-if="loading">
        <Skeleton class="h-24 w-full" />
        <Skeleton class="h-44 w-full" />
        <Skeleton class="h-44 w-full" />
      </template>

      <template v-else-if="!spend || spend.sessions === 0">
        <div class="rounded-lg border border-border p-6 text-center text-xs text-muted-foreground">
          {{ $t('analytics.empty') }}
        </div>
      </template>

      <template v-else>
        <!-- the headline: three numbers, no plot. A stat tile is the right form when the answer is
             one number, and dressing it as a chart would add nothing to read. -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-lg border border-border p-3">
            <p class="text-[11px] text-muted-foreground">{{ $t('analytics.totalCost') }}</p>
            <p class="text-xl font-semibold tabular-nums">
              {{ spend.totalCostUsd === null ? '—' : formatUsd(spend.totalCostUsd)
              }}<span v-if="spend.unpricedModels.length">+</span>
            </p>
            <!-- Where the rates came from and how old they are. A dollar total with no price date
                 is a number nobody can audit, and "downloaded" versus "shipped with this build" is
                 the difference between last week's rate card and this release's. -->
            <p class="mt-0.5 text-[10px] text-muted-foreground">
              {{
                spend.priceSource === 'catalog'
                  ? $t('analytics.pricesFetched', { date: spend.pricesAsOf })
                  : $t('analytics.pricesBundled', { date: spend.pricesAsOf })
              }}
            </p>
          </div>
          <div class="rounded-lg border border-border p-3">
            <p class="text-[11px] text-muted-foreground">{{ $t('analytics.sessions') }}</p>
            <p class="text-xl font-semibold tabular-nums">{{ formatCompact(spend.sessions) }}</p>
          </div>
          <div class="rounded-lg border border-border p-3">
            <p class="text-[11px] text-muted-foreground">{{ $t('analytics.agentHours') }}</p>
            <p class="text-xl font-semibold tabular-nums">{{ formatCompact(agentHours) }}</p>
          </div>
          <div class="rounded-lg border border-border p-3">
            <p class="text-[11px] text-muted-foreground">{{ $t('analytics.tokens') }}</p>
            <p class="text-xl font-semibold tabular-nums">
              {{ formatCompact(spend.totalWeighted) }}
            </p>
          </div>
        </div>

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Layers class="size-3.5" />{{ $t('analytics.tokenSplit') }}
          </h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.tokenSplitNote') }}</p>
          <TokenSplit v-if="spend" :tokens="spend.tokens" />
        </section>

        <section v-if="providerRows.length > 1" class="rounded-lg border border-border p-3">
          <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.byProvider') }}</h3>
          <BarRows :rows="providerRows" :format="formatCompact" mono />
        </section>

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <Coins class="size-3.5" />{{
              groupedByMonth ? $t('analytics.costByMonth') : $t('analytics.costByDay')
            }}
            <!-- Pushed right and quiet: a grain switch is a preference, not a headline. -->
            <span class="ml-auto flex items-center gap-0.5">
              <button
                v-for="g in (['day', 'month'] as const)"
                :key="g"
                type="button"
                class="rounded px-1.5 py-0.5 text-[10px] font-normal transition-colors"
                :class="
                  (g === 'month') === groupedByMonth
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                "
                @click="timeGrain = g"
              >{{ g === 'day' ? $t('analytics.grainDay') : $t('analytics.grainMonth') }}</button>
            </span>
          </h3>
          <TimeBars
            :points="dayPoints"
            :format="formatUsd"
            :axis-format="shortUsd"
            :value-label="$t('analytics.tipCost')"
            :share-label="$t('analytics.tipShareOfWindow')"
            :peak-label="groupedByMonth ? $t('analytics.tipBusiestMonth') : $t('analytics.tipBusiestDay')"
          />
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.costByModel') }}</h3>
            <BarRows
              :rows="modelRows"
              :more="modelMore"
              :more-label="$t('analytics.showMore', { n: modelMore.length })"
              :order="modelOrder"
              :format="formatUsd"
            />
            <!-- Named, not drawn at zero: a model with no published price did not cost nothing. -->
            <div v-if="unpricedTokenRows.length" class="mt-3 border-t border-border pt-2">
              <p class="mb-1.5 text-[11px] text-muted-foreground">
                {{ $t('analytics.unpricedNote') }}
              </p>
              <BarRows
                :rows="unpricedTokenRows"
                :more="unpricedMore"
                :more-label="$t('analytics.showMore', { n: unpricedMore.length })"
                :format="formatCompact"
                mono
              />
            </div>
          </section>
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.costByProject') }}</h3>
            <BarRows
              :rows="projectRows"
              :more="projectMore"
              :more-label="$t('analytics.showMore', { n: projectMore.length })"
              :format="formatUsd"
              mono
            />
          </section>
        </div>

        <section v-if="accountRows.length" class="rounded-lg border border-border p-3">
          <h3 class="mb-1 text-xs font-medium">{{ $t('analytics.costByAccount') }}</h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.accountNote') }}</p>
          <BarRows :rows="accountRows" :format="formatUsd" mono />
        </section>

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Hourglass class="size-3.5" />{{ $t('analytics.whenYouWork') }}
          </h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.hourNote') }}</p>
          <HourGrid :hours="activity?.hours ?? []" />
        </section>

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-1 text-xs font-medium">{{ $t('analytics.concurrency') }}</h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.concurrencyNote') }}</p>
          <AreaLine
            :points="concurrencyPoints"
            :format="(n: number) => String(Math.round(n))"
            :label-at="clockLabel"
            :value-label="$t('analytics.tipSessions')"
            :change-label="$t('analytics.tipChange')"
            :peak-label="$t('analytics.tipPeak')"
          />
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              <Wrench class="size-3.5" />{{ $t('analytics.toolMix') }}
            </h3>
            <BarRows
              :rows="toolRows"
              :more="toolMore"
              :more-label="$t('analytics.showMore', { n: toolMore.length })"
              :format="formatCompact"
              mono
            />
          </section>

          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-1 text-xs font-medium">{{ $t('analytics.health') }}</h3>
            <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.healthNote') }}</p>
            <p
              v-if="!activity?.health.length"
              class="text-[11px] text-muted-foreground"
            >{{ $t('analytics.healthNone') }}</p>
            <ul v-else class="scroll-slim max-h-56 space-y-1 overflow-y-auto">
              <li
                v-for="h in activity?.health ?? []"
                :key="h.session_id"
                class="flex items-center gap-2 text-[11px]"
              >
                <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="h.project">
                  {{ baseName(h.project) || h.project }}
                </span>
                <!-- badges, not colour alone: each signal is named as well as counted -->
                <Badge v-if="h.toolErrorStreak >= 3" variant="outline" class="shrink-0 text-[10px]">
                  {{ $t('analytics.streak', { n: h.toolErrorStreak }) }}
                </Badge>
                <Badge v-if="h.compactions" variant="outline" class="shrink-0 text-[10px]">
                  {{ $t('analytics.compactions', { n: h.compactions }) }}
                </Badge>
                <Badge v-if="h.edits >= 40" variant="outline" class="shrink-0 text-[10px]">
                  {{ $t('analytics.churn', { n: h.edits }) }}
                </Badge>
              </li>
            </ul>
          </section>
        </div>

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <FileEdit class="size-3.5" />{{ $t('analytics.recentEdits') }}
          </h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.editsNote') }}</p>
          <p
            v-if="!editGroups.length"
            class="text-[11px] text-muted-foreground"
          >{{ $t('analytics.editsNone') }}</p>
          <div v-for="[project, list] in editGroups" :key="project" class="mb-3">
            <p class="mb-0.5 flex items-baseline gap-2 text-[11px] font-medium">
              <FolderGit2 class="size-3 shrink-0 text-muted-foreground" />
              {{ baseName(project) || project }}
              <span class="text-[10px] font-normal text-muted-foreground">{{ project }}</span>
            </p>
            <EditsFeed :project="project" :edits="list" />
          </div>
        </section>

        <!-- What ELSE is on this machine. Listed even where we cannot read it: silence would read
             as "AgentHydra looked and found nothing", which is a different claim entirely. -->
        <section v-if="agentTools.length" class="rounded-lg border border-border p-3">
          <h3 class="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Boxes class="size-3.5" />{{ $t('analytics.toolsFound') }}
          </h3>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('analytics.toolsFoundNote') }}</p>
          <ul class="grid gap-1 sm:grid-cols-2">
            <li
              v-for="tool in agentTools"
              :key="tool.id"
              class="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50"
              :title="tool.roots.join('\n')"
            >
              <span class="min-w-0 flex-1 truncate">
                {{ tool.name }}
                <span class="ml-1 text-[10px] text-muted-foreground">{{ tool.vendor }}</span>
              </span>
              <span class="shrink-0 tabular-nums text-muted-foreground">
                {{ formatCompact(tool.files) }}<span v-if="tool.truncated">+</span>
              </span>
              <!-- A badge, not a colour: "we cannot read this" is a fact that has to be readable
                   without seeing hue, and it needs its reason next to it. -->
              <Badge
                v-if="tool.format === null"
                variant="outline"
                class="shrink-0 text-[10px] font-normal"
              >
                {{ toolNoteLabel(tool.note) }}
              </Badge>
              <Badge v-else variant="secondary" class="shrink-0 text-[10px] font-normal">
                {{ $t('analytics.toolRead') }}
              </Badge>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
