<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHswarmApi } from '@/lib/hswarm-api'

// Where this machine's API keys live: always the folder (HSWARM_HOME/secrets); optionally also an encrypted vault on a store
// several machines share. Every call goes to the local console; a pairing code is typed here and sent, never shown or kept.
const { t } = useI18n()
const { apiCall } = useHswarmApi()
const emit = defineEmits<{ changed: [] }>()

interface VaultStatus {
  mode: 'folder' | 'vault'
  folder: { path: string; lists: Record<string, number>; keys: number }
  backend?: string
  machine?: string
  last_sync?: string | null
  vault?: { keys: number; lists: number; rev: number } | null
  vault_error?: string | null
  pending_requests?: number
  request?: { machine?: string; fingerprint?: string; granted?: string; error?: string }
  adopt?: string
}
interface PendingRequest {
  machine: string
  at?: string
  fingerprint?: string
  granted: boolean
  error?: string
}

const status = ref<VaultStatus | null>(null)
const requests = ref<PendingRequest[]>([])
const busy = ref(false)
const panel = ref<'init' | 'join' | 'request' | null>(null)
const kind = ref<'ssh' | 'dir'>('ssh')
const backend = ref({ host: '', user: '', port: '', folder: '', path: '' })
const code = ref('')
const typedFingerprint = ref<Record<string, string>>({})

const inVault = computed(() => status.value?.mode === 'vault')

async function load() {
  try {
    status.value = await apiCall('vault/status')
    requests.value =
      inVault.value && (status.value?.pending_requests ?? 0) > 0
        ? (await apiCall('vault/requests')).requests
        : []
  } catch (error) {
    toast.error(
      `${t('hswarm.v.providers.storage.loadError')}: ${error instanceof Error ? error.message : ''}`,
    )
  }
}

// One guarded call: the server's error text is the toast; the page reloads either way.
async function run(route: string, body: Record<string, unknown>, okMessage: string) {
  busy.value = true
  try {
    const out = await apiCall(route, { method: 'POST', body: JSON.stringify(body) })
    toast.success(okMessage)
    emit('changed')
    return out
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('hswarm.v.providers.storage.failed'))
    return null
  } finally {
    busy.value = false
    await load()
  }
}

function backendBody() {
  const b = backend.value
  return kind.value === 'ssh'
    ? { kind: 'ssh', host: b.host, user: b.user, port: b.port, folder: b.folder }
    : { kind: 'dir', path: b.path }
}

async function setUp() {
  const out = await run('vault/init', backendBody(), t('hswarm.v.providers.storage.initDone'))
  if (out) panel.value = null
}

async function join() {
  const body = { code: code.value }
  code.value = '' // gone from the page before the call returns, win or lose
  const out = await run('vault/join', body, t('hswarm.v.providers.storage.joinDone'))
  if (out) panel.value = null
}

async function askAccess() {
  const out = await run('vault/request', backendBody(), t('hswarm.v.providers.storage.requestDone'))
  if (out) panel.value = null
}

async function checkGrant() {
  busy.value = true
  try {
    const out = await apiCall('vault/accept', { method: 'POST', body: '{}' })
    if (out.granted) {
      toast.success(t('hswarm.v.providers.storage.joinDone'))
      emit('changed')
    } else {
      toast.info(t('hswarm.v.providers.storage.notGrantedYet'))
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('hswarm.v.providers.storage.failed'))
  } finally {
    busy.value = false
    await load()
  }
}

async function grant(r: PendingRequest) {
  const fingerprint = typedFingerprint.value[r.machine] ?? ''
  if (
    await run(
      'vault/grant',
      { machine: r.machine, fingerprint },
      t('hswarm.v.providers.storage.grantDone', { machine: r.machine }),
    )
  ) {
    typedFingerprint.value[r.machine] = ''
  }
}

async function leave() {
  if (!confirm(t('hswarm.v.providers.storage.confirmLeave'))) return
  await run('vault/leave', { confirm: true }, t('hswarm.v.providers.storage.leaveDone'))
}

onMounted(load)
</script>

