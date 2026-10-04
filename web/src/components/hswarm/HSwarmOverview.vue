<script setup lang="ts">
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Play,
  Stethoscope,
  TrendingUp,
  Zap,
} from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AreaLine from '@/components/charts/AreaLine.vue'
import BarRows from '@/components/charts/BarRows.vue'
import HSwarmModelResults from '@/components/hswarm/HSwarmModelResults.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { HswarmMoney, HswarmState } from '@/lib/hswarm-api'
import { moneyLine, useHswarmApi } from '@/lib/hswarm-api'
import { fetchKitUsage, formatTokens, formatUsd, localDaysFrom, localTz } from '@/lib/kit'

/** One day of HSwarm's work, read from the toolkit (`source=hswarm`, groupBy day). */
interface UsageDay {
  date: string
  tokens: number
  cost: number
  tasks: number
  ok: number
  error: number
}

/** Per provider over the same window: tokens first, the list-price value beside them. */
interface UsageProvider {
  name: string
  tokens: number
  usd: number
}

interface UsageData {
  days: UsageDay[]
  providers: UsageProvider[]
  totals: Record<string, number | null>
  error?: string
}

interface DoctorResult {
  running?: boolean
  error?: string
  data?: Record<string, any>
}

interface Client {
  client: string
  registered?: boolean
}

interface AskResult {
  running?: boolean
  model?: string
  seconds?: number
  cost_usd?: number
  error?: string
  answer?: string
}

const props = defineProps<{ state: HswarmState }>()
defineEmits<{ changed: [] }>()

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// API data
const usage = ref<UsageData | null>(null)
const clients = ref<Client[] | null>(null)
const doctor = ref<DoctorResult | null>(null)
const ask = ref<AskResult | null>(null)

const askPrompt = ref('')
const askModel = ref('auto')
const askRunning = ref(false)

// Load additional data
const USAGE_DAYS = 14

// The spend by day and by provider, and the task counts, are the toolkit's answers for HSwarm's own calls.
async function loadUsage() {
  const base = {
    source: 'hswarm',
    from: localDaysFrom(USAGE_DAYS),
    tz: localTz(),
    measures: ['tokens', 'cache_read', 'list_usd', 'billed_usd', 'calls', 'ok', 'failed'],
  }
  try {
    const [byDay, byProvider] = await Promise.all([
      fetchKitUsage({ ...base, groupBy: 'day' }),
      fetchKitUsage({ ...base, groupBy: 'provider' }),
    ])
    usage.value = {
      days: byDay.rows.map((r) => ({
        date: String(r.day),
        tokens: Number(r.tokens),
        cost: Number(r.list_usd ?? 0),
        tasks: Number(r.calls),
        ok: Number(r.ok),
        error: Number(r.failed),
      })),
      providers: byProvider.rows
        .map((r) => ({
          name: r.provider === null ? 'other' : String(r.provider),
          tokens: Number(r.tokens),
          usd: Number(r.list_usd ?? 0),
        }))
        .sort((a, b) => b.tokens - a.tokens),
      totals: byDay.totals,
    }
  } catch (err) {
    console.error('Failed to load usage:', err)
  }
}

async function loadClients() {
  try {
    const data = await apiCall('clients')
    clients.value = data.clients || []
  } catch (err) {
    console.error('Failed to load clients:', err)
  }
}

// Computed values
const liveProviders = computed(() => {
  const enabled = props.state.providers?.filter((p: any) => p.enabled && p.ready > 0) || []
  return enabled.length
})

const readyKeys = computed(() => {
  return (
    props.state.providers?.reduce((sum: number, p: any) => sum + (p.enabled ? p.ready : 0), 0) || 0
  )
})

const totalKeys = computed(() => {
  return props.state.providers?.reduce((sum: number, p: any) => sum + (p.keys || 0), 0) || 0
})

const restingKeys = computed(() => {
  return (
    props.state.providers?.reduce(
      (sum: number, p: any) => sum + (p.enabled ? p.resting || 0 : 0),
      0,
    ) || 0
  )
})

const starredModels = computed(() => {
  return Object.keys(props.state.priority || {}).length || 0
})

const readyProviders = computed(() => {
  const ready = props.state.providers?.filter((p: any) => p.enabled && p.ready > 0) || []
  return new Set(ready.map((p: any) => p.name))
})

const autoModels = computed(() => {
  const ready = readyProviders.value
  return (
    props.state.models?.filter((m: any) => m.auto && m.enabled && ready.has(m.provider)).length || 0
  )
})

const totalTokens = computed(() => usage.value?.totals.tokens ?? 0)

