<script setup lang="ts">
// The HSwarm tab's routing view. Strings: i18n/locales/en/hswarm/routing.ts (t('hswarm.v.routing.<key>')).
// Below HSwarm's own routing it carries AgentHydra's cost routing between API keys and subscriptions
// (HSwarmCostRouting.vue), so the tree's one Routing item holds both.
import { AlertCircle, Route } from '@lucide/vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'
import { formatUsd } from '@/lib/kit'
import HSwarmCostRouting from './HSwarmCostRouting.vue'

const props = defineProps<{ state: HswarmState }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const { apiCall } = useHswarmApi()

const dailyCap = ref(props.state.options?.daily_cap_usd ?? '')
const previewProfile = ref('general')
const previewTools = ref('none')
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
const previewCandidates = ref<any[]>([])
const routingAdvancedOpen = ref(false)

const ROLE_INFO: Record<string, string> = {
  default: 'any task that names no role',
  search: 'looking things up and researching',
  code: 'reading and changing code',
  judge: 'picking the better of several answers, or passing or failing one',
  grader: 'marking how a worker went about its task (its steps, not its answer)',
  summarize: 'shortening long text',
  review: 'reviewing a code change',
  vision: 'reading images',
  refute:
    'trying to disprove a reported problem by reading the code, so false alarms are thrown out',
  doubt: 'a second opinion on finished work, from a different family of models',
}

const enabledModels = props.state.models?.filter((m: any) => m.enabled) || []

async function handleDailyCapChange() {
  try {
    const value = dailyCap.value === '' ? undefined : parseFloat(String(dailyCap.value))
    if ((value ?? null) === (props.state.options?.daily_cap_usd ?? null)) return
    await apiCall('options', {
      method: 'POST',
      body: JSON.stringify({ daily_cap_usd: value }),
    })
    emit('changed')
    toast.success(t('hswarm.v.routing.dailyCapUpdated'))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update daily cap')
  }
}

async function handleRoleChange(role: string, model: string) {
  try {
    await apiCall('roles', {
      method: 'POST',
      body: JSON.stringify({ role, model }),
    })
    emit('changed')
    toast.success(t('hswarm.v.routing.roleUpdated', { role, model }))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update role')
  }
}

async function handleRoutingToggle(checked: boolean) {
  try {
    await apiCall('options', {
      method: 'POST',
      body: JSON.stringify({ routing: checked }),
    })
    emit('changed')
    toast.success(
      checked ? t('hswarm.v.routing.priceRoutingOn') : t('hswarm.v.routing.priceRoutingOff'),
    )
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update routing')
  }
}

// The slider's value while it is being dragged; it is saved once, when the drag settles.
const biasDraft = ref<number | null>(null)

async function handleLoadBiasChange(value: string) {
  try {
    const bias = parseFloat(value)
    await apiCall('options', {
      method: 'POST',
      body: JSON.stringify({ load_bias: bias }),
    })
    emit('changed')
    toast.success(t('hswarm.v.routing.loadBiasSaved'))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update load bias')
  }
}

