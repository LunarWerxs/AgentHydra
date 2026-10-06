<script setup lang="ts">
import { AlertCircle, RotateCw } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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

// The HSwarm tab's clients view. Strings: i18n/locales/en/hswarm/clients.ts (t('hswarm.v.clients.<key>')).

interface Client {
  client: string
  config: string
  exists: boolean
  registered: boolean
}

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// client: set when the HSwarm tree picked one client; the table shows only that one.
const props = defineProps<{ state: HswarmState; client?: string }>()
// changed: a client was registered or removed, so the HSwarm tree refreshes its client dots.
const emit = defineEmits<{ changed: [] }>()

const clients = ref<Client[]>([])
const loading = ref(false)
const shownClients = computed(() =>
  props.client ? clients.value.filter((c) => c.client === props.client) : clients.value,
)
const error = ref<string | null>(null)
const installLog = ref<string>('')
const includeInstructions = ref(false)
const installing = ref(new Set<string>())

const clientInfo: Record<string, { label: string; description: string }> = {
  'claude-code': {
    label: 'Claude Code',
    description: 'The terminal CLI, VS Code / JetBrains extensions, and desktop app Code tab',
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    description: 'Claude desktop app chat. Restart after installing.',
  },
  codex: {
    label: 'Codex',
    description: 'Codex CLI, IDE extension, and desktop app',
  },
}

async function loadClients() {
  loading.value = true
  error.value = null
  try {
    const data = await apiCall('clients')
    clients.value = data.clients || []
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load clients'
  } finally {
    loading.value = false
  }
}

async function installClient(client: string, remove: boolean = false) {
  installing.value.add(client)
  installLog.value = ''

  try {
    const data = await apiCall('clients/install', {
      method: 'POST',
      body: JSON.stringify({
        client,
        remove,
        instructions: includeInstructions.value,
      }),
    })

    clients.value = data.clients || []
    installLog.value = `${(data.log || []).join('\n')}\n\nRestart the client (or open a new chat) to pick it up.`
    toast.success(remove ? t('hswarm.v.clients.removed') : t('hswarm.v.clients.installed'))
    emit('changed')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Installation failed')
    installLog.value = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  } finally {
    installing.value.delete(client)
  }
}

function getStatus(client: Client) {
  if (client.registered === null) return t('hswarm.v.clients.checking')
  if (client.registered) return t('hswarm.v.clients.registered')
  return t('hswarm.v.clients.notRegistered')
}

function getStatusClass(client: Client) {
  if (client.registered === null)
    return 'bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200'
  if (client.registered) return 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200'
  return 'bg-gray-50 text-gray-900 dark:bg-gray-800 dark:text-gray-200'
}

function confirmRemove(client: Client) {
  const label = clientInfo[client.client]?.label || client.client
  if (window.confirm(t('hswarm.v.clients.removeConfirm', { client: label }))) {
    installClient(client.client, true)
  }
}

onMounted(() => {
  loadClients()
})
</script>

<template>
  <div class="flex flex-col gap-3 px-5 py-3">
    <!-- Section: Instructions checkbox -->
    <Card size="sm">
      <CardHeader>
        <CardTitle>{{ t('hswarm.v.clients.title') }}</CardTitle>
        <CardDescription>{{ t('hswarm.v.clients.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <!-- Instructions checkbox -->
        <label class="flex cursor-pointer items-center gap-2">
          <input v-model="includeInstructions" type="checkbox" class="size-4 accent-current" />
          <span>{{ t('hswarm.v.clients.includeInstructions') }}</span>
        </label>
        <p class="text-xs text-muted-foreground">
          {{ t('hswarm.v.clients.instructionsHelp') }}
        </p>
      </CardContent>
    </Card>

    <!-- Error state -->
    <Alert v-if="error" variant="destructive">
      <AlertCircle class="size-4" />
      <AlertTitle>{{ t('hswarm.v.clients.loadError') }}</AlertTitle>
      <AlertDescription>{{ error }}</AlertDescription>
      <Button
        size="sm"
        variant="outline"
        class="mt-2"
        @click="loadClients"
      >
        {{ t('hswarm.refresh') }}
      </Button>
    </Alert>

    <!-- Clients table -->
    <Card size="sm" v-if="!loading && !error">
      <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle>{{ t('hswarm.v.clients.agents') }}</CardTitle>
        </div>
        <Button
          size="sm"
          variant="outline"
          :disabled="loading"
          @click="loadClients"
        >
          <RotateCw :class="{ 'animate-spin': loading }" class="size-4" />
          <span class="hidden sm:inline ms-1">{{ t('hswarm.refresh') }}</span>
        </Button>
      </CardHeader>
      <CardContent>
        <div class="border rounded-lg overflow-hidden">
          <Table class="[&_td]:py-1 [&_th]:h-8 [&_th]:py-0">
            <TableHeader>
              <TableRow>
                <TableHead>{{ t('hswarm.v.clients.client') }}</TableHead>
                <TableHead>{{ t('hswarm.v.clients.status') }}</TableHead>
                <TableHead>{{ t('hswarm.v.clients.configFile') }}</TableHead>
                <TableHead class="text-end">{{ t('hswarm.v.clients.actions') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="client in shownClients" :key="client.client">
                <TableCell>
                  <div class="font-medium">{{ clientInfo[client.client]?.label || client.client }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ clientInfo[client.client]?.description }}
                  </div>
                </TableCell>
                <TableCell>
                  <div
                    :class="`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusClass(client)}`"
                  >
                    {{ getStatus(client) }}
                  </div>
                </TableCell>
                <TableCell>
                  <div class="text-xs font-mono text-muted-foreground">{{ client.config }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ client.exists ? t('hswarm.v.clients.exists') : t('hswarm.v.clients.notExists') }}
                  </div>
                </TableCell>
                <TableCell class="text-end space-x-2">
                  <Button
                    size="sm"
                    :variant="client.registered ? 'outline' : 'default'"
                    :disabled="installing.has(client.client)"
                    @click="installClient(client.client)"
                  >
                    {{ client.registered ? t('hswarm.v.clients.reinstall') : t('hswarm.v.clients.install') }}
                  </Button>
                  <Button
                    v-if="client.registered"
                    size="sm"
                    variant="destructive"
                    :disabled="installing.has(client.client)"
                    @click="confirmRemove(client)"
                  >
                    {{ t('hswarm.v.clients.remove') }}
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center py-4">
      <div class="text-muted-foreground">{{ t('hswarm.loading') }}</div>
    </div>

    <!-- Install log -->
    <Card size="sm" v-if="installLog">
      <CardHeader>
        <CardTitle class="text-sm">{{ t('hswarm.v.clients.installLog') }}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre class="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">{{ installLog }}</pre>
      </CardContent>
    </Card>

    <!-- API Documentation section -->
    <Card size="sm">
      <CardHeader>
        <CardTitle class="text-sm">{{ t('hswarm.v.clients.apiTitle') }}</CardTitle>
        <CardDescription>{{ t('hswarm.v.clients.apiDescription') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <!-- i18n-ignore -->
        <pre class="bg-muted p-4 rounded-lg text-xs overflow-auto" v-pre>TOKEN=$(cat ~/.hswarm/console-token)
curl -s -H "X-Hswarm-Token: $TOKEN" http://127.0.0.1:7793/api/clients
curl -s -H "X-Hswarm-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"client":"claude-code","instructions":false}' \
  http://127.0.0.1:7793/api/clients/install</pre>
      </CardContent>
    </Card>
  </div>
</template>
