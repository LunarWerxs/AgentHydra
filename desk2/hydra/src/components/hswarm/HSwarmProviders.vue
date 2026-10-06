<script setup lang="ts">
import { AlertCircle, Plus, Zap } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import HSwarmKeyStorage from '@/components/hswarm/HSwarmKeyStorage.vue'
import HSwarmKeyRow from '@/components/hswarm/HSwarmKeyRow.vue'
import HSwarmProviderRow from '@/components/hswarm/HSwarmProviderRow.vue'
import HSwarmModelRow from '@/components/hswarm/HSwarmModelRow.vue'
import InstanceCard from '@/components/InstanceCard.vue'
import InstanceSectionHeader from '@/components/InstanceSectionHeader.vue'
import InstanceTable from '@/components/InstanceTable.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { TableBody } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import type { SortDirection } from '@/composables/useSortable'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'
import { hswarmProviderColumns, hswarmKeyColumns, hswarmModelColumns } from '@/lib/hswarm-table'
import type { HSwarmProviderRowModel, HSwarmKeyRowModel, HSwarmModelRowModel } from '@/lib/hswarm-table'

const { t } = useI18n()
const { apiCall, state: apiState } = useHswarmApi()

interface Props {
  state: HswarmState
  // Set when the HSwarm tree picked one provider: the page shows only that provider.
  provider?: string
  // Set by the tree's "Add provider" button: the page opens on the add form.
  adding?: boolean
}

interface Key {
  fingerprint: string
  masked: string
  source: string
  state: string
  priority?: number | null
  disabled?: boolean
  reason?: string
  editable?: boolean
  resting_s?: number
  free_only?: boolean
}

const props = defineProps<Props>()

const selectedProvider = ref<string | null>(null)
const loading = ref(false)
const keys = ref<Record<string, Key[]>>({})
const newKeyInput = ref('')
const addProviderForm = ref({
  name: '',
  base_url: '',
  docs: '',
  website: '',
})

const showAddProvider = ref(!!props.adding)

// Table sorting (all providers list)
const providersSortBy = ref<'name' | 'state'>('state')
const providersSortDir = ref<SortDirection>(null)

// Derived data
const sortedProviders = computed(() => {
  if (!apiState.value?.providers) return []
  let sorted = [...apiState.value.providers].sort((a, b) => {
    // Default sort: by state (ready first), then by name
    const aStatus = getProviderStatus(a)
    const bStatus = getProviderStatus(b)
    const statusOrder = { ready: 0, resting: 1, disabled: 2, nokeys: 3 }
    const statusDiff =
      (statusOrder[aStatus as keyof typeof statusOrder] ?? 3) -
      (statusOrder[bStatus as keyof typeof statusOrder] ?? 3)
    if (statusDiff !== 0) return statusDiff
    return a.name.localeCompare(b.name)
  })

  // Apply explicit sort if selected
  if (providersSortBy.value === 'name' && providersSortDir.value !== null) {
    sorted = sorted.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name)
      return providersSortDir.value === 'asc' ? cmp : -cmp
    })
  } else if (providersSortBy.value === 'state' && providersSortDir.value !== null) {
    sorted = sorted.sort((a, b) => {
      const aStatus = getProviderStatus(a)
      const bStatus = getProviderStatus(b)
      const statusOrder = { ready: 0, resting: 1, disabled: 2, nokeys: 3 }
      const statusDiff =
        (statusOrder[aStatus as keyof typeof statusOrder] ?? 3) -
        (statusOrder[bStatus as keyof typeof statusOrder] ?? 3)
      return providersSortDir.value === 'asc' ? statusDiff : -statusDiff
    })
  }

  return sorted
})

function getProviderIndicator(key: string): SortDirection {
  if (key === providersSortBy.value) return providersSortDir.value
  return null
}

const selectedProviderData = computed(() => {
  if (!selectedProvider.value) return null
  return apiState.value?.providers?.find((p) => p.name === selectedProvider.value)
})

const selectedProviderKeys = computed(() => {
  if (!selectedProvider.value) return []
  return keys.value[selectedProvider.value] || []
})

const modelsForSelectedProvider = computed(() => {
  if (!selectedProvider.value) return []
  return apiState.value?.models?.filter((m) => m.provider === selectedProvider.value) || []
})

// As the console: a long table shows its first rows and a button for the rest.
const FOLD = 5
const showAllKeys = ref(false)
const showAllModels = ref(false)
const shownKeys = computed(() =>
  showAllKeys.value ? selectedProviderKeys.value : selectedProviderKeys.value.slice(0, FOLD),
)
const shownModels = computed(() =>
  showAllModels.value
    ? modelsForSelectedProvider.value
    : modelsForSelectedProvider.value.slice(0, FOLD),
)

