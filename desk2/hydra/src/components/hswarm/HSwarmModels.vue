<script setup lang="ts">
// The HSwarm tab's models view. Strings: i18n/locales/en/hswarm/models.ts (t('hswarm.v.models.<key>')).

import { AlertCircle, Plus, Star } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'

interface Model {
  name: string
  label?: string
  provider: string
  enabled: boolean
  switched_off?: boolean
  priority?: number | null
  auto?: boolean
  kind?: string
  usd_per_1m?: number | null
  ctx?: number | null
  vision?: boolean
  tools?: boolean | null
  custom?: boolean
  fallback?: boolean
  api_id?: string
  score?: number
  bench_cost_usd?: number
  inherits?: string
  effort?: string
}

// provider + model: set when the HSwarm tree picked one model; the page shows exactly that one.
// adding: set by the tree's "Add model" button.
const props = defineProps<{
  state: HswarmState
  provider?: string
  model?: string
  adding?: boolean
}>()
// open: show one object in the HSwarm tree (a model just added), as path segments.
const emit = defineEmits<{ changed: []; open: [path: string[]] }>()
const { t } = useI18n()
const { apiCall } = useHswarmApi()

const searchQuery = ref('')
const withKeysOnly = ref(false)
const autoRankedOnly = ref(false)
const orderBy = ref<'star' | 'name'>('star')
const busyModels = new Set<string>()
// As the console: a long table shows its first rows and a button for the rest.
const FOLD = 5
const showAll = ref(false)

const readyProviders = computed(() => {
  if (!props.state?.providers) return new Set()
  return new Set(
    props.state.providers
      .filter((p: any) => p.enabled && (p.ready ?? 0) > 0)
      .map((p: any) => p.name),
  )
})

const allModels = computed(() => props.state?.models ?? [])

// The table follows the box once typing pauses, not on every keystroke.
const SEARCH_DELAY_MS = 150
const appliedQuery = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchQuery, (q) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    appliedQuery.value = q
  }, SEARCH_DELAY_MS)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

// Each model's searchable text, lowercased once per state change.
const searchText = computed(
  () =>
    new Map(
      (allModels.value as Model[]).map((m) => [
        m,
        [m.name, m.label || '', m.provider, m.api_id || ''].map((s) => s.toLowerCase()),
      ]),
    ),
)

const filteredModels = computed(() => {
  const models = allModels.value as Model[]
  const rp = readyProviders.value
  const q = appliedQuery.value.trim().toLowerCase()

  if (props.model)
    return models.filter((m) => m.name === props.model && m.provider === props.provider)

  const texts = q ? searchText.value : null
  return models.filter((m) => {
    // Filter by search query
    if (texts) {
      const matches = texts.get(m)?.some((s) => s.includes(q))
      if (!matches) return false
    }

    // Filter by keys
    if (withKeysOnly.value && !rp.has(m.provider)) return false

    // Filter by AUTO-ranked
    if (autoRankedOnly.value && !m.auto) return false

    return true
  })
})

const sortModels = (models: Model[]): Model[] => {
  if (orderBy.value === 'name') {
    return [...models].sort((a, b) => a.name.localeCompare(b.name))
  }
  // Sort by star (priority first, then by lowest number, then by name)
  return [...models].sort((a, b) => {
    if ((a.priority == null) !== (b.priority == null)) {
      return a.priority == null ? 1 : -1
    }
    if (a.priority != null && b.priority != null) {
      if (a.priority !== b.priority) return a.priority - b.priority
    }
    return a.name.localeCompare(b.name)
  })
}

const regularModels = computed(() =>
  sortModels(filteredModels.value.filter((m) => m.kind !== 'typed')),
)

const shownModels = computed(() =>
  showAll.value || props.model ? regularModels.value : regularModels.value.slice(0, FOLD),
)

const typedModels = computed(() => filteredModels.value.filter((m) => m.kind === 'typed'))

const starredModels = computed(() => {
  const starred = allModels.value.filter((m: Model) => m.priority)
  return [...(starred as Model[])].sort((a, b) => {
    if (a.priority == null) return 1
    if (b.priority == null) return -1
    return (a.priority || 0) - (b.priority || 0)
  })
})

