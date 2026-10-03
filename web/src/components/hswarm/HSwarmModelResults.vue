<script setup lang="ts">
// "Model results" on the HSwarm overview: which models got a thumbs up or down, what a successful task cost on each,
// whether their edits survived a day, and how many tasks each ran per day. All from one `model-stats` call.
import { ThumbsDown, ThumbsUp } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BarRows from '@/components/charts/BarRows.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { seriesColor } from '@/lib/chart'
import { useHswarmApi } from '@/lib/hswarm-api'

interface ModelRow {
  model: string
  tasks: number
  ok: number
  failed: number
  success_rate: number
  cost_usd: number
  cost_per_ok: number | null
  avg_seconds: number
  tokens: number
  scored: number
  survival: number | null
}

interface Stats {
  days: number
  models: ModelRow[]
  daily: {
    top: string[]
    days: Array<{ date: string; models: Record<string, number>; other: number }>
  }
}

const { t } = useI18n()
const { apiCall } = useHswarmApi()

const range = ref(14)
const stats = ref<Stats | null>(null)
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    stats.value = await apiCall(`model-stats?days=${range.value}`)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(range, load)

const models = computed(() => stats.value?.models ?? [])
const order = computed(() => models.value.map((m) => m.model))
const pct = (n: number) => `${Math.round(n * 100)}%`
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const outcomeMax = computed(() => Math.max(1, ...models.value.map((m) => m.tasks)))
const costRows = computed(() =>
  models.value
    .filter((m) => m.cost_per_ok !== null)
    .sort((a, b) => (a.cost_per_ok ?? 0) - (b.cost_per_ok ?? 0))
    .map((m) => ({ key: m.model, label: m.model, value: m.cost_per_ok ?? 0 })),
)
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

const daily = computed(() => stats.value?.daily.days ?? [])
const dailyTop = computed(() => stats.value?.daily.top ?? [])
const dayTotal = (d: { models: Record<string, number>; other: number }) =>
  Object.values(d.models).reduce((a, b) => a + b, 0) + d.other
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
      <p v-if="error" class="text-xs text-destructive">{{ t('hswarm.v.overview.results.failed') }} {{ error }}</p>
      <p v-else-if="!stats && loading" class="py-4 text-center text-xs text-muted-foreground">{{ t('hswarm.v.overview.loading') }}</p>
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
          <h3 class="text-xs font-semibold">{{ t('hswarm.v.overview.results.costPerOk') }}</h3>
          <BarRows v-if="costRows.length" :rows="costRows" :order="order" :format="usd" />
          <p v-else class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.results.noOk') }}</p>
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