// API operations
async function fetchKeys(provider: string) {
  try {
    loading.value = true
    const response = await apiCall(`keys?provider=${encodeURIComponent(provider)}`)
    keys.value[provider] = response.rows || []
  } catch (error) {
    toast.error(t('hswarm.v.providers.keysLoadError'))
    console.error(error)
  } finally {
    loading.value = false
  }
}

async function addKey(provider: string, key: string) {
  if (!key.trim()) {
    toast.error(t('hswarm.v.providers.keyRequired'))
    return
  }
  try {
    loading.value = true
    await apiCall('keys/add', {
      method: 'POST',
      body: JSON.stringify({ provider, key }),
    })
    newKeyInput.value = ''
    await fetchKeys(provider)
    emit('changed')
    toast.success(t('hswarm.v.providers.keyAdded'))
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Unknown error'
    toast.error(`${t('hswarm.v.providers.keyAddError')}: ${err}`)
  } finally {
    loading.value = false
  }
}

async function removeKey(provider: string, fingerprint: string) {
  if (!confirm(t('hswarm.v.providers.confirmRemoveKey'))) return
  try {
    loading.value = true
    await apiCall('keys/remove', {
      method: 'POST',
      body: JSON.stringify({ provider, fingerprint }),
    })
    await fetchKeys(provider)
    emit('changed')
    toast.success(t('hswarm.v.providers.keyRemoved'))
  } catch (error) {
    toast.error(t('hswarm.v.providers.keyRemoveError'))
  } finally {
    loading.value = false
  }
}

async function checkKey(provider: string, fingerprint: string) {
  try {
    loading.value = true
    const response = await apiCall('keys/check', {
      method: 'POST',
      body: JSON.stringify({ provider, fingerprint }),
    })
    await fetchKeys(provider)
    if (response.result === 'ok') {
      toast.success(t('hswarm.v.providers.keyCheckOk'))
    } else {
      toast.error(`${t('hswarm.v.providers.keyCheckFailed')}: ${response.result}`)
    }
  } catch (error) {
    toast.error(t('hswarm.v.providers.keyCheckError'))
  } finally {
    loading.value = false
  }
}

async function setKeyPriority(provider: string, fingerprint: string, priority: number | null) {
  try {
    await apiCall('keys/priority', {
      method: 'POST',
      body: JSON.stringify({ provider, fingerprint, priority }),
    })
    await fetchKeys(provider)
    emit('changed')
  } catch (error) {
    toast.error(t('hswarm.v.providers.prioritySetError'))
  }
}

async function setKeyEnabled(provider: string, fingerprint: string, enabled: boolean) {
  try {
    await apiCall('keys/enabled', {
      method: 'POST',
      body: JSON.stringify({ provider, fingerprint, enabled }),
    })
    await fetchKeys(provider)
    emit('changed')
    toast.success(t('hswarm.v.providers.keyStateChanged'))
  } catch (error) {
    toast.error(t('hswarm.v.providers.keyStateChangeError'))
  }
}

async function probeBalance(provider?: string) {
  try {
    loading.value = true
    await apiCall('keys/probe', {
      method: 'POST',
      body: JSON.stringify(provider ? { provider } : {}),
    })
    if (provider) {
      await fetchKeys(provider)
    }
    emit('changed')
    toast.success(t('hswarm.v.providers.probeComplete'))
  } catch (error) {
    toast.error(t('hswarm.v.providers.probeError'))
  } finally {
    loading.value = false
  }
}

async function setProviderEnabled(provider: string, enabled: boolean) {
  try {
    await apiCall('providers/set', {
      method: 'POST',
      body: JSON.stringify({ name: provider, enabled }),
    })
    emit('changed')
    toast.success(t('hswarm.v.providers.providerStateChanged'))
  } catch (error) {
    toast.error(t('hswarm.v.providers.providerStateChangeError'))
  }
}

async function addProvider() {
  if (!addProviderForm.value.name || !addProviderForm.value.base_url) {
    toast.error(t('hswarm.v.providers.providerFormRequired'))
    return
  }
  try {
    loading.value = true
    await apiCall('providers/add', {
      method: 'POST',
      body: JSON.stringify(addProviderForm.value),
    })
    showAddProvider.value = false
    addProviderForm.value = { name: '', base_url: '', docs: '', website: '' }
    emit('changed')
    toast.success(t('hswarm.v.providers.providerAdded'))
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Unknown error'
    toast.error(`${t('hswarm.v.providers.providerAddError')}: ${err}`)
  } finally {
    loading.value = false
  }
}