const totalCachedTokens = computed(() => usage.value?.totals.cache_read ?? 0)

// The money under the token headline: list-price value of every call, and the part known to be billed. A window whose
// calls carry no billing flag (written before the ledger recorded it) reads null here and counts as unknown, not spent.
const money = computed<HswarmMoney>(() => {
  const t = usage.value?.totals
  const value = t?.list_usd ?? 0
  const spent = t?.billed_usd ?? null
  return { value_usd: value, spent_usd: spent ?? 0, unknown_usd: spent === null ? value : 0 }
})
const moneyText = computed(() => moneyLine(money.value, t))

const totalTasks = computed(() => usage.value?.totals.calls ?? 0)

const registeredClient = computed(() => {
  return clients.value?.some((c: any) => c.registered) || false
})

// Checklist steps
const steps = computed(() => [
  {
    done: liveProviders.value > 0,
    title: t('hswarm.v.overview.addKey'),
    description: t('hswarm.v.overview.addKeyDesc'),
    action: 'providers',
  },
  {
    done: autoModels.value > 0,
    title: t('hswarm.v.overview.selectModels'),
    description: t('hswarm.v.overview.selectModelsDesc'),
    action: 'models',
  },
  {
    done: registeredClient.value,
    title: t('hswarm.v.overview.connectAssistant'),
    description: t('hswarm.v.overview.connectAssistantDesc'),
    action: 'clients',
  },
])

const checklist = computed(() => {
  const nextIncomplete = steps.value.findIndex((s) => s.done === false)
  return { nextIncomplete, allDone: steps.value.every((s) => s.done) }
})

const isFresh = computed(() => {
  const noKeys = totalKeys.value === 0
  if (!usage.value) return noKeys
  const noTasks = totalTasks.value === 0
  return noKeys && noTasks
})

// Chart data
const spendDays = computed(() => usage.value?.days ?? [])

const spendChartData = computed(() => {
  return spendDays.value.map((d) => ({
    at: new Date(d.date).getTime(),
    value: d.tokens,
  }))
})

const outcomeChartData = computed(() => {
  const data = spendDays.value.map((d) => {
    const total = d.ok + d.error
    return {
      at: new Date(d.date).getTime(),
      value: total > 0 ? (d.error / total) * 100 : 0,
    }
  })
  return data
})

const healthData = computed(() => {
  const providers = (props.state.providers || [])
    .filter((p: any) => p.keys > 0)
    .sort((a: any, b: any) => (b.keys || 0) - (a.keys || 0) || a.name.localeCompare(b.name))

  return providers.map((p: any) => ({
    key: p.name,
    label: `${p.name}${p.enabled ? '' : ' (off)'}`,
    value: p.ready || 0,
    detail: `${p.ready || 0}/${p.keys || 0} ready`,
  }))
})

const moneyData = computed(() => {
  const list = (usage.value?.providers ?? []).filter((p) => p.tokens > 0)
  const row = (name: string, value: number, usd: number) => ({
    key: name,
    label: `${name} · ${fineUsd(usd)}`,
    value,
    detail: fineUsd(usd),
  })
  if (list.length <= 8) return list.map((p) => row(p.name, p.tokens, p.usd))

  const rest = list.slice(7)
  return [
    ...list.slice(0, 7).map((p) => row(p.name, p.tokens, p.usd)),
    row(
      t('hswarm.v.overview.otherProviders', { n: rest.length }),
      rest.reduce((sum, p) => sum + p.tokens, 0),
      rest.reduce((sum, p) => sum + p.usd, 0),
    ),
  ]
})

// Doctor run
async function runDoctor() {
  if (doctor.value?.running) return
  doctor.value = { running: true }
  try {
    const result = await apiCall('doctor')
    doctor.value = result
  } catch (err) {
    doctor.value = { error: err instanceof Error ? err.message : 'Failed to run doctor' }
  }
}

// Probe balances
async function probeBalances() {
  try {
    await apiCall('keys/probe', { method: 'POST' })
  } catch (err) {
    console.error('Failed to probe balances:', err)
  }
}

// Ask
async function submitAsk() {
  if (!askPrompt.value || askRunning.value) return
  askRunning.value = true
  try {
    const result = await apiCall('ask', {
      method: 'POST',
      body: JSON.stringify({ prompt: askPrompt.value, model: askModel.value }),
    })
    ask.value = result
  } catch (err) {
    ask.value = { error: err instanceof Error ? err.message : 'Failed to ask' }
  } finally {
    askRunning.value = false
  }
}

// Load data on mount
onMounted(async () => {
  await loadUsage()
  await loadClients()
})

