<script setup lang="ts">
// Login sync (server/src/core/cli-login-sync.ts; owner, 2026-10-01: "point the login manager at my
// cloud thingy, and it manages and syncs my logins between the 2 PCs"). Not set up: join with the
// other PC's pairing code, or point at a new store (its address and access token). Set up: whether
// it runs, when it last synced, every login's state with a switch to leave one out here, what the
// last passes did, and the pairing code to copy to the other PC. CLI and desktop logins are listed
// together, each tagged with its kind. Nothing here shows a login.
import { Cloud, Copy, RefreshCw, Unplug } from '@lucide/vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import InstanceNumber from '@/components/InstanceNumber.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  type CliLoginSyncStatus,
  disconnectLoginSync,
  getLoginSync,
  getLoginSyncPairingCode,
  joinLoginSync,
  runLoginSyncNow,
  setLoginSyncEnabled,
  setLoginSyncExcluded,
  setupLoginSync,
} from '@/lib/api'
import { timeAgo } from '@/lib/format'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const status = ref<CliLoginSyncStatus | null>(null)
const working = ref(false)
const code = ref('')
const url = ref('')
const token = ref('')

async function load() {
  try {
    status.value = await getLoginSync()
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
}

// Fresh while it is open: a pass runs every 30 s on the server.
let timer: number | null = null
watch(
  open,
  (isOpen) => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
    if (!isOpen) return
    code.value = ''
    url.value = ''
    token.value = ''
    void load()
    timer = window.setInterval(() => void load(), 5_000)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
})

async function act(fn: () => Promise<{ ok: boolean; message: string }>) {
  working.value = true
  try {
    const r = await fn()
    if (r.ok) toast.success(r.message)
    else toast.error(r.message)
    await load()
    emit('changed')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    working.value = false
  }
}

const join = () => act(() => joinLoginSync(code.value.trim()))
const setup = () => act(() => setupLoginSync(url.value.trim(), token.value.trim()))
const toggle = (enabled: boolean) => act(() => setLoginSyncEnabled(enabled))
const disconnect = () => act(() => disconnectLoginSync())

async function syncNow() {
  working.value = true
  try {
    const r = await runLoginSyncNow()
    status.value = r.status
    if (r.result.problems.length) toast.error(r.result.problems[0])
    emit('changed')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    working.value = false
  }
}