<template>
  <Card size="sm" class="shrink-0">
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        {{ t('hswarm.v.providers.storage.title') }}
        <Badge v-if="status" :variant="inVault ? 'default' : 'secondary'" class="text-xs">
          {{ inVault ? t('hswarm.v.providers.storage.modeVault') : t('hswarm.v.providers.storage.modeFolder') }}
        </Badge>
      </CardTitle>
      <CardDescription>{{ t('hswarm.v.providers.storage.desc') }}</CardDescription>
    </CardHeader>
    <CardContent v-if="status" class="space-y-3 text-sm">
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.folder') }}</span>
        <span class="font-mono break-all">
          {{ status.folder.path }}
          <span class="text-muted-foreground">({{ t('hswarm.v.providers.storage.keyCount', { n: status.folder.keys }) }})</span>
        </span>
        <template v-if="inVault">
          <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.backend') }}</span>
          <span class="font-mono break-all">{{ status.backend }}</span>
          <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.machine') }}</span>
          <span>{{ status.machine }}</span>
          <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.lastSync') }}</span>
          <span>{{ status.last_sync || t('hswarm.v.providers.storage.never') }}</span>
          <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.inVault') }}</span>
          <span>{{ status.vault ? t('hswarm.v.providers.storage.keyCount', { n: status.vault.keys }) : '—' }}</span>
          <span class="text-muted-foreground">{{ t('hswarm.v.providers.storage.pending') }}</span>
          <span>{{ status.pending_requests ?? 0 }}</span>
        </template>
      </div>
      <p v-if="status.vault_error" class="text-destructive wrap-break-word">{{ status.vault_error }}</p>

      <!-- This machine asked a vault for access and waits for the grant -->
      <div v-if="status.request && !inVault" class="rounded-md border border-border p-2 space-y-1">
        <p v-if="status.request.error" class="text-destructive wrap-break-word">{{ status.request.error }}</p>
        <template v-else>
          <p>{{ t('hswarm.v.providers.storage.requestWaiting') }}</p>
          <p>
            {{ t('hswarm.v.providers.storage.machine') }}: <span class="font-mono">{{ status.request.machine }}</span>
            · {{ t('hswarm.v.providers.storage.fingerprint') }}: <span class="font-mono">{{ status.request.fingerprint }}</span>
          </p>
          <Button size="sm" :disabled="busy" @click="checkGrant">{{ t('hswarm.v.providers.storage.checkGrant') }}</Button>
        </template>
      </div>

      <!-- Vault machine: who is asking -->
      <div v-if="inVault && requests.length" class="space-y-2">
        <h4 class="font-semibold">{{ t('hswarm.v.providers.storage.requests') }}</h4>
        <div v-for="r in requests" :key="r.machine" class="rounded-md border border-border p-2 space-y-1">
          <p>
            <span class="font-mono">{{ r.machine }}</span>
            <span class="text-muted-foreground"> · {{ r.at || '—' }} · </span>
            <span class="font-mono">{{ r.fingerprint || r.error }}</span>
            <Badge v-if="r.granted" variant="secondary" class="ms-2 text-xs">{{ t('hswarm.v.providers.storage.granted') }}</Badge>
          </p>
          <div v-if="!r.error && !r.granted" class="flex items-center gap-2">
            <Input
              v-model="typedFingerprint[r.machine]"
              class="font-mono max-w-64"
              autocomplete="off"
              :aria-label="t('hswarm.v.providers.storage.fullFingerprint')"
              :placeholder="t('hswarm.v.providers.storage.fullFingerprint')"
            />
            <Button size="sm" :disabled="busy || !typedFingerprint[r.machine]" @click="grant(r)">
              {{ t('hswarm.v.providers.storage.grant') }}
            </Button>
          </div>
          <p v-if="!r.error && !r.granted" class="text-xs text-muted-foreground">{{ t('hswarm.v.providers.storage.grantHint') }}</p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex flex-wrap gap-2">
        <template v-if="inVault">
          <Button size="sm" :disabled="busy" @click="run('vault/sync', {}, t('hswarm.v.providers.storage.syncDone'))">
            {{ t('hswarm.v.providers.storage.sync') }}
          </Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="leave">{{ t('hswarm.v.providers.storage.leave') }}</Button>
        </template>
        <template v-else>
          <Button size="sm" variant="outline" @click="panel = panel === 'init' ? null : 'init'">{{ t('hswarm.v.providers.storage.setUp') }}</Button>
          <Button size="sm" variant="outline" @click="panel = panel === 'join' ? null : 'join'">{{ t('hswarm.v.providers.storage.join') }}</Button>
          <Button size="sm" variant="outline" @click="panel = panel === 'request' ? null : 'request'">{{ t('hswarm.v.providers.storage.request') }}</Button>
          <Button
            v-if="status.adopt"
            size="sm"
            variant="outline"
            :disabled="busy"
            :title="status.adopt"
            @click="run('vault/adopt', {}, t('hswarm.v.providers.storage.adoptDone'))"
          >
            {{ t('hswarm.v.providers.storage.adopt') }}
          </Button>
        </template>
      </div>
      <p v-if="!inVault && !panel" class="text-xs text-muted-foreground">{{ t('hswarm.v.providers.storage.folderOnly') }}</p>

      <!-- Set up / ask: where the vault is -->
      <div v-if="!inVault && (panel === 'init' || panel === 'request')" class="space-y-2">
        <p class="text-xs text-muted-foreground">{{ t('hswarm.v.providers.storage.ciphertext') }}</p>
        <div class="flex gap-2">
          <Button size="sm" :variant="kind === 'ssh' ? 'default' : 'outline'" @click="kind = 'ssh'">{{ t('hswarm.v.providers.storage.kindSsh') }}</Button>
          <Button size="sm" :variant="kind === 'dir' ? 'default' : 'outline'" @click="kind = 'dir'">{{ t('hswarm.v.providers.storage.kindDir') }}</Button>
        </div>
        <div v-if="kind === 'ssh'" class="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div class="space-y-1"><Label for="vs-host">{{ t('hswarm.v.providers.storage.host') }}</Label><Input id="vs-host" v-model="backend.host" :placeholder="t('hswarm.v.providers.storage.phHost')" /></div>
          <div class="space-y-1"><Label for="vs-user">{{ t('hswarm.v.providers.storage.user') }}</Label><Input id="vs-user" v-model="backend.user" :placeholder="t('hswarm.v.providers.storage.phUser')" /></div>
          <div class="space-y-1"><Label for="vs-port">{{ t('hswarm.v.providers.storage.port') }}</Label><Input id="vs-port" v-model="backend.port" placeholder="22" /></div>
          <div class="space-y-1"><Label for="vs-folder">{{ t('hswarm.v.providers.storage.remoteFolder') }}</Label><Input id="vs-folder" v-model="backend.folder" :placeholder="t('hswarm.v.providers.storage.phFolder')" /></div>
        </div>
        <div v-else class="space-y-1">
          <Label for="vs-path">{{ t('hswarm.v.providers.storage.syncedFolder') }}</Label>
          <Input id="vs-path" v-model="backend.path" :placeholder="t('hswarm.v.providers.storage.phPath')" />
        </div>
        <Button size="sm" :disabled="busy" @click="panel === 'init' ? setUp() : askAccess()">
          {{ panel === 'init' ? t('hswarm.v.providers.storage.createVault') : t('hswarm.v.providers.storage.sendRequest') }}
        </Button>
      </div>

      <!-- Join with a pairing code: typed, sent to the local console, then dropped -->
      <form v-if="!inVault && panel === 'join'" class="space-y-2" autocomplete="off" @submit.prevent="join">
        <Label for="vs-code">{{ t('hswarm.v.providers.storage.pairingCode') }}</Label>
        <Input id="vs-code" v-model="code" type="password" autocomplete="off" class="font-mono max-w-xl" :placeholder="t('hswarm.v.providers.storage.phCode')" />
        <Button size="sm" type="submit" :disabled="busy || !code">{{ t('hswarm.v.providers.storage.joinVault') }}</Button>
      </form>
    </CardContent>
  </Card>
</template>
