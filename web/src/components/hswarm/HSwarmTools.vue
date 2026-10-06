<script setup lang="ts">
// The HSwarm tab's tools view. Strings: i18n/locales/en/hswarm/tools.ts (t('hswarm.v.tools.<key>')).
import { AlertCircle, Check, Loader2, Play, RotateCcw, X } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'

interface DoctorResponse {
  error?: string
  data?: Record<string, any>
  running?: boolean
}

interface AskResponse {
  error?: string
  answer?: string
  model?: string
  seconds?: number
  cost_usd?: number
  running?: boolean
}

const props = defineProps<{ state: HswarmState }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { apiCall } = useHswarmApi()

const activeTab = ref<'ask' | 'doctor' | 'help'>('ask')
const askPrompt = ref('')
const askModel = ref('auto')
const askLoading = ref(false)
const askResult = ref<AskResponse | null>(null)

const doctorLoading = ref(false)
const doctorResult = ref<DoctorResponse | null>(null)

const models = computed(() => {
  if (!props.state?.models) return []
  return props.state.models.filter((m: any) => m.enabled)
})

const readyProviders = computed(() => {
  if (!props.state?.providers) return new Set()
  return new Set(
    props.state.providers
      .filter((p: any) => p.enabled && (p.ready ?? 0) > 0)
      .map((p: any) => p.name),
  )
})

const hasReadyKey = computed(() => readyProviders.value.size > 0)

const freeProviders = computed(() => {
  if (!props.state?.providers) return []
  return props.state.providers.filter((p: any) => p.free_tier && p.key_url)
})

async function handleAsk() {
  const prompt = askPrompt.value.trim()
  if (!prompt) {
    toast.error(t('hswarm.v.tools.askEmpty'))
    return
  }

  if (!hasReadyKey.value) {
    toast.error(t('hswarm.v.tools.noReadyKey'))
    return
  }

  askLoading.value = true
  askResult.value = { running: true }
  try {
    const result = await apiCall('ask', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model: askModel.value,
      }),
    })
    askResult.value = result
    toast.success(t('hswarm.v.tools.askSuccess'))
  } catch (err) {
    const message = err instanceof Error ? err.message : t('hswarm.v.tools.askFailed')
    askResult.value = { error: message }
    toast.error(message)
  } finally {
    askLoading.value = false
  }
}

async function handleDoctor() {
  doctorLoading.value = true
  doctorResult.value = { running: true }
  try {
    const result = await apiCall('doctor', {
      method: 'GET',
    })
    doctorResult.value = { data: result }
    toast.success(t('hswarm.v.tools.doctorSuccess'))
  } catch (err) {
    const message = err instanceof Error ? err.message : t('hswarm.v.tools.doctorFailed')
    doctorResult.value = { error: message }
    toast.error(message)
  } finally {
    doctorLoading.value = false
  }
}

function clearAskResult() {
  askResult.value = null
  askPrompt.value = ''
}

const doctorChecks = computed(() => {
  if (!doctorResult.value?.data) return []
  const data = doctorResult.value.data
  const checks: Array<[boolean, string, string]> = []

  const isMissing = (v: any) => typeof v === 'string' && /^(MISSING|ERROR|UNREADABLE)/.test(v)

  const add = (ok: boolean, title: string, value: any) => {
    checks.push([ok, title, typeof value === 'string' ? value : JSON.stringify(value)])
  }

  // Check standard components
  for (const [k, title] of [
    ['claude_bin', t('hswarm.v.tools.doctorClaudeBin')],
    ['rg', t('hswarm.v.tools.doctorRipgrep')],
    ['bash', t('hswarm.v.tools.doctorBash')],
    ['config', t('hswarm.v.tools.doctorConfig')],
  ] as const) {
    if (data[k] != null) {
      add(!isMissing(data[k]), title, data[k])
    }
  }

  // Check routes
  if (data.routes_now) {
    add(
      !data.routes_warning,
      t('hswarm.v.tools.doctorRoutes'),
      data.routes_warning || t('hswarm.v.tools.doctorRoutesOk'),
    )
  }

  // Check providers
  if (data.providers) {
    for (const [name, status] of Object.entries(data.providers)) {
      if (status && typeof status === 'object' && 'reachable' in status) {
        const st = status as any
        add(!isMissing(st.reachable), `Provider ${name}`, st.reachable)
      }
    }
  }

  // Check keys
  if (data.keys_note) {
    add(!(data.keys_out_of_balance || []).length, t('hswarm.v.tools.doctorKeys'), data.keys_note)
  }

  // Check API
  if (data.api_error) {
    add(false, t('hswarm.v.tools.doctorApi'), data.api_error)
  }

  // Check faults
  if (data.faults_armed) {
    add(false, t('hswarm.v.tools.doctorFaults'), data.faults_armed)
  }

  return checks
})

