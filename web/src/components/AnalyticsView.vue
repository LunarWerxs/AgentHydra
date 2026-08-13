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
import { BarChart3, Coins, FileEdit, Hourglass, RefreshCw, Wrench } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AreaLine from '@/components/charts/AreaLine.vue'
import BarRows from '@/components/charts/BarRows.vue'
import HourGrid from '@/components/charts/HourGrid.vue'
import TimeBars from '@/components/charts/TimeBars.vue'
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
  ConcurrencyPoint,
  EditEntry,
  SessionPeriod,
  SpendReport,
} from '@/lib/api'
import * as api from '@/lib/api'
import { shortUsd, topNWithOther } from '@/lib/chart'
import { baseName, formatCompact, formatUsd } from '@/lib/format'
import IconTooltip from '@/shell/IconTooltip.vue'

const { t } = useI18n()
const { analyticsPeriod } = useAnalyticsPrefs()

const spend = ref<SpendReport | null>(null)
const activity = ref<ActivityReport | null>(null)
const concurrency = ref<ConcurrencyPoint[]>([])
const edits = ref<EditEntry[]>([])
const loading = ref(true)
const refreshing = ref(false)

async function load() {
  loading.value = true
  const period = analyticsPeriod.value
  try {
    // In parallel: four independent reads of the same warmed table, so serialising them would just
    // add three round trips to a page that is otherwise instant.
    const [s, a, c, e] = await Promise.all([
      api.getSpend(period),
      api.getActivity(period),
      api.getConcurrency(period, period === '24h' ? 60 : 180),
      api.getRecentEdits(120),
    ])
    if (analyticsPeriod.value !== period) return // the window moved on while we were fetching
    spend.value = s
    activity.value = a
    concurrency.value = c.buckets
    edits.value = e.edits
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

const modelRows = computed(() =>
  topNWithOther(
    (spend.value?.byModel ?? []).map((b) => ({
      key: b.key,
      label: b.key,
      value: b.costUsd ?? 0,
      detail: t('analytics.modelDetail', { turns: b.turns, sessions: b.sessions }),
    })),
    5,
    (r) => r.value,
    (total, count) => ({
      key: 'other',
      label: t('analytics.other', { n: count }),
      value: total,
      detail: '',
    }),
  ),
)

const projectRows = computed(() =>
  topNWithOther(
    (spend.value?.byProject ?? []).slice(0, 12).map((b) => ({
      key: b.key,
      label: baseName(b.key) || b.key,
      value: b.costUsd ?? 0,
      detail: b.key,
    })),
    8,
    (r) => r.value,
    (total, count) => ({
      key: 'other',
      label: t('analytics.other', { n: count }),
      value: total,
      detail: '',
    }),
  ),
)

const accountRows = computed(() =>
  (spend.value?.byAccount ?? []).map((b) => ({
    key: b.key,
    label: b.key,
    value: b.costUsd ?? 0,
    detail: t('analytics.accountDetail', { sessions: b.sessions }),
  })),
)

const toolRows = computed(() =>
  topNWithOther(
    (activity.value?.tools ?? []).map((tRow) => ({
      key: tRow.key,
      label: tRow.key.startsWith('mcp__')
        ? tRow.key.split('__').slice(-1)[0] || tRow.key
        : tRow.key,
      value: tRow.count,
      detail: tRow.key,
    })),
    10,
    (r) => r.value,
    (total, count) => ({
      key: 'other',
      label: t('analytics.other', { n: count }),
      value: total,
      detail: '',
    }),
  ),
)

const dayPoints = computed(() =>
  (spend.value?.byDay ?? []).map((b) => ({
    key: b.key,
    // "12 Aug" rather than the ISO key: the axis has two labels on it and they are for orienting,
    // not for reading a date off.
    label: new Date(`${b.key}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    }),
    value: b.costUsd ?? 0,
  })),
)

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
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuRadioGroup v-model="analyticsPeriod">
              <DropdownMenuRadioItem value="24h">{{ $t('sessions.period24h') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="7d">{{ $t('sessions.period7d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="30d">{{ $t('sessions.period30d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all">{{ $t('sessions.periodAll') }}</DropdownMenuRadioItem>
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
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <Coins class="size-3.5" />{{ $t('analytics.costByDay') }}
          </h3>
          <TimeBars :points="dayPoints" :format="formatUsd" :axis-format="shortUsd" />
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.costByModel') }}</h3>
            <BarRows :rows="modelRows" :order="modelOrder" :format="formatUsd" />
          </section>
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.costByProject') }}</h3>
            <BarRows :rows="projectRows" :format="formatUsd" mono />
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
          />
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              <Wrench class="size-3.5" />{{ $t('analytics.toolMix') }}
            </h3>
            <BarRows :rows="toolRows" :format="formatCompact" mono />
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
          <div v-for="[project, list] in editGroups" :key="project" class="mb-2">
            <p class="text-[11px] font-medium">{{ baseName(project) || project }}</p>
            <ul class="mt-0.5 space-y-0.5">
              <li
                v-for="(e, i) in list"
                :key="`${e.session_id}-${e.turn}-${i}`"
                class="truncate font-mono text-[11px] text-muted-foreground"
                :title="e.path"
              >
                {{ e.path }}
              </li>
            </ul>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