async function removeProvider(provider: string) {
  if (!confirm(t('hswarm.v.providers.confirmRemoveProvider'))) return
  try {
    loading.value = true
    await apiCall('providers/remove', {
      method: 'POST',
      body: JSON.stringify({ name: provider }),
    })
    selectedProvider.value = null
    emit('changed')
    toast.success(t('hswarm.v.providers.providerRemoved'))
  } catch (error) {
    toast.error(t('hswarm.v.providers.providerRemoveError'))
  } finally {
    loading.value = false
  }
}

function getProviderStatus(p: any) {
  if (!p.enabled) return 'disabled'
  if (p.ready > 0) return 'ready'
  if (p.resting > 0) return 'resting'
  if (p.disabled > 0) return 'disabled'
  return 'nokeys'
}

function getProviderStatusLabel(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  switch (status) {
    case 'ready':
      return { label: t('hswarm.v.providers.statusReady'), variant: 'default' }
    case 'resting':
      return { label: t('hswarm.v.providers.statusResting'), variant: 'secondary' }
    case 'disabled':
      return { label: t('hswarm.v.providers.statusDisabled'), variant: 'destructive' }
    default:
      return { label: t('hswarm.v.providers.statusNoKeys'), variant: 'outline' }
  }
}

const providerRowModels = computed((): HSwarmProviderRowModel[] => {
  return sortedProviders.value.map((p, idx) => ({
    id: p.name,
    name: p.name,
    state: getProviderStatusLabel(getProviderStatus(p)),
    readyCount: p.ready ?? 0,
    restingCount: p.resting ?? 0,
    disabledCount: p.disabled ?? 0,
    keyCount: p.keys ?? 0,
    enabled: !!p.enabled,
    onEnabledChange: (v) => setProviderEnabled(p.name, v),
    onOpen: (path) => emit('open', path),
  }))
})

const keyRowModels = computed((): HSwarmKeyRowModel[] => {
  if (!selectedProvider.value) return []
  return selectedProviderKeys.value.map((k) => ({
    id: k.fingerprint,
    fingerprint: k.fingerprint,
    masked: k.masked,
    priority: k.priority ?? null,
    state: getKeyStateLabel(k),
    disabled: !!k.disabled,
    resting_s: k.resting_s,
    free_only: !!k.free_only,
    editable: !!k.editable,
    onPriorityChange: (p) => setKeyPriority(selectedProvider.value!, k.fingerprint, p),
    onEnabledChange: (v) => setKeyEnabled(selectedProvider.value!, k.fingerprint, v),
    onCheck: () => checkKey(selectedProvider.value!, k.fingerprint),
    onRemove: () => removeKey(selectedProvider.value!, k.fingerprint),
  }))
})

function getKeyStateLabel(k: Key): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (k.disabled) {
    const label = k.free_only ? t('hswarm.v.providers.disabledFree') : t('hswarm.v.providers.disabledKey')
    return { label, variant: 'destructive' }
  }
  if (k.state === 'resting') {
    const label = `${t('hswarm.v.providers.resting')} ${Math.round(k.resting_s || 0)}${t('hswarm.v.providers.seconds')}`
    return { label, variant: 'secondary' }
  }
  return { label: t('hswarm.v.providers.keyReady'), variant: 'default' }
}

const modelRowModels = computed((): HSwarmModelRowModel[] => {
  if (!selectedProvider.value) return []
  return modelsForSelectedProvider.value.map((m) => ({
    id: m.name,
    name: m.name,
    label: m.label,
    enabled: !!m.enabled,
    switched_off: !!m.switched_off,
    priority: m.priority ?? null,
    provider: m.provider,
    kind: m.kind,
    usd_per_1m: m.usd_per_1m,
    ctx: m.ctx,
    custom: !!m.custom,
    vision: !!m.vision,
    tools: m.tools,
    auto: !!m.auto,
    onEnabledChange: (v) => {},
    onPriorityChange: (p) => {},
    onToggleStar: () => {},
  }))
})

function selectProvider(name: string) {
  selectedProvider.value = name
  if (!keys.value[name]) {
    fetchKeys(name)
  }
}

onMounted(() => {
  // Without a provider the page is the all-providers table; the tree picks one.
  if (props.provider) selectProvider(props.provider)
})

// open: show one object in the HSwarm tree (a provider in the table), as path segments.
const emit = defineEmits<{ changed: []; open: [path: string[]] }>()
</script>