async function handlePreview() {
  previewLoading.value = true
  previewError.value = null
  try {
    const response = await apiCall('select', {
      method: 'POST',
      body: JSON.stringify({
        profile: previewProfile.value,
        tools: previewTools.value,
      }),
    })
    previewCandidates.value = response.candidates || []
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Failed to preview AUTO'
    previewCandidates.value = []
  } finally {
    previewLoading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 px-5 py-3">
    <!-- Spending Limit -->
    <Card size="sm">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Route class="h-4 w-4" />
          {{ t('hswarm.v.routing.spendingLimit') }}
        </CardTitle>
        <CardDescription>
          {{ t('hswarm.v.routing.spendingLimitDesc') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-col gap-2 max-w-md">
          <div class="space-y-2">
            <Label for="daily-cap">{{ t('hswarm.v.routing.dailyCap') }}</Label>
            <div class="flex gap-2 items-center">
              <span class="text-sm font-medium">$</span>
              <Input
                id="daily-cap"
                v-model="dailyCap"
                type="number"
                inputmode="decimal"
                step="0.01"
                :placeholder="t('hswarm.v.routing.noLimit')"
                @blur="handleDailyCapChange"
                class="flex-1"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              {{ t('hswarm.v.routing.dailyCapHint') }}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Roles Section -->
    <Card size="sm">
      <CardHeader>
        <CardTitle>{{ t('hswarm.v.routing.roles') }}</CardTitle>
        <CardDescription>
          {{
            t('hswarm.v.routing.rolesDesc', {
              onAuto: Object.values(state.roles || {}).filter((v: any) => !v || v === 'auto').length,
              total: Object.keys(state.roles || {}).length,
            })
          }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <details>
        <summary class="cursor-pointer text-sm text-muted-foreground">{{ t('hswarm.v.routing.roles') }}</summary>
        <div class="mt-2 space-y-1">
          <div
            v-for="[roleName, selectedModel] in Object.entries(state.roles || {})"
            :key="roleName"
            class="flex flex-col"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
                <Label :for="`role-${roleName}`" class="font-mono text-sm">
                  {{ roleName }}
                </Label>
                <p v-if="ROLE_INFO[roleName]" class="truncate text-xs text-muted-foreground">
                  {{ ROLE_INFO[roleName] }}
                </p>
              </div>
              <div class="w-48 flex-shrink-0">
                <Select
                  :model-value="(selectedModel as string) || 'auto'"
                  @update:model-value="(value) => handleRoleChange(roleName, String(value))"
                >
                  <SelectTrigger :id="`role-${roleName}`" class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {{ t('hswarm.v.routing.auto') }}
                    </SelectItem>
                    <SelectItem
                      v-for="model in enabledModels"
                      :key="model.name"
                      :value="model.name"
                    >
                      {{ model.label || model.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>
        </details>
      </CardContent>
    </Card>

    <!-- Preview AUTO Section -->
    <Card size="sm">
      <CardHeader>
        <CardTitle>{{ t('hswarm.v.routing.previewAuto') }}</CardTitle>
        <CardDescription>
          {{ t('hswarm.v.routing.previewAutoDesc') }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <div class="grid grid-cols-2 gap-2 max-w-xl">
          <div class="space-y-2">
            <Label for="profile">{{ t('hswarm.v.routing.taskProfile') }}</Label>
            <Select v-model="previewProfile">
              <SelectTrigger id="profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="routine">{{ t('hswarm.v.routing.profileRoutine') }}</SelectItem>
                <SelectItem value="general">{{ t('hswarm.v.routing.profileGeneral') }}</SelectItem>
                <SelectItem value="code">{{ t('hswarm.v.routing.profileCode') }}</SelectItem>
                <SelectItem value="decision">{{ t('hswarm.v.routing.profileDecision') }}</SelectItem>
                <SelectItem value="research">{{ t('hswarm.v.routing.profileResearch') }}</SelectItem>
                <SelectItem value="critical">{{ t('hswarm.v.routing.profileCritical') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-2">
            <Label for="tools">{{ t('hswarm.v.routing.tools') }}</Label>
            <Select v-model="previewTools">
              <SelectTrigger id="tools">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{{ t('hswarm.v.routing.noTools') }}</SelectItem>
                <SelectItem value="read">{{ t('hswarm.v.routing.readTools') }}</SelectItem>
                <SelectItem value="edit">{{ t('hswarm.v.routing.editTools') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button @click="handlePreview" :disabled="previewLoading" class="w-full sm:w-auto">
          {{ t('hswarm.v.routing.preview') }}
        </Button>

        <p class="text-xs text-muted-foreground">
          {{ t('hswarm.v.routing.previewHint') }}
        </p>

        <!-- Preview Results -->
        <div v-if="previewError" class="mt-2">
          <Alert variant="destructive">
            <AlertCircle class="h-4 w-4" />
            <AlertTitle>{{ t('hswarm.v.routing.previewError') }}</AlertTitle>
            <AlertDescription>{{ previewError }}</AlertDescription>
          </Alert>
        </div>

        <div v-else-if="previewCandidates.length > 0" class="mt-2 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b">
                <th class="text-right py-2 px-2">#</th>
                <th class="text-left py-2 px-2">{{ t('hswarm.v.routing.model') }}</th>
                <th class="text-left py-2 px-2">{{ t('hswarm.v.routing.provider') }}</th>
                <th class="text-right py-2 px-2">
                  {{ t('hswarm.v.routing.testCost') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(candidate, idx) in previewCandidates"
                :key="`${candidate.model}-${candidate.provider}`"
                class="border-b hover:bg-muted/50"
              >
                <td class="text-right py-2 px-2 font-mono text-xs">{{ idx + 1 }}</td>
                <td class="text-left py-2 px-2">
                  <span class="font-mono">{{ candidate.model }}</span>
                  <span
                    v-if="candidate.unevidenced"
                    class="text-xs text-muted-foreground ml-2"
                  >
                    {{ t('hswarm.v.routing.backupModel') }}
                  </span>
                </td>
                <td class="text-left py-2 px-2">{{ candidate.provider }}</td>
                <td class="text-right py-2 px-2 font-mono text-xs">
                  {{ formatUsd(candidate.benchmark_cost_usd, { style: 'fine' }) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>

    <!-- Advanced Options -->
    <Card size="sm">
      <Collapsible v-model:open="routingAdvancedOpen">
        <CardHeader>
          <CollapsibleTrigger as-child>
            <button class="w-full text-left hover:bg-muted/50 rounded-lg p-2 -m-2">
              <CardTitle class="flex items-center gap-2">
                {{ t('hswarm.v.routing.advanced') }}
                <span class="ml-auto text-muted-foreground text-sm">
                  {{ routingAdvancedOpen ? t('hswarm.v.routing.collapse') : t('hswarm.v.routing.expand') }}
                </span>
              </CardTitle>
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent class="space-y-2">
            <!-- Price Routing Toggle -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex-1">
                <Label>{{ t('hswarm.v.routing.priceRouting') }}</Label>
                <p class="text-xs text-muted-foreground mt-1">
                  {{ t('hswarm.v.routing.priceRoutingDesc') }}
                </p>
              </div>
              <Switch
                :model-value="!!state.options?.routing"
                @update:model-value="handleRoutingToggle"
              />
            </div>

            <!-- Load Bias -->
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <Label>{{ t('hswarm.v.routing.loadBias') }}</Label>
                <span class="font-mono text-sm">
                  {{ (biasDraft ?? state.options?.load_bias ?? 0).toFixed(1) }}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                :value="state.options?.load_bias ?? 0"
                @input="(e) => (biasDraft = parseFloat((e.target as HTMLInputElement).value))"
                @change="(e) => handleLoadBiasChange((e.target as HTMLInputElement).value).finally(() => (biasDraft = null))"
                class="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
              <p class="text-xs text-muted-foreground">
                {{ t('hswarm.v.routing.loadBiasDesc') }}
              </p>
            </div>

            <!-- Default Concurrency -->
            <div>
              <Label>{{ t('hswarm.v.routing.defaultConcurrency') }}</Label>
              <div class="text-sm font-mono mt-2">
                {{ t('hswarm.v.routing.api') }}
                <span>{{ state.options?.concurrency?.api ?? '–' }}</span>
                {{ t('hswarm.v.routing.cc') }}
                <span>{{ state.options?.concurrency?.cc ?? '–' }}</span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                {{
                  t('hswarm.v.routing.defaultConcurrencyDesc', {
                    maxApi: state.options?.max_concurrency?.api ?? '–',
                    maxCc: state.options?.max_concurrency?.cc ?? '–',
                  })
                }}
              </p>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>

    <HSwarmCostRouting class="mt-1 border-t pt-3" />
  </div>
</template>
