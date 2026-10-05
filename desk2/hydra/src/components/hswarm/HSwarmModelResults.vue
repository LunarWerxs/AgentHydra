<script setup lang="ts">
// "Model results" on the HSwarm overview: which models got a thumbs up or down, what a successful task cost on each,
// whether their edits survived a day, and how many tasks each ran per day. Volume, tokens, outcomes, seconds and money
// per model are the analytics toolkit's (`source=hswarm`, groupBy model); only the edit-survival scoring is HSwarm's own
// (`model-stats`), joined by model name once it answers, so the page paints without waiting for it.
import { ThumbsDown, ThumbsUp } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BarRows from '@/components/charts/BarRows.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { seriesColor } from '@/lib/chart'
import type { HswarmMoney } from '@/lib/hswarm-api'
import { moneyLine, useHswarmApi } from '@/lib/hswarm-api'
import {
  fetchKitUsage,
  formatTokens,
  formatUsd,
  localDaysList,
  localTz,
  rollingDaysFrom,
} from '@/lib/kit'

interface ModelRow {
  model: string
  tasks: number
  ok: number
  failed: number
  success_rate: number
  cost_per_ok: number | null
  tokens_per_ok: number | null
  tokens: number
  scored: number
  survival: number | null
}

interface DailyDay {
  date: string
  models: Record<string, number>
  other: number
}

interface Kit {
  models: Array<Omit<ModelRow, 'scored' | 'survival'>>
  totals: HswarmMoney
  dayModel: Array<{ date: string; model: string; calls: number }>
}

/** HSwarm's own scoring per model: how many tasks were scored and the mean 1-day edit survival. */
interface Scores {
  [model: string]: { scored: number; survival: number | null }
}

const TOP_DAILY = 6

const { t } = useI18n()
const { apiCall } = useHswarmApi()

const range = ref(14)
const kit = ref<Kit | null>(null)
const scores = ref<Scores>({})
const error = ref('')
const loading = ref(false)
const scoresLoading = ref(false)
let latest = 0

async function load() {
  const mine = ++latest
  loading.value = true
  error.value = ''
  const base = { source: 'hswarm', from: rollingDaysFrom(range.value), tz: localTz() }
  try {
    const [byModel, byDayModel] = await Promise.all([
      fetchKitUsage({
        ...base,
        groupBy: 'model',
        measures: [
          'tokens',
          'list_usd',
          'billed_usd',
          'unbilled_usd',
          'calls',
          'ok',
          'failed',
          'seconds',
        ],
      }),
      fetchKitUsage({ ...base, groupBy: ['day', 'model'], measures: ['calls'] }),
    ])
    if (mine !== latest) return
    const listUsd = byModel.totals.list_usd ?? 0
    kit.value = {
      models: byModel.rows
        .map((r) => {
          const ok = Number(r.ok)
          const tasks = Number(r.calls)
          const tokens = Number(r.tokens)
          return {
            model: String(r.model ?? 'other'),
            tasks,
            ok,
            failed: Number(r.failed),
            success_rate: tasks ? Math.round((ok / tasks) * 10000) / 10000 : 0,
            cost_per_ok: ok && r.list_usd !== null ? Number(r.list_usd) / ok : null,
            tokens_per_ok: ok ? Math.round(tokens / ok) : null,
            tokens,
          }
        })
        .sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model)),
      totals: {
        value_usd: listUsd,
        spent_usd: byModel.totals.billed_usd ?? 0,
        unknown_usd: byModel.totals.unbilled_usd ?? 0,
      },
      dayModel: byDayModel.rows.map((r) => ({
        date: String(r.day),
        model: String(r.model ?? 'other'),
        calls: Number(r.calls),
      })),
    }
  } catch (err) {
    if (mine === latest) {
      error.value = err instanceof Error ? err.message : String(err)
      scores.value = {}
    }
  } finally {
    if (mine === latest) loading.value = false
  }
  if (mine === latest && !error.value) await loadScores(mine)
}