async function include(id: string, value: boolean) {
  try {
    status.value = await setLoginSyncExcluded(id, !value)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
}

// The toast waits for the write: a "copied" over an empty clipboard is worse than none.
async function copyPairing() {
  try {
    const { code: pairing } = await getLoginSyncPairingCode()
    if (!navigator.clipboard) throw new Error('no clipboard in this context')
    await navigator.clipboard.writeText(pairing)
    toast.success(t('cliInstances.syncPairingCopied'))
  } catch {
    toast.error(t('cliInstances.copyFailed'))
  }
}

type Login = CliLoginSyncStatus['logins'][number]
function stateOf(l: Login): string {
  if (l.excluded) return t('cliInstances.syncStateOut')
  if (l.problem) return l.problem
  if (l.inSync) return t('cliInstances.syncStateInSync')
  if (l.inStore && !l.here) return t('cliInstances.syncStateStoreOnly')
  if (l.here && !l.inStore) return t('cliInstances.syncStateHereOnly')
  return t('cliInstances.syncStatePending')
}
const rows = computed(() =>
  (status.value?.logins ?? []).filter((l) => l.here || l.inStore || l.excluded),
)
const EVENT_KEY: Record<string, string> = {
  pushed: 'cliInstances.syncEventPushed',
  pulled: 'cliInstances.syncEventPulled',
  created: 'cliInstances.syncEventCreated',
  skipped: 'cliInstances.syncEventSkipped',
  error: 'cliInstances.syncEventError',
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Cloud class="size-4" />
          {{ $t('cliInstances.syncTitle') }}
        </DialogTitle>
        <DialogDescription>{{ $t('cliInstances.syncIntro') }}</DialogDescription>
      </DialogHeader>

      <!-- Not set up on this PC: join the other PC's store, or point at a new one. -->
      <div v-if="status && !status.configured" class="flex flex-col gap-4 text-sm">
        <section class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('cliInstances.syncJoinTitle') }}</h4>
          <p class="text-xs text-muted-foreground">{{ $t('cliInstances.syncJoinHint') }}</p>
          <div class="flex items-center gap-1">
            <Input
              v-model="code"
              class="mono"
              autocomplete="off"
              spellcheck="false"
              :placeholder="$t('cliInstances.syncJoinPlaceholder')"
              :disabled="working"
            />
            <Button :disabled="working || !code.trim()" @click="join">
              {{ working ? $t('cliInstances.syncWorking') : $t('cliInstances.syncJoin') }}
            </Button>
          </div>
        </section>
        <section class="flex flex-col gap-1.5 border-t pt-3">
          <h4 class="text-xs font-medium">{{ $t('cliInstances.syncSetupTitle') }}</h4>
          <p class="text-xs text-muted-foreground">{{ $t('cliInstances.syncSetupHint') }}</p>
          <Input
            v-model="url"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('cliInstances.syncUrl')"
            :disabled="working"
          />
          <div class="flex items-center gap-1">
            <Input
              v-model="token"
              type="password"
              autocomplete="off"
              :placeholder="$t('cliInstances.syncToken')"
              :disabled="working"
            />
            <Button
              variant="outline"
              :disabled="working || !url.trim() || !token.trim()"
              @click="setup"
            >
              {{ $t('cliInstances.syncSetup') }}
            </Button>
          </div>
        </section>
      </div>

      <!-- Set up: state, the logins, what happened, and the way to the other PC. -->
      <div v-else-if="status" class="flex flex-col gap-3 text-sm">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label class="flex cursor-pointer items-center gap-2 text-xs">
            <Switch
              :model-value="status.enabled"
              :disabled="working"
              :aria-label="$t('cliInstances.syncOn')"
              @update:model-value="toggle"
            />
            {{ $t('cliInstances.syncOn') }}
          </label>
          <span class="text-xs text-muted-foreground">
            {{ $t('cliInstances.syncStore', { host: status.url ?? '?' }) }}
          </span>
          <span class="text-xs text-muted-foreground">
            {{
              status.lastSyncAt
                ? $t('cliInstances.syncLast', { ago: timeAgo(status.lastSyncAt) })
                : $t('cliInstances.syncNever')
            }}
          </span>
        </div>
        <p v-if="status.lastError" class="text-xs text-destructive">{{ status.lastError }}</p>
        <p class="text-xs text-muted-foreground">{{ $t('cliInstances.syncDesktopNote') }}</p>

        <div class="max-h-56 overflow-y-auto rounded-md border">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th class="px-2 py-1 text-start font-medium">{{ $t('cliInstances.syncColLogin') }}</th>
                <th class="px-2 py-1 text-start font-medium">{{ $t('cliInstances.syncColState') }}</th>
                <th class="px-2 py-1 text-end font-medium">{{ $t('cliInstances.syncColSync') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in rows" :key="l.id" class="border-t">
                <td class="px-2 py-1">
                  <span class="flex items-center gap-1.5">
                    <InstanceNumber :num="l.num ?? 0" />
                    <span class="truncate">{{ l.name }}</span>
                    <span class="rounded border px-1 text-3xs text-muted-foreground">
                      {{
                        l.kind === 'desktop'
                          ? $t('cliInstances.syncKindDesktop')
                          : $t('cliInstances.syncKindCli')
                      }}
                    </span>
                  </span>
                </td>
                <td class="px-2 py-1 text-muted-foreground">{{ stateOf(l) }}</td>
                <td class="px-2 py-1 text-end">
                  <Switch
                    :model-value="!l.excluded"
                    :aria-label="$t('cliInstances.syncInclude')"
                    @update:model-value="(v: boolean) => include(l.id, v)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="status.events.length" class="flex flex-col gap-0.5 text-xs">
          <span class="font-medium">{{ $t('cliInstances.syncRecent') }}</span>
          <span
            v-for="(e, i) in status.events.slice(0, 6)"
            :key="i"
            class="text-muted-foreground"
          >
            {{ timeAgo(e.at) }} · {{ e.num ? `#${e.num}` : '' }} {{ $t(EVENT_KEY[e.action] ?? e.action) }}:
            {{ e.note }}
          </span>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" :disabled="working" @click="disconnect">
            <Unplug /> {{ $t('cliInstances.syncDisconnect') }}
          </Button>
          <Button variant="outline" size="sm" :disabled="working" @click="copyPairing">
            <Copy /> {{ $t('cliInstances.syncPairing') }}
          </Button>
          <Button size="sm" :disabled="working || !status.enabled" @click="syncNow">
            <RefreshCw :class="working ? 'animate-spin' : ''" /> {{ $t('cliInstances.syncNow') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
