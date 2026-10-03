<script setup lang="ts">
import { AlertCircle, CheckCircle2, Clock, Eye, EyeOff, Plus, Trash2, Zap } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
import { Textarea } from '@/components/ui/textarea'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'

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

// Derived data
const sortedProviders = computed(() => {
  if (!apiState.value?.providers) return []
  return [...apiState.value.providers].sort((a, b) => {
    const aReady = a.keys > 0 ? 1 : 0
    const bReady = b.keys > 0 ? 1 : 0
    if (aReady !== bReady) return bReady - aReady
    return a.name.localeCompare(b.name)
  })
})

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

function getProviderStatusBadge(status: string) {
  switch (status) {
    case 'ready':
      return { variant: 'default', icon: CheckCircle2 }
    case 'resting':
      return { variant: 'secondary', icon: Clock }
    case 'disabled':
      return { variant: 'destructive', icon: AlertCircle }
    default:
      return { variant: 'outline', icon: AlertCircle }
  }
}

function selectProvider(name: string) {
  selectedProvider.value = name
  if (!keys.value[name]) {
    fetchKeys(name)
  }
}

// The all-providers table's State column.
function stateVariant(p: any): 'default' | 'secondary' | 'destructive' | 'outline' {
  const v = { ready: 'default', resting: 'secondary', disabled: 'destructive' } as const
  return v[getProviderStatus(p) as keyof typeof v] ?? 'outline'
}
function stateLabel(p: any) {
  const s = getProviderStatus(p)
  if (s === 'ready') return t('hswarm.v.providers.statusReady')
  if (s === 'resting') return t('hswarm.v.providers.statusResting')
  if (s === 'disabled') return t('hswarm.v.providers.statusDisabled')
  return t('hswarm.v.providers.statusNoKeys')
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
      <!-- All providers (the tree's Providers row): one table, as the console's; the tree is the provider list -->
      <div v-if="!props.provider" class="flex-1 flex flex-col gap-2 overflow-y-auto">
        <h3 class="font-semibold text-sm">{{ t('hswarm.v.providers.allProviders') }}</h3>
        <div v-if="sortedProviders.length === 0" class="text-xs text-muted-foreground py-4">
          {{ t('hswarm.v.providers.noProviders') }}
        </div>
        <div v-else class="overflow-x-auto rounded-lg border border-border">
          <Table class="text-sm [&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
            <TableHeader>
              <TableRow>
                <TableHead>{{ t('hswarm.v.providers.state') }}</TableHead>
                <TableHead>{{ t('hswarm.v.providers.colProvider') }}</TableHead>
                <TableHead class="text-right">{{ t('hswarm.v.providers.readyKeys') }}</TableHead>
                <TableHead class="text-right">{{ t('hswarm.v.providers.restingKeys') }}</TableHead>
                <TableHead class="text-right">{{ t('hswarm.v.providers.disabledKeys') }}</TableHead>
                <TableHead class="text-right">{{ t('hswarm.v.providers.colKeys') }}</TableHead>
                <TableHead class="w-12">{{ t('hswarm.v.providers.on') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="p in sortedProviders" :key="p.name" :class="{ 'opacity-60': !p.enabled }">
                <TableCell>
                  <Badge :variant="stateVariant(p)" class="text-xs">{{ stateLabel(p) }}</Badge>
                </TableCell>
                <TableCell>
                  <button
                    type="button"
                    class="font-medium text-primary hover:underline"
                    @click="emit('open', ['providers', p.name])"
                  >
                    {{ p.name }}
                  </button>
                </TableCell>
                <TableCell class="text-right font-mono">{{ p.ready ?? 0 }}</TableCell>
                <TableCell class="text-right font-mono">{{ p.resting || 0 }}</TableCell>
                <TableCell class="text-right font-mono">{{ p.disabled || 0 }}</TableCell>
                <TableCell class="text-right font-mono">{{ p.keys }}</TableCell>
                <TableCell>
                  <Switch
                    :model-value="!!p.enabled"
                    :aria-label="t('hswarm.v.providers.useProvider', { name: p.name })"
                    @update:model-value="(v: boolean) => setProviderEnabled(p.name, v)"
                  />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
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
          <div class="flex items-center gap-2 flex-shrink-0">
            <Label class="text-sm">{{ t('hswarm.v.providers.enabled') }}</Label>
            <Switch
              :checked="selectedProviderData.enabled"
              @update:checked="
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
        <Card size="sm">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.providers.keys') }}</CardTitle>
            <CardDescription>{{ t('hswarm.v.providers.keysDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
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
              >
                {{ t('hswarm.v.providers.add') }}
              </Button>
            </div>

            <!-- Keys table -->
            <div v-if="loading && selectedProviderKeys.length === 0" class="text-sm text-muted-foreground">
              {{ t('hswarm.loading') }}
            </div>
            <div
              v-else-if="selectedProviderKeys.length === 0"
              class="text-sm text-muted-foreground py-4"
            >
              {{ t('hswarm.v.providers.noKeysYet') }}
            </div>
            <Table v-else class="text-sm [&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
              <TableHeader>
                <TableRow>
                  <TableHead>{{ t('hswarm.v.providers.key') }}</TableHead>
                  <TableHead>{{ t('hswarm.v.providers.fingerprint') }}</TableHead>
                  <TableHead>{{ t('hswarm.v.providers.priority') }}</TableHead>
                  <TableHead>{{ t('hswarm.v.providers.state') }}</TableHead>
                  <TableHead class="w-16 text-right">
                    {{ t('hswarm.v.providers.actions') }}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="k in shownKeys" :key="k.fingerprint">
                  <TableCell class="font-mono text-xs">{{ k.masked }}</TableCell>
                  <TableCell class="font-mono text-xs">{{ k.fingerprint }}</TableCell>
                  <TableCell>
                    <Input
                      v-if="selectedProviderKeys.length > 1"
                      type="number"
                      :value="k.priority ?? ''"
                      class="w-16 text-xs"
                      :placeholder="t('hswarm.v.providers.noPriority')"
                      @change="
                        (e: Event) => {
                          const v = (e.target as HTMLInputElement).value
                          setKeyPriority(
                            selectedProviderData.name,
                            k.fingerprint,
                            v ? parseInt(v) : null,
                          )
                        }
                      "
                    />
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      v-if="k.disabled"
                      variant="destructive"
                      class="text-xs"
                    >
                      {{ k.free_only ? t('hswarm.v.providers.disabledFree') : t('hswarm.v.providers.disabledKey') }}
                    </Badge>
                    <Badge
                      v-else-if="k.state === 'resting'"
                      variant="secondary"
                      class="text-xs"
                    >
                      {{ t('hswarm.v.providers.resting') }} {{ Math.round(k.resting_s || 0) }}{{ t('hswarm.v.providers.seconds') }}
                    </Badge>
                    <Badge v-else variant="default" class="text-xs">
                      {{ t('hswarm.v.providers.keyReady') }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-right">
                    <div class="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        @click="() => setKeyEnabled(selectedProviderData.name, k.fingerprint, !k.disabled)"
                        :title="k.disabled ? 'Enable' : 'Disable'"
                      >
                        <component
                          :is="k.disabled ? Eye : EyeOff"
                          class="size-4"
                        />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        @click="() => checkKey(selectedProviderData.name, k.fingerprint)"
                        :disabled="loading"
                        :title="t('hswarm.v.providers.checkKeyTitle')"
                      >
                        <CheckCircle2 class="size-4" />
                      </Button>
                      <Button
                        v-if="k.editable"
                        size="sm"
                        variant="ghost"
                        @click="() => removeKey(selectedProviderData.name, k.fingerprint)"
                        :disabled="loading"
                        :title="t('hswarm.v.providers.removeKeyTitle')"
                      >
                        <Trash2 class="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Button
              v-if="selectedProviderKeys.length > FOLD"
              size="sm"
              variant="outline"
              class="mt-2"
              @click="showAllKeys = !showAllKeys"
            >
              {{ showAllKeys ? t('hswarm.v.providers.showFewer') : t('hswarm.v.providers.showAllKeys', { n: selectedProviderKeys.length }) }}
            </Button>

            <!-- Probe button -->
            <div class="pt-2">
              <Button
                variant="outline"
                size="sm"
                @click="() => probeBalance(selectedProviderData.name)"
                :disabled="loading"
              >
                {{ t('hswarm.v.providers.probeBalance') }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Models section -->
        <Card size="sm" v-if="modelsForSelectedProvider.length > 0">
          <CardHeader>
            <CardTitle>{{ t('hswarm.v.providers.models') }}</CardTitle>
            <CardDescription>
              {{ modelsForSelectedProvider.length }}
              {{ t('hswarm.v.providers.modelsAvailable') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table class="text-sm [&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
              <TableHeader>
                <TableRow>
                  <TableHead>{{ t('hswarm.v.providers.name') }}</TableHead>
                  <TableHead>{{ t('hswarm.v.providers.enabled') }}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="m in shownModels" :key="m.name">
                  <TableCell class="font-medium">{{ m.label || m.name }}</TableCell>
                  <TableCell>
                    <Badge v-if="m.enabled" variant="default">
                      {{ t('hswarm.v.providers.on') }}
                    </Badge>
                    <Badge v-else variant="secondary">
                      {{ t('hswarm.v.providers.off') }}
                    </Badge>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Button
              v-if="modelsForSelectedProvider.length > FOLD"
              size="sm"
              variant="outline"
              class="mt-2"
              @click="showAllModels = !showAllModels"
            >
              {{ showAllModels ? t('hswarm.v.providers.showFewer') : t('hswarm.v.providers.showAllModels', { n: modelsForSelectedProvider.length }) }}
            </Button>
          </CardContent>
        </Card>

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