// Money and tokens: the kit's formatters (lib/kit.ts).
const fineUsd = (value: number) => formatUsd(value, { style: 'fine' })

// Format compact number
function formatNumber(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1000000) return `${(value / 1000).toFixed(1)}K`
  return `${(value / 1000000).toFixed(1)}M`
}

// Format percentage
function formatPercent(value: number): string {
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`
}
</script>

<template>
  <div class="space-y-2 px-5 py-3">
    <!-- Lead text -->
    <div v-if="isFresh" class="text-sm text-muted-foreground max-w-2xl">
      {{ t('hswarm.v.overview.freshLead') }}
    </div>
    <div v-else class="text-sm text-muted-foreground max-w-2xl">
      {{ t('hswarm.v.overview.lead') }}
    </div>

    <!-- Stat tiles: a small inline icon and one-line label, the figure, one line of context (as the console's) -->
    <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Activity class="size-3.5 shrink-0" />
          <span class="truncate">{{ t('hswarm.v.overview.liveProviders') }}</span>
        </div>
        <div class="whitespace-nowrap text-2xl font-semibold leading-8">
          {{ liveProviders }}<span class="ms-1.5 text-sm font-medium text-muted-foreground">{{ t('hswarm.v.overview.of') }} {{ state.providers?.length || 0 }}</span>
        </div>
        <p class="truncate text-xs text-muted-foreground">
          {{ liveProviders > 0 ? t('hswarm.v.overview.withReadyKey') : t('hswarm.v.overview.noReadyKey') }}
        </p>
      </div>

      <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 class="size-3.5 shrink-0" />
          <span class="truncate">{{ t('hswarm.v.overview.readyKeys') }}</span>
        </div>
        <div class="whitespace-nowrap text-2xl font-semibold leading-8">
          {{ formatNumber(readyKeys) }}<span class="ms-1.5 text-sm font-medium text-muted-foreground">{{ t('hswarm.v.overview.of') }} {{ formatNumber(totalKeys) }}</span>
        </div>
        <p class="truncate text-xs text-muted-foreground">
          {{ restingKeys > 0 ? `${restingKeys} ${t('hswarm.v.overview.resting')}` : totalKeys > 0 ? t('hswarm.v.overview.allUsable') : t('hswarm.v.overview.noKeysYet') }}
        </p>
      </div>

      <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Zap class="size-3.5 shrink-0" />
          <span class="truncate">{{ t('hswarm.v.overview.starredModels') }}</span>
        </div>
        <div class="whitespace-nowrap text-2xl font-semibold leading-8">{{ starredModels }}</div>
        <p class="truncate text-xs text-muted-foreground">
          {{ autoModels }} {{ t('hswarm.v.overview.auto') }} {{ autoModels === 1 ? t('hswarm.v.overview.model') : t('hswarm.v.overview.models') }} {{ t('hswarm.v.overview.usableNow') }}
        </p>
      </div>

      <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TrendingUp class="size-3.5 shrink-0" />
          <span class="truncate">{{ t('hswarm.v.overview.spend14Days') }}</span>
        </div>
        <div class="whitespace-nowrap text-2xl font-semibold leading-8">{{ formatTokens(totalTokens) }}</div>
        <p class="truncate text-xs text-muted-foreground">
          {{ moneyText ? `${moneyText} ${t('hswarm.v.overview.separator')} ` : '' }}{{ totalTasks > 0 ? `${formatNumber(totalTasks)} ${totalTasks === 1 ? t('hswarm.v.overview.task') : t('hswarm.v.overview.tasks')}` : usage?.error ? t('hswarm.v.overview.loadFailed') : usage ? t('hswarm.v.overview.nothingRun') : t('hswarm.v.overview.loading') }}
        </p>
      </div>
    </div>

    <!-- Getting started checklist -->
    <div v-if="!checklist.allDone" class="space-y-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle class="text-base">{{ t('hswarm.v.overview.gettingStarted') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <div v-for="(step, idx) in steps" :key="idx" class="flex items-start gap-2 border-b pb-1.5 last:border-b-0 last:pb-0">
            <div class="mt-0.5 shrink-0">
              <div v-if="step.done" class="flex size-5 items-center justify-center rounded-full bg-green-100 text-green-600">
                <CheckCircle2 class="size-3.5" />
              </div>
              <div v-else-if="idx === checklist.nextIncomplete" class="flex size-5 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                <AlertCircle class="size-3.5" />
              </div>
              <div v-else class="flex size-5 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                •
              </div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium">{{ step.title }}</div>
              <p class="text-xs text-muted-foreground">{{ step.description }}</p>
            </div>
            <Button
              v-if="idx <= checklist.nextIncomplete"
              class="shrink-0"
              size="sm"
              :variant="idx === checklist.nextIncomplete ? 'default' : 'outline'"
              @click="$emit('changed')"
            >
              {{ idx === 0 ? t('hswarm.v.overview.action0') : idx === 1 ? t('hswarm.v.overview.action1') : t('hswarm.v.overview.action2') }}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Charts section -->
    <div v-if="!isFresh && usage?.days && usage.days.length > 0" class="grid items-start gap-2 sm:grid-cols-2">
      <!-- Spend chart -->
      <Card size="sm">
        <CardHeader>
          <CardTitle class="text-base">{{ t('hswarm.v.overview.spendChart') }}</CardTitle>
          <p class="text-sm text-muted-foreground mt-2">
            <strong>{{ formatTokens(totalTokens) }}</strong> {{ t('hswarm.v.overview.tokensIn14Days') }}
            <span v-if="totalCachedTokens > 0">{{ t('hswarm.v.overview.separator') }} {{ formatTokens(totalCachedTokens) }} {{ t('hswarm.v.overview.cachedInput') }}</span>
            <span v-if="moneyText">{{ t('hswarm.v.overview.separator') }} {{ moneyText }}</span>
            <span v-if="totalTasks > 0">{{ t('hswarm.v.overview.separator') }} {{ formatNumber(totalTasks) }} {{ totalTasks === 1 ? t('hswarm.v.overview.task') : t('hswarm.v.overview.tasks') }}</span>
          </p>
        </CardHeader>
        <CardContent>
          <div v-if="totalTokens <= 0" class="py-4 text-center">
            <div class="text-sm font-medium">{{ t('hswarm.v.overview.noSpendTitle') }}</div>
            <p class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.noSpendBody') }}</p>
          </div>
          <AreaLine
            v-else
            :points="spendChartData"
            :format="formatTokens"
            :axis-format="formatTokens"
            :label-at="(ms) => new Date(ms).toLocaleDateString()"
            value-label="Tokens"
            change-label="Daily"
            peak-label="Peak"
          />
          <details v-if="totalTokens > 0" class="mt-1 rounded-lg border">
            <summary class="cursor-pointer px-2 py-1 text-xs text-muted-foreground">{{ t('hswarm.v.overview.showNumbers') }}</summary>
            <div>
            <table class="w-full text-sm">
              <thead class="bg-muted">
                <tr>
                  <th class="px-2 py-1 text-left font-medium">{{ t('hswarm.v.overview.day') }}</th>
                  <th class="px-2 py-1 text-right font-medium">{{ t('hswarm.v.overview.tokens') }}</th>
                  <th class="px-2 py-1 text-right font-medium">{{ t('hswarm.v.overview.cost') }}</th>
                  <th class="px-2 py-1 text-right font-medium">{{ t('hswarm.v.overview.tasks') }}</th>
                  <th class="px-2 py-1 text-right font-medium">{{ t('hswarm.v.overview.errors') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in [...spendDays].reverse()" :key="d.date" class="border-t hover:bg-muted/50">
                  <td class="px-2 py-1">{{ d.date }}</td>
                  <td class="px-2 py-1 text-right">{{ formatTokens(d.tokens) }}</td>
                  <td class="px-2 py-1 text-right">{{ fineUsd(d.cost) }}</td>
                  <td class="px-2 py-1 text-right">{{ d.tasks }}</td>
                  <td class="px-2 py-1 text-right">{{ d.error }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </details>
        </CardContent>
      </Card>

      <!-- Outcomes chart -->
      <Card size="sm">
        <CardHeader>
          <CardTitle class="text-base">{{ t('hswarm.v.overview.outcomeChart') }}</CardTitle>
          <p class="text-sm text-muted-foreground mt-2">
            {{ t('hswarm.v.overview.taskFailureRate') }}
          </p>
        </CardHeader>
        <CardContent>
          <div v-if="totalTasks <= 0" class="py-4 text-center">
            <div class="text-sm font-medium">{{ t('hswarm.v.overview.noTasksTitle') }}</div>
            <p class="text-xs text-muted-foreground">{{ t('hswarm.v.overview.noTasksBody') }}</p>
          </div>
          <AreaLine
            v-else
            :points="outcomeChartData"
            :format="(n: number) => `${Math.round(n)}%`"
            :label-at="(ms) => new Date(ms).toLocaleDateString()"
            :value-label="t('hswarm.v.overview.errors')"
            change-label="Daily"
            peak-label="Peak"
          />
        </CardContent>
      </Card>

      <!-- Provider health chart -->
      <Card size="sm" v-if="healthData.length > 0">
        <CardHeader>
          <CardTitle class="text-base">{{ t('hswarm.v.overview.keyHealth') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <BarRows
            :rows="healthData"
            :format="formatNumber"
          />
        </CardContent>
      </Card>

      <!-- Money by provider chart -->
      <Card size="sm" v-if="moneyData.length > 0">
        <CardHeader>
          <CardTitle class="text-base">{{ t('hswarm.v.overview.moneyChart') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <BarRows
            :rows="moneyData"
            :format="formatTokens"
          />
        </CardContent>
      </Card>
    </div>

    <!-- Charts empty state -->
    <div v-else-if="!isFresh && (!usage?.days || usage.days.length === 0)" class="text-center py-4">
      <p class="text-sm text-muted-foreground">
        {{ t('hswarm.v.overview.chartsEmpty') }}
      </p>
    </div>

    <HSwarmModelResults />

    <!-- Health section -->
    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-base">{{ t('hswarm.v.overview.health') }}</CardTitle>
      </CardHeader>
      <CardContent class="space-y-2">
        <!-- Doctor -->
        <div class="space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="font-medium text-sm flex items-center gap-2">
                <Stethoscope class="h-4 w-4" />
                {{ t('hswarm.v.overview.doctor') }}
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                {{ t('hswarm.v.overview.doctorDesc') }}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              :disabled="doctor?.running"
              @click="runDoctor"
            >
              {{ doctor?.running ? t('hswarm.v.overview.running') : t('hswarm.v.overview.runDoctor') }}
            </Button>
          </div>
          <div v-if="doctor?.error" class="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <p class="text-xs text-destructive">{{ doctor.error }}</p>
          </div>
          <div v-if="doctor?.data" class="rounded-lg border bg-muted p-3">
            <pre class="text-xs overflow-auto max-h-40">{{ JSON.stringify(doctor.data, null, 2) }}</pre>
          </div>
        </div>

        <Separator />

        <!-- Balances -->
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="font-medium text-sm flex items-center gap-2">
              <Clock class="h-4 w-4" />
              {{ t('hswarm.v.overview.balances') }}
            </div>
            <p class="text-xs text-muted-foreground mt-1">
              {{ t('hswarm.v.overview.balancesDesc') }}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            @click="probeBalances"
          >
            {{ t('hswarm.v.overview.probeBalances') }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- Quick ask section -->
    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-base">{{ t('hswarm.v.overview.quickAsk') }}</CardTitle>
      </CardHeader>
      <CardContent class="space-y-2">
        <textarea
          v-model="askPrompt"
          :placeholder="t('hswarm.v.overview.askPlaceholder')"
          class="w-full min-h-20 px-3 py-2 border rounded-lg bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <div class="flex gap-3 items-start">
          <select
            v-model="askModel"
            class="px-3 py-2 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="auto">{{ t('hswarm.v.overview.autoCheapest') }}</option>
            <optgroup v-for="provider in state.providers" :key="provider.name" :label="provider.name">
              <option
                v-for="model in state.models?.filter((m: any) => m.provider === provider.name && m.enabled)"
                :key="model.name"
                :value="model.name"
              >
                {{ model.label || model.name }}
              </option>
            </optgroup>
          </select>
          <Button
            :disabled="!askPrompt || askRunning || readyKeys === 0"
            @click="submitAsk"
          >
            <Play class="h-4 w-4 me-1" />
            {{ t('hswarm.v.overview.ask') }}
          </Button>
        </div>
        <div v-if="readyKeys === 0" class="text-xs text-muted-foreground">
          {{ t('hswarm.v.overview.noReadyKey') }}
        </div>
        <div v-if="ask && !ask.running" class="rounded-lg border bg-muted p-3">
          <div v-if="ask.error && !ask.answer" class="text-xs text-destructive mb-2">
            {{ t('hswarm.v.overview.noAnswer') }}
          </div>
          <pre class="text-xs overflow-auto max-h-40" :class="ask.error && !ask.answer ? 'text-destructive' : ''">{{ ask.answer || ask.error || JSON.stringify(ask, null, 2) }}</pre>
          <div v-if="ask.model" class="text-xs text-muted-foreground mt-2">
            {{ ask.model }} {{ t('hswarm.v.overview.separator') }} {{ ask.seconds }}{{ t('hswarm.v.overview.timeUnit') }} {{ t('hswarm.v.overview.separator') }} {{ fineUsd(ask.cost_usd || 0) }}
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