// Thumbs scoring and edit survival stay HSwarm's: slow to compute, so they join in after the page has painted.
async function loadScores(mine: number) {
  scoresLoading.value = true
  try {
    const stats: { models: Array<{ model: string; scored: number; survival: number | null }> } =
      await apiCall(`model-stats?days=${range.value}`)
    if (mine !== latest) return
    scores.value = Object.fromEntries(
      stats.models.map((m) => [m.model, { scored: m.scored, survival: m.survival }]),
    )
  } catch {
    // Without HSwarm's scoring the survival panel simply stays empty.
    if (mine === latest) scores.value = {}
  } finally {
    if (mine === latest) scoresLoading.value = false
  }
}
onMounted(load)
watch(range, load)

const models = computed<ModelRow[]>(() =>
  (kit.value?.models ?? []).map((m) => ({
    ...m,
    scored: scores.value[m.model]?.scored ?? 0,
    survival: scores.value[m.model]?.survival ?? null,
  })),
)
const order = computed(() => models.value.map((m) => m.model))
const pct = (n: number) => `${Math.round(n * 100)}%`
const tokenFmt = formatTokens

const outcomeMax = computed(() => Math.max(1, ...models.value.map((m) => m.tasks)))
// Tokens per successful task lead; the list-price value of the same task is its secondary figure.
const tokenRows = computed(() =>
  models.value
    .filter((m) => m.tokens_per_ok != null)
    .sort((a, b) => (a.tokens_per_ok ?? 0) - (b.tokens_per_ok ?? 0))
    .map((m) => ({
      key: m.model,
      label: m.model,
      value: m.tokens_per_ok ?? 0,
      detail:
        m.cost_per_ok != null
          ? `${formatUsd(m.cost_per_ok, { style: 'fine' })} ${t('hswarm.v.money.atListPrice')}`
          : undefined,
    })),
)
// What the shown models moved and what it was worth, spent apart from value.
const totals = computed<HswarmMoney>(() => kit.value?.totals ?? {})
const totalsText = computed(() => moneyLine(totals.value, t))
const survivalRows = computed(() =>
  models.value
    .filter((m) => m.survival !== null)
    .sort((a, b) => (b.survival ?? 0) - (a.survival ?? 0))
    .map((m) => ({
      key: m.model,
      label: m.model,
      value: (m.survival ?? 0) * 100,
      detail: t('hswarm.v.overview.results.scored', { n: m.scored }),
    })),
)