onMounted(() => {
  // Initial doctor check could be run here, but we'll let the user trigger it
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Tab navigation -->
    <div class="flex gap-1 border-b">
      <Button
        variant="ghost"
        size="sm"
        :class="{ 'border-b-2 border-primary': activeTab === 'ask' }"
        @click="activeTab = 'ask'"
      >
        {{ t('hswarm.v.tools.tabAsk') }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :class="{ 'border-b-2 border-primary': activeTab === 'doctor' }"
        @click="activeTab = 'doctor'"
      >
        {{ t('hswarm.v.tools.tabDoctor') }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :class="{ 'border-b-2 border-primary': activeTab === 'help' }"
        @click="activeTab = 'help'"
      >
        {{ t('hswarm.v.tools.tabHelp') }}
      </Button>
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-auto p-4">
      <!-- ASK view -->
      <div v-if="activeTab === 'ask'" class="space-y-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.askTitle') }}</CardTitle>
            <CardDescription>{{ t('hswarm.v.tools.askDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <div class="space-y-2">
              <Label for="ask-prompt">{{ t('hswarm.v.tools.askPromptLabel') }}</Label>
              <Textarea
                id="ask-prompt"
                v-model="askPrompt"
                :placeholder="t('hswarm.v.tools.askPromptPlaceholder')"
                :disabled="askLoading"
                class="min-h-24"
              />
            </div>

            <div class="space-y-2">
              <Label for="ask-model">{{ t('hswarm.v.tools.askModelLabel') }}</Label>
              <Select v-model="askModel" :disabled="askLoading">
                <SelectTrigger id="ask-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {{ t('hswarm.v.tools.askModelAuto') }}
                  </SelectItem>
                  <SelectItem v-for="model in models" :key="model.name" :value="model.name">
                    {{ model.label || model.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="flex gap-2">
              <Button
                :disabled="!hasReadyKey || askLoading"
                @click="handleAsk"
                class="gap-2"
              >
                <Play v-if="!askLoading" class="size-4" />
                <Loader2 v-else class="size-4 animate-spin" />
                {{ askLoading ? t('hswarm.v.tools.askAsking') : t('hswarm.v.tools.askButton') }}
              </Button>
              <Button
                v-if="askResult && !askLoading"
                variant="outline"
                size="icon"
                @click="clearAskResult"
              >
                <X class="size-4" />
              </Button>
            </div>

            <div v-if="!hasReadyKey" class="flex gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle class="size-4 shrink-0 mt-0.5" />
              <span>{{ t('hswarm.v.tools.noReadyKey') }}</span>
            </div>
          </CardContent>
        </Card>

        <!-- Ask result -->
        <Card size="sm" v-if="askResult && !askLoading" :class="{ 'border-red-200 bg-red-50': askResult.error && !askResult.answer }">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <span v-if="askResult.error && !askResult.answer" class="text-red-600">
                {{ t('hswarm.v.tools.askError') }}
              </span>
              <span v-else class="text-green-600 flex items-center gap-1">
                <Check class="size-4" />
                {{ t('hswarm.v.tools.askAnswered') }}
              </span>
            </CardTitle>
            <CardDescription v-if="askResult.model || askResult.seconds || askResult.cost_usd">
              {{ askResult.model || t('hswarm.v.tools.askSwarm') }} {{ t('hswarm.v.tools.separator') }} {{ askResult.seconds }}{{ t('hswarm.v.tools.seconds') }} {{ t('hswarm.v.tools.separator') }}
              {{ askResult.cost_usd != null ? `$${askResult.cost_usd.toFixed(6)}` : t('hswarm.v.tools.free') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre class="max-h-96 overflow-auto rounded-md bg-slate-100 p-3 text-sm">{{ askResult.answer || askResult.error || JSON.stringify(askResult, null, 2) }}</pre>
          </CardContent>
        </Card>
      </div>

      <!-- DOCTOR view -->
      <div v-if="activeTab === 'doctor'" class="space-y-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.doctorTitle') }}</CardTitle>
            <CardDescription>{{ t('hswarm.v.tools.doctorDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              :disabled="doctorLoading"
              @click="handleDoctor"
              class="gap-2"
            >
              <RotateCcw v-if="!doctorLoading" class="size-4" />
              <Loader2 v-else class="size-4 animate-spin" />
              {{ doctorLoading ? t('hswarm.v.tools.doctorChecking') : t('hswarm.v.tools.doctorButton') }}
            </Button>
          </CardContent>
        </Card>

        <!-- Doctor result -->
        <div v-if="doctorResult && !doctorLoading" class="space-y-2">
          <div v-if="doctorResult.error" class="rounded-md border border-red-200 bg-red-50 p-4">
            <div class="flex gap-2">
              <AlertCircle class="size-5 text-red-600 shrink-0" />
              <div>
                <div class="font-semibold text-red-600">{{ t('hswarm.v.tools.doctorFailed') }}</div>
                <div class="text-sm text-red-600">{{ doctorResult.error }}</div>
              </div>
            </div>
          </div>

          <div v-else class="space-y-2">
            <div v-for="([ok, title, value], idx) in doctorChecks" :key="idx" class="flex gap-3 rounded-md border p-3">
              <div class="shrink-0 mt-0.5">
                <Check v-if="ok" class="size-5 text-green-600" />
                <AlertCircle v-else class="size-5 text-amber-600" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-semibold text-sm">{{ title }}</div>
                <div class="text-xs text-muted-foreground font-mono break-all">{{ value }}</div>
              </div>
            </div>

            <details v-if="doctorResult.data" class="pt-2 border-t mt-2">
              <summary class="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                {{ t('hswarm.v.tools.doctorFullReport') }}
              </summary>
              <pre class="max-h-96 overflow-auto rounded-md bg-slate-100 p-3 text-xs mt-2">{{ JSON.stringify(doctorResult.data, null, 2) }}</pre>
            </details>
          </div>
        </div>
      </div>

      <!-- HELP view -->
      <div v-if="activeTab === 'help'" class="space-y-2 max-w-2xl">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpWhatIsHswarm.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpWhatIsHswarm.body1') }}</p>
            <p>{{ t('hswarm.v.tools.helpWhatIsHswarm.body2') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpApiKey.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpApiKey.body') }}</p>
            <div v-if="freeProviders.length" class="bg-blue-50 border border-blue-200 rounded p-3">
              <p class="text-sm font-semibold">{{ t('hswarm.v.tools.helpApiKey.freeTiers') }}</p>
              <ul class="text-sm list-disc list-inside">
                <li v-for="p in freeProviders" :key="p.name" class="text-blue-900">
                  {{ p.name }}
                  <a v-if="p.key_url" :href="p.key_url" target="_blank" rel="noopener noreferrer"
                    class="underline">({{ t('hswarm.v.tools.helpApiKey.getKey') }})</a>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpFreeTier.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpFreeTier.body') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpToken.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpToken.body1') }}</p>
            <p>{{ t('hswarm.v.tools.helpToken.body2') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpWhichModel.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpWhichModel.body') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpRoles.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpRoles.body') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpConnect.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpConnect.body') }}</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.tools.helpQuestion.title') }}</CardTitle>
          </CardHeader>
          <CardContent class="prose prose-sm max-w-none">
            <p>{{ t('hswarm.v.tools.helpQuestion.body') }}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