<template>
  <div class="h-full flex flex-col gap-2 p-4">
    <!-- Where the keys live: this folder, or also a shared encrypted vault -->
    <HSwarmKeyStorage v-if="!props.provider" @changed="emit('changed')" />

    <!-- Toolbar -->
    <div class="flex items-center gap-2">
      <Button @click="() => probeBalance()" :disabled="loading" size="sm">
        <Zap class="size-4" />
        <span class="ms-1">{{ t('hswarm.v.providers.probeAll') }}</span>
      </Button>
      <Button @click="() => (showAddProvider = true)" :disabled="loading" size="sm" variant="outline">
        <Plus class="size-4" />
        <span class="ms-1">{{ t('hswarm.v.providers.addProvider') }}</span>
      </Button>
    </div>

    <!-- Add Provider Form -->
    <Collapsible v-if="showAddProvider" open @update:open="(v: boolean) => (showAddProvider = v)">
      <Card size="sm" class="border-primary/50">
        <CardHeader>
          <CardTitle>{{ t('hswarm.v.providers.addProviderTitle') }}</CardTitle>
          <CardDescription>{{ t('hswarm.v.providers.addProviderDesc') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div class="space-y-2">
            <Label for="prov-name">{{ t('hswarm.v.providers.name') }}</Label>
            <Input
              id="prov-name"
              v-model="addProviderForm.name"
              :placeholder="t('hswarm.v.providers.nameExample')"
            />
          </div>
          <div class="space-y-2">
            <Label for="prov-url">{{ t('hswarm.v.providers.baseUrl') }}</Label>
            <Input
              id="prov-url"
              v-model="addProviderForm.base_url"
              :placeholder="t('hswarm.v.providers.baseUrlPlaceholder')"
            />
          </div>
          <div class="space-y-2">
            <Label for="prov-docs">{{ t('hswarm.v.providers.docs') }}</Label>
            <Input
              id="prov-docs"
              v-model="addProviderForm.docs"
              :placeholder="t('hswarm.v.providers.docsPlaceholder')"
            />
          </div>
          <div class="space-y-2">
            <Label for="prov-website">{{ t('hswarm.v.providers.website') }}</Label>
            <Input
              id="prov-website"
              v-model="addProviderForm.website"
              :placeholder="t('hswarm.v.providers.websitePlaceholder')"
            />
          </div>
          <div class="flex gap-2 justify-end">
            <Button variant="outline" @click="() => (showAddProvider = false)">
              {{ t('hswarm.cancel') }}
            </Button>
            <Button @click="addProvider" :disabled="loading">
              {{ t('hswarm.v.providers.add') }}
            </Button>
          </div>
        </CardContent>
      </Card>
    </Collapsible>

    <!-- Main content -->
    <div class="flex-1 min-h-0 flex gap-2 overflow-hidden">
      <!-- All providers (the tree's Providers row): one table with shared components -->
      <div v-if="!props.provider" class="flex-1 flex flex-col gap-2 overflow-y-auto">
        <InstanceTable
          :columns="hswarmProviderColumns"
          :indicator-for="getProviderIndicator"
          :empty="
            sortedProviders.length === 0
              ? {
                  icon: AlertCircle,
                  title: t('hswarm.v.providers.noProviders'),
                  hint: '',
                }
              : null
          "
        >
          <TableBody>
            <HSwarmProviderRow
              v-for="row in providerRowModels"
              :key="row.id"
              :columns="hswarmProviderColumns"
              :row="row"
            />
          </TableBody>
        </InstanceTable>
      </div>

      <!-- Provider details (one provider picked in the tree) -->
      <div v-else-if="selectedProviderData" class="flex-1 flex flex-col gap-2 overflow-y-auto">
        <!-- Provider header -->
        <div class="flex items-start justify-between gap-2 pb-2 border-b">
          <div class="flex-1">
            <h2 class="text-xl font-bold">{{ selectedProviderData.name }}</h2>
            <p v-if="selectedProviderData.about" class="text-sm text-muted-foreground mt-1">
              {{ selectedProviderData.about }}
            </p>
            <div v-if="selectedProviderData.website" class="mt-2">
              <a
                :href="selectedProviderData.website"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm text-primary hover:underline"
              >
                {{ selectedProviderData.website }}
              </a>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Label class="text-sm">{{ t('hswarm.v.providers.enabled') }}</Label>
            <Switch
              :model-value="!!selectedProviderData.enabled"
              :aria-label="t('hswarm.v.providers.useProvider', { name: selectedProviderData.name })"
              @update:model-value="
                (v: boolean) => setProviderEnabled(selectedProviderData.name, v)
              "
            />
          </div>
        </div>

        <!-- Status cards -->
        <div class="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <span><span class="text-muted-foreground">{{ t('hswarm.v.providers.readyKeys') }}</span> <b class="font-mono">{{ selectedProviderData.ready || 0 }}</b></span>
          <span><span class="text-muted-foreground">{{ t('hswarm.v.providers.restingKeys') }}</span> <b class="font-mono">{{ selectedProviderData.resting || 0 }}</b></span>
          <span><span class="text-muted-foreground">{{ t('hswarm.v.providers.disabledKeys') }}</span> <b class="font-mono">{{ selectedProviderData.disabled || 0 }}</b></span>
        </div>

        <!-- Keys section -->
        <InstanceCard class="!m-0">
          <InstanceSectionHeader
            :title="t('hswarm.v.providers.keys')"
            :count="selectedProviderKeys.length"
            :refreshing="loading"
            :refresh-label="t('hswarm.v.providers.probeBalance')"
            @refresh="() => probeBalance(selectedProviderData.name)"
          />
          <div class="px-3 pb-3">
            <!-- Add key input -->
            <div class="flex gap-2">
              <Input
                v-model="newKeyInput"
                type="password"
                :placeholder="t('hswarm.v.providers.pasteKeyPlaceholder')"
                @keyup.enter="() => addKey(selectedProviderData.name, newKeyInput)"
              />
              <Button
                @click="() => addKey(selectedProviderData.name, newKeyInput)"
                :disabled="loading || !newKeyInput.trim()"
                size="sm"
              >
                {{ t('hswarm.v.providers.add') }}
              </Button>
            </div>
          </div>
            <!-- Keys table -->
            <InstanceTable
              v-if="selectedProviderKeys.length > 0"
              :columns="hswarmKeyColumns"
              :indicator-for="() => null"
              :empty="null"
            >
              <TableBody>
                <HSwarmKeyRow
                  v-for="row in keyRowModels.slice(0, showAllKeys ? keyRowModels.length : FOLD)"
                  :key="row.id"
                  :columns="hswarmKeyColumns"
                  :row="row"
                  :multiple-keys="selectedProviderKeys.length > 1"
                />
              </TableBody>
            </InstanceTable>

            <div v-else class="px-3 pb-3 text-sm text-muted-foreground text-center">
              {{ t('hswarm.v.providers.noKeysYet') }}
            </div>

          <div v-if="selectedProviderKeys.length > FOLD" class="p-3">
            <Button size="sm" variant="outline" @click="showAllKeys = !showAllKeys">
              {{ showAllKeys ? t('hswarm.v.providers.showFewer') : t('hswarm.v.providers.showAllKeys', { n: selectedProviderKeys.length }) }}
            </Button>
          </div>
        </InstanceCard>

        <!-- Models section -->
        <InstanceCard v-if="modelsForSelectedProvider.length > 0" class="!m-0">
          <InstanceSectionHeader
            :title="t('hswarm.v.providers.models')"
            :count="modelsForSelectedProvider.length"
            :refreshing="false"
            :refresh-label="t('hswarm.refresh')"
            @refresh="() => {}"
          />
          <InstanceTable
            :columns="hswarmModelColumns"
            :indicator-for="() => null"
            :empty="null"
          >
            <TableBody>
              <HSwarmModelRow
                v-for="row in modelRowModels.slice(0, showAllModels ? modelRowModels.length : FOLD)"
                :key="row.id"
                :columns="hswarmModelColumns"
                :row="row"
              />
            </TableBody>
          </InstanceTable>
          <div v-if="modelsForSelectedProvider.length > FOLD" class="p-3">
            <Button
              size="sm"
              variant="outline"
              @click="showAllModels = !showAllModels"
            >
              {{ showAllModels ? t('hswarm.v.providers.showFewer') : t('hswarm.v.providers.showAllModels', { n: modelsForSelectedProvider.length }) }}
            </Button>
          </div>
        </InstanceCard>

        <!-- Remove provider section -->
        <Card size="sm" v-if="!selectedProviderData.builtin" class="border-destructive/50">
          <CardHeader>
            <CardTitle class="text-destructive">{{ t('hswarm.v.providers.removeProvider') }}</CardTitle>
            <CardDescription>
              {{ t('hswarm.v.providers.removeProviderDesc') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              @click="() => removeProvider(selectedProviderData.name)"
              :disabled="loading"
            >
              {{ t('hswarm.v.providers.remove') }}
            </Button>
          </CardContent>
        </Card>
      </div>

      <!-- Empty state -->
      <div
        v-else
        class="flex-1 flex items-center justify-center text-muted-foreground"
      >
        <div class="text-center">
          <p>{{ t('hswarm.v.providers.selectProvider') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