async function toggleModel(modelName: string, enabled: boolean) {
  try {
    busyModels.add(modelName)
    await apiCall('models/enabled', {
      method: 'POST',
      body: JSON.stringify({ name: modelName, enabled }),
    })
    emit('changed')
    toast.success(t('hswarm.v.models.toggled'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast.error(t('hswarm.v.models.toggleError', { error: message }))
  } finally {
    busyModels.delete(modelName)
  }
}

async function setPriority(modelName: string, priority: number | null) {
  try {
    busyModels.add(modelName)
    await apiCall('models/priority', {
      method: 'POST',
      body: JSON.stringify({ name: modelName, priority }),
    })
    emit('changed')
    toast.success(t('hswarm.v.models.prioritySet'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast.error(t('hswarm.v.models.priorityError', { error: message }))
  } finally {
    busyModels.delete(modelName)
  }
}

async function toggleStar(modelName: string) {
  const model = allModels.value.find((m: Model) => m.name === modelName) as Model
  if (!model) return

  const newPriority = model.priority ? null : 1
  await setPriority(modelName, newPriority)
}

// The console's "Add model" form: any model a provider serves, reachable by name and by a role.
const showAddModel = ref(false)
const addingModel = ref(false)
const blankModel = () => ({
  name: '',
  provider: '',
  api_id: '',
  ctx: '',
  hit: '',
  miss: '',
  out: '',
  vision: false,
  tools: true,
})
const newModel = ref(blankModel())
const providerNames = computed(() =>
  [...(props.state?.providers ?? [])]
    .sort(
      (a: any, b: any) => Number(b.keys > 0) - Number(a.keys > 0) || a.name.localeCompare(b.name),
    )
    .map((p: any) => p.name as string),
)

function addModel() {
  newModel.value = { ...blankModel(), provider: props.provider ?? providerNames.value[0] ?? '' }
  showAddModel.value = true
}

async function submitModel() {
  const f = newModel.value
  const name = f.name.trim().toLowerCase()
  if (!name || !f.provider) {
    toast.error(t('hswarm.v.models.addModelRequired'))
    return
  }
  addingModel.value = true
  try {
    await apiCall('models/add', {
      method: 'POST',
      body: JSON.stringify({
        name,
        provider: f.provider,
        api_id: f.api_id.trim(),
        ctx: Number.parseInt(f.ctx, 10) || 131072,
        price: { hit: f.hit.trim(), miss: f.miss.trim(), out: f.out.trim() },
        vision: f.vision,
        tools: f.tools,
      }),
    })
    showAddModel.value = false
    toast.success(t('hswarm.v.models.modelAdded', { name }))
    emit('changed')
    emit('open', ['providers', f.provider, name])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast.error(t('hswarm.v.models.addModelError', { error: message }))
  } finally {
    addingModel.value = false
  }
}

onMounted(() => {
  if (props.adding) addModel()
})
</script>

<template>
  <div class="flex flex-col gap-2 p-4">
    <!-- Callout if no ready providers -->
    <Alert
      v-if="readyProviders.size === 0"
      variant="destructive"
    >
      <AlertCircle class="h-4 w-4" />
      <AlertDescription>
        {{ t('hswarm.v.models.noKeyCallout') }}
      </AlertDescription>
    </Alert>

    <!-- Starred models strip -->
    <div
      v-if="starredModels.length > 0 && !props.model"
      class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <span class="text-muted-foreground">{{ t('hswarm.v.models.starredFirst') }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <div
          v-for="m in starredModels"
          :key="m.name"
          class="flex items-center gap-1 whitespace-nowrap"
        >
          <span class="font-semibold">★{{ m.priority }}</span>
          <span>{{ m.label || m.name }}</span>
          <span
            v-if="!m.auto"
            class="text-xs text-muted-foreground"
          >
            {{ t('hswarm.v.models.noAuto') }}
          </span>
          <span
            v-else-if="m.switched_off || !m.enabled"
            class="text-xs text-muted-foreground"
          >
            ({{ t('hswarm.v.models.statusOff') }})
          </span>
          <span
            v-else-if="!readyProviders.has(m.provider)"
            class="text-xs text-muted-foreground"
          >
            ({{ t('hswarm.v.models.statusNoKey') }})
          </span>
        </div>
      </div>
      <div class="flex-1" />
      <a href="#" class="text-xs text-primary hover:underline" @click.prevent="emit('open', ['routing'])">
        {{ t('hswarm.v.models.seeAutoRouting') }}
      </a>
    </div>

    <!-- Add button and heading -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold">
          {{ props.model ? t('hswarm.v.models.oneModel', { name: props.model, provider: props.provider }) : t('hswarm.v.models.allModels') }}
        </h2>
        <p class="text-sm text-muted-foreground">
          {{ t('hswarm.v.models.description') }}
        </p>
      </div>
      <Button
        variant="default"
        size="sm"
        @click="addModel"
      >
        <Plus class="mr-1 h-4 w-4" />
        {{ t('hswarm.addModel') }}
      </Button>
    </div>

    <!-- Add model form (the console's "Add model" page) -->
    <Card size="sm" v-if="showAddModel" class="border-primary/50">
      <CardHeader>
        <CardTitle>{{ t('hswarm.addModel') }}</CardTitle>
        <CardDescription>{{ t('hswarm.v.models.addModelDesc') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <div class="grid gap-2 sm:grid-cols-3">
          <div class="space-y-2">
            <Label for="nm-name">{{ t('hswarm.v.models.newName') }}</Label>
            <Input id="nm-name" v-model="newModel.name" :placeholder="t('hswarm.v.models.newNamePlaceholder')" />
          </div>
          <div class="space-y-2">
            <Label for="nm-prov">{{ t('hswarm.v.models.colProvider') }}</Label>
            <select
              id="nm-prov"
              v-model="newModel.provider"
              class="h-9 w-full rounded border border-input bg-background px-2 py-1 text-sm"
            >
              <option v-for="p in providerNames" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="space-y-2">
            <Label for="nm-api">{{ t('hswarm.v.models.newApiId') }}</Label>
            <Input id="nm-api" v-model="newModel.api_id" class="font-mono" :placeholder="t('hswarm.v.models.newApiIdPlaceholder')" />
          </div>
        </div>
        <div class="grid gap-2 sm:grid-cols-4">
          <div class="space-y-2">
            <Label for="nm-ctx">{{ t('hswarm.v.models.newCtx') }}</Label>
            <Input id="nm-ctx" v-model="newModel.ctx" class="font-mono" inputmode="numeric" placeholder="131072" />
          </div>
          <div class="space-y-2">
            <Label for="nm-hit">{{ t('hswarm.v.models.newPriceHit') }}</Label>
            <Input id="nm-hit" v-model="newModel.hit" class="font-mono" inputmode="decimal" />
          </div>
          <div class="space-y-2">
            <Label for="nm-miss">{{ t('hswarm.v.models.newPriceIn') }}</Label>
            <Input id="nm-miss" v-model="newModel.miss" class="font-mono" inputmode="decimal" />
          </div>
          <div class="space-y-2">
            <Label for="nm-out">{{ t('hswarm.v.models.newPriceOut') }}</Label>
            <Input id="nm-out" v-model="newModel.out" class="font-mono" inputmode="decimal" />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-2">
            <input id="nm-vis" v-model="newModel.vision" type="checkbox" class="size-4 accent-current" />
            <Label for="nm-vis" class="cursor-pointer text-sm font-normal">{{ t('hswarm.v.models.badgeVision') }}</Label>
          </div>
          <div class="flex items-center gap-2">
            <input id="nm-tools" v-model="newModel.tools" type="checkbox" class="size-4 accent-current" />
            <Label for="nm-tools" class="cursor-pointer text-sm font-normal">{{ t('hswarm.v.models.newTools') }}</Label>
          </div>
          <div class="ms-auto flex gap-2">
            <Button variant="outline" @click="showAddModel = false">{{ t('hswarm.cancel') }}</Button>
            <Button :disabled="addingModel" @click="submitModel">{{ t('hswarm.addModel') }}</Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Filter section (not for a single model) -->
    <div v-if="!props.model" class="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex-1">
          <Label
            for="model-search"
            class="text-sm"
          >
            {{ t('hswarm.v.models.filterLabel') }}
          </Label>
          <Input
            id="model-search"
            v-model="searchQuery"
            type="search"
            :placeholder="t('hswarm.v.models.filterPlaceholder')"
            class="mt-1"
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2">
          <input
            id="with-keys"
            v-model="withKeysOnly"
            type="checkbox"
            class="size-4 accent-current"
          />
          <Label
            for="with-keys"
            class="cursor-pointer text-sm font-normal"
          >
            {{ t('hswarm.v.models.onlyWithKeys') }}
          </Label>
        </div>

        <div class="flex items-center gap-2">
          <input
            id="auto-ranked"
            v-model="autoRankedOnly"
            type="checkbox"
            class="size-4 accent-current"
          />
          <Label
            for="auto-ranked"
            class="cursor-pointer text-sm font-normal"
            :title="t('hswarm.v.models.autoRankedTitle')"
          >
            {{ t('hswarm.v.models.onlyAutoRanked') }}
          </Label>
        </div>

        <div class="ml-auto flex items-center gap-3">
          <Label
            for="order-by"
            class="text-sm font-normal"
          >
            {{ t('hswarm.v.models.orderLabel') }}
          </Label>
          <select
            id="order-by"
            v-model="orderBy"
            class="rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="star">{{ t('hswarm.v.models.orderStar') }}</option>
            <option value="name">{{ t('hswarm.v.models.orderName') }}</option>
          </select>

          <div class="ml-auto text-sm text-muted-foreground">
            {{ filteredModels.length }} {{ t('hswarm.v.models.of') }} {{ allModels.length }}
          </div>
        </div>
      </div>
    </div>

    <!-- Models table -->
    <div class="overflow-x-auto rounded-lg border border-border">
      <Table class="[&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
        <TableHeader>
          <TableRow>
            <TableHead class="w-12">{{ t('hswarm.v.models.colEnabled') }}</TableHead>
            <TableHead class="w-12">{{ t('hswarm.v.models.colPriority') }}</TableHead>
            <TableHead>{{ t('hswarm.v.models.colModel') }}</TableHead>
            <TableHead
              v-if="allModels.some((m: any) => m.provider)"
              class="w-32"
            >
              {{ t('hswarm.v.models.colProvider') }}
            </TableHead>
            <TableHead class="w-20">{{ t('hswarm.v.models.colKind') }}</TableHead>
            <TableHead class="w-24 text-right">{{ t('hswarm.v.models.colPrice') }}</TableHead>
            <TableHead class="w-16 text-right">{{ t('hswarm.v.models.colContext') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="m in shownModels"
            :key="m.name"
            :class="{ 'opacity-60': m.switched_off || !m.enabled }"
          >
            <TableCell>
              <Switch
                :model-value="!m.switched_off && m.enabled"
                :disabled="busyModels.has(m.name)"
                @update:model-value="(v) => toggleModel(m.name, v)"
                :aria-label="`Toggle ${m.name}`"
              />
            </TableCell>
            <TableCell>
              <Button
                v-if="m.auto || m.priority"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs font-semibold"
                :disabled="busyModels.has(m.name)"
                @click="toggleStar(m.name)"
              >
                <Star
                  :class="{ 'fill-current': m.priority }"
                  class="h-3 w-3"
                />
                {{ m.priority ? m.priority : '' }}
              </Button>
              <span
                v-else
                class="text-xs text-muted-foreground"
              >
                –
              </span>
            </TableCell>
            <TableCell class="font-medium">{{ m.label || m.name }}</TableCell>
            <TableCell
              v-if="allModels.some((m: any) => m.provider)"
              class="text-sm"
            >
              {{ m.provider }}
            </TableCell>
            <TableCell class="text-sm">
              <span
                v-if="m.custom"
                class="inline-block rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900 dark:bg-blue-900 dark:text-blue-100"
              >
                {{ t('hswarm.v.models.badgeCustom') }}
              </span>
              <span
                v-if="m.vision"
                class="inline-block rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-900 dark:bg-purple-900 dark:text-purple-100"
              >
                {{ t('hswarm.v.models.badgeVision') }}
              </span>
            </TableCell>
            <TableCell class="text-right font-mono text-sm">
              {{ m.usd_per_1m ? `$${Number(m.usd_per_1m).toFixed(4)}` : '–' }}
            </TableCell>
            <TableCell class="text-right text-sm">
              {{ m.ctx ? `${m.ctx}k` : '–' }}
            </TableCell>
          </TableRow>
          <TableRow
            v-if="regularModels.length === 0"
            class="hover:bg-transparent"
          >
            <TableCell
              :colspan="allModels.some((m: any) => m.provider) ? 7 : 6"
              class="py-4 text-center text-muted-foreground"
            >
              {{ t('hswarm.v.models.noModels') }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <Button
      v-if="regularModels.length > FOLD && !props.model"
      size="sm"
      variant="outline"
      class="self-start"
      @click="showAll = !showAll"
    >
      {{ showAll ? t('hswarm.v.models.showFewer') : t('hswarm.v.models.showAll', { n: regularModels.length }) }}
    </Button>

    <!-- Typed models section -->
    <div
      v-if="typedModels.length > 0"
      class="flex flex-col gap-3"
    >
      <h3 class="text-sm font-semibold">{{ t('hswarm.v.models.helpersTitle') }}</h3>
      <p class="text-sm text-muted-foreground">{{ t('hswarm.v.models.helpersDesc') }}</p>
      <div class="overflow-x-auto rounded-lg border border-border">
        <Table class="[&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
          <TableHeader>
            <TableRow>
              <TableHead class="w-12">{{ t('hswarm.v.models.colEnabled') }}</TableHead>
              <TableHead>{{ t('hswarm.v.models.colModel') }}</TableHead>
              <TableHead class="w-32">{{ t('hswarm.v.models.colProvider') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="m in typedModels"
              :key="m.name"
            >
              <TableCell>
                <Switch
                  :model-value="!m.switched_off && m.enabled"
                  :disabled="busyModels.has(m.name)"
                  @update:model-value="(v) => toggleModel(m.name, v)"
                  :aria-label="`Toggle ${m.name}`"
                />
              </TableCell>
              <TableCell class="font-medium">{{ m.label || m.name }}</TableCell>
              <TableCell class="text-sm">{{ m.provider }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  </div>
</template>