// The last `range` local days, the busiest models by name and everything else lumped as "other".
const dailyTop = computed(() => models.value.slice(0, TOP_DAILY).map((m) => m.model))
const daily = computed<DailyDay[]>(() => {
  const byDay = new Map<string, DailyDay>()
  for (const date of localDaysList(range.value)) byDay.set(date, { date, models: {}, other: 0 })
  for (const r of kit.value?.dayModel ?? []) {
    const day = byDay.get(r.date)
    if (!day) continue
    if (dailyTop.value.includes(r.model)) day.models[r.model] = r.calls
    else day.other += r.calls
  }
  return [...byDay.values()]
})
const dayTotal = (d: DailyDay) => Object.values(d.models).reduce((a, b) => a + b, 0) + d.other
const dayMax = computed(() => Math.max(1, ...daily.value.map(dayTotal)))
const colorOf = (name: string) => seriesColor(name, dailyTop.value)
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex items-center justify-between gap-2">
        <CardTitle class="text-base">{{ t('hswarm.v.overview.results.title') }}</CardTitle>
        <div class="flex gap-1">
          <Button
            v-for="n in [14, 30]"
            :key="n"
            size="sm"
            :variant="range === n ? 'default' : 'outline'"
            @click="range = n"
          >{{ t('hswarm.v.overview.results.days', { n }) }}</Button>
        </div>
      </div>
    </CardHeader>
    <CardContent>
      <p v-if="kit && !error && (loading || scoresLoading)" class="pb-2 text-center text-xs text-muted-foreground">{{ t('hswarm.v.overview.loading') }}</p>
      <p v-if="error" class="text-xs text-destructive">{{ t('hswarm.v.overview.results.failed') }} {{ error }}</p>
      <p v-else-if="!kit && loading" class="py-4 text-center text-xs text-muted-foreground">{{ t('hswarm.v.overview.loading') }}</p>
      <div v-else-if="models.length === 0" class="py-4 text-center">
        <div class="text-sm font-medium">{{ t('hswarm.v.overview.results.emptyTitle') }}</div>
        <p class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.emptyBody') }}</p>
      </div>
      <div v-else class="grid items-start gap-4 sm:grid-cols-2">
        <section class="space-y-1.5">
          <h3 class="flex items-center gap-1.5 text-xs font-semibold">
            <ThumbsUp class="size-3.5 text-green-600" /><ThumbsDown class="size-3.5 text-red-600" />
            {{ t('hswarm.v.overview.results.outcomes') }}
          </h3>
          <ul class="space-y-1.5">
            <li v-for="m in models" :key="m.model">
              <div class="flex items-baseline justify-between gap-3 text-xs">
                <span class="min-w-0 truncate text-muted-foreground" :title="m.model">{{ m.model }}</span>
                <span class="shrink-0 tabular-nums font-medium">
                  {{ t('hswarm.v.overview.results.upDown', { ok: m.ok, failed: m.failed }) }} · {{ pct(m.success_rate) }}
                </span>
              </div>
              <div class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div class="flex h-full" :style="{ width: `${Math.max(1.5, (m.tasks / outcomeMax) * 100)}%` }">
                  <div class="h-full bg-green-500" :style="{ width: `${(m.ok / m.tasks) * 100}%` }"></div>
                  <div class="h-full bg-red-500" :style="{ width: `${(m.failed / m.tasks) * 100}%` }"></div>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-semibold">{{ t('hswarm.v.overview.results.tokensPerOk') }}</h3>
          <BarRows v-if="tokenRows.length" :rows="tokenRows" :order="order" :format="tokenFmt" />
          <p v-else class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noOk') }}</p>
          <p v-if="totalsText" class="text-2xs text-muted-foreground">{{ totalsText }}</p>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-semibold">{{ t('hswarm.v.overview.results.survival') }}</h3>
          <BarRows v-if="survivalRows.length" :rows="survivalRows" :order="order" :format="(n) => `${Math.round(n)}%`" />
          <p v-else class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noSurvival') }}</p>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-semibold">{{ t('hswarm.v.overview.results.perDay') }}</h3>
          <div class="flex h-32 items-end gap-0.5">
            <div
              v-for="d in daily"
              :key="d.date"
              class="flex h-full min-w-0 flex-1 flex-col-reverse"
              :title="`${d.date}: ${dayTotal(d)}`"
            >
              <div class="flex flex-col-reverse" :style="{ height: `${(dayTotal(d) / dayMax) * 100}%` }">
                <div
                  v-for="name in dailyTop"
                  :key="name"
                  :style="{ flexGrow: d.models[name] || 0, background: colorOf(name) }"
                ></div>
                <div class="bg-muted-foreground/40" :style="{ flexGrow: d.other }"></div>
              </div>
            </div>
          </div>
          <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            <li v-for="name in dailyTop" :key="name" class="flex items-center gap-1">
              <span class="size-2 rounded-sm" :style="{ background: colorOf(name) }"></span>{{ name }}
            </li>
            <li v-if="daily.some((d) => d.other > 0)" class="flex items-center gap-1">
              <span class="size-2 rounded-sm bg-muted-foreground/40"></span>{{ t('hswarm.v.overview.results.other') }}
            </li>
          </ul>
        </section>
      </div>
    </CardContent>
  </Card>
</template>
