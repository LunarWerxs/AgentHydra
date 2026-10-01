<script setup lang="ts">
// Login sync (server/src/core/cli-login-sync.ts; owner, 2026-10-01: "point the login manager at my
// cloud thingy, and it manages and syncs my logins between the 2 PCs"). Not set up: join with the
// other PC's pairing code, or point at a new store (its address and access token). Set up: one row
// of controls (on/off, last sync, how many are in sync, Sync now), every login as one line with a
// short state and a switch to leave it out here, what the last passes did, and the pairing code to
// copy to the other PC. A state's sentence is its hover title, never a paragraph in the row (owner,
// 2026-10-01: "verbose as FUCK"). CLI and desktop logins are listed together, each tagged with its
// kind. Nothing here shows a login.
import { Cloud, Copy, RefreshCw, Unplug } from '@lucide/vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import InstanceNumber from '@/components/InstanceNumber.vue'
import { Badge } from '@/components/ui/badge'
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
const NOTE_KEY: Record<NonNullable<Login['note']>, string> = {
  own: 'cliInstances.syncStateOwn',
  waiting: 'cliInstances.syncStateWaiting',
  fed: 'cliInstances.syncStateFed',
}
/** A row's state: a word or two on the row, the sentence behind it on hover. Left out first (it is
 *  what the row's switch says), then what sync leaves alone by design, then a real error. */
function stateOf(l: Login): { label: string; title: string; bad: boolean } {
  const plain = (key: string) => ({ label: t(key), title: t(`${key}Hint`), bad: false })
  if (l.excluded) return plain('cliInstances.syncStateOut')
  if (l.note) return plain(NOTE_KEY[l.note])
  if (l.problem) return { label: t('cliInstances.syncStateProblem'), title: l.problem, bad: true }
  if (l.inSync) return plain('cliInstances.syncStateInSync')
  if (l.inStore && !l.here) return plain('cliInstances.syncStateStoreOnly')
  if (l.here && !l.inStore) return plain('cliInstances.syncStateHereOnly')
  return plain('cliInstances.syncStatePending')
}
const failing = (l: Login) => !l.excluded && !l.note && !!l.problem
/** Every login this PC or the store knows, the ones that cannot sync first. */
const rows = computed(() =>
  (status.value?.logins ?? [])
    .filter((l) => l.here || l.inStore || l.excluded)
    .map((l) => ({ login: l, state: stateOf(l) }))
    .sort((a, b) => Number(failing(b.login)) - Number(failing(a.login))),
)
/** "X of Y in sync": Y is the logins that take part, so not the left-out ones, nor the ones sync
 *  leaves alone for good (signed in separately here, or fed by a desktop login that syncs itself). */
const syncCount = computed(() => {
  const taking = rows.value
    .map((r) => r.login)
    .filter((l) => !l.excluded && l.note !== 'own' && l.note !== 'fed')
  return { n: taking.filter((l) => l.inSync).length, total: taking.length }
})

const EVENT_KEY: Record<string, string> = {
  pushed: 'cliInstances.syncEventPushed',
  pulled: 'cliInstances.syncEventPulled',
  created: 'cliInstances.syncEventCreated',
  skipped: 'cliInstances.syncEventSkipped',
  error: 'cliInstances.syncEventError',
}
/** What the last passes did, newest first: the same action within a minute is one line
 *  ("18m ago · uploaded #56 #14 #59"), four lines at most. */
const recent = computed(() => {
  const groups: Array<{ at: number; action: string; nums: number[]; notes: string[] }> = []
  for (const e of status.value?.events ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.action === e.action && last.at - e.at <= 60_000) {
      if (e.num !== null && !last.nums.includes(e.num)) last.nums.push(e.num)
      if (!last.notes.includes(e.note)) last.notes.push(e.note)
    } else {
      groups.push({
        at: e.at,
        action: e.action,
        nums: e.num === null ? [] : [e.num],
        notes: [e.note],
      })
    }
  }
  return groups.slice(0, 4)
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          <span class="flex items-center gap-2">
            <Cloud class="size-4" />
            {{ $t('cliInstances.syncTitle') }}
          </span>
        </DialogTitle>
        <DialogDescription>{{ $t('cliInstances.syncIntro') }}</DialogDescription>
      </DialogHeader>

      <!-- Not set up on this PC: join the other PC's store, or point at a new one. -->
      <div v-if="status && !status.configured" class="flex flex-col gap-4">
        <section class="flex flex-col gap-1.5">
          <h4 class="font-medium">{{ $t('cliInstances.syncJoinTitle') }}</h4>
          <p class="text-muted-foreground">{{ $t('cliInstances.syncJoinHint') }}</p>
          <div class="flex items-center gap-1">
            <div class="mono min-w-0 flex-1">
              <Input
                v-model="code"
                autocomplete="off"
                spellcheck="false"
                :placeholder="$t('cliInstances.syncJoinPlaceholder')"
                :disabled="working"
              />
            </div>
            <Button :disabled="working || !code.trim()" @click="join">
              {{ working ? $t('cliInstances.syncWorking') : $t('cliInstances.syncJoin') }}
            </Button>
          </div>
        </section>
        <section class="flex flex-col gap-1.5 border-t pt-3">
          <h4 class="font-medium">{{ $t('cliInstances.syncSetupTitle') }}</h4>
          <p class="text-muted-foreground">{{ $t('cliInstances.syncSetupHint') }}</p>
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

      <!-- Set up: the controls, the logins, what happened, and the way to the other PC. No height
           cap in here: the dialog itself scrolls when the list is long. -->
      <div v-else-if="status" class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label class="flex cursor-pointer items-center gap-2 font-medium">
            <Switch
              :model-value="status.enabled"
              :disabled="working"
              :aria-label="$t('cliInstances.syncOn')"
              @update:model-value="toggle"
            />
            {{ $t('cliInstances.syncOn') }}
          </label>
          <span class="text-muted-foreground">
            {{
              status.lastSyncAt
                ? $t('cliInstances.syncLast', { ago: timeAgo(status.lastSyncAt) })
                : $t('cliInstances.syncNever')
            }}
          </span>
          <span class="tabular-nums text-muted-foreground">
            {{ $t('cliInstances.syncCount', syncCount) }}
          </span>
          <Button
            size="sm"
            class="ms-auto"
            :disabled="working || !status.enabled"
            :aria-busy="working"
            @click="syncNow"
          >
            <RefreshCw :class="working ? 'animate-spin' : ''" /> {{ $t('cliInstances.syncNow') }}
          </Button>
        </div>
        <p v-if="status.lastError" class="text-destructive">{{ status.lastError }}</p>
        <p class="text-muted-foreground">{{ $t('cliInstances.syncDesktopNote') }}</p>

        <ul
          v-if="rows.length"
          class="flex flex-col divide-y rounded-md border"
          :aria-label="$t('cliInstances.syncLogins')"
        >
          <li v-for="{ login: l, state } in rows" :key="l.id" class="flex items-center gap-2 px-2 py-1.5">
            <InstanceNumber :num="l.num ?? 0" />
            <span class="min-w-0 flex-1 truncate" :title="l.name">{{ l.name }}</span>
            <Badge variant="outline">
              {{
                l.kind === 'desktop'
                  ? $t('cliInstances.syncKindDesktop')
                  : $t('cliInstances.syncKindCli')
              }}
            </Badge>
            <span
              class="w-24 shrink-0 truncate text-end"
              :class="state.bad ? 'text-destructive' : 'text-muted-foreground'"
              :title="state.title"
            >
              {{ state.label }}
            </span>
            <Switch
              :model-value="!l.excluded"
              :aria-label="$t('cliInstances.syncInclude')"
              @update:model-value="(v: boolean) => include(l.id, v)"
            />
          </li>
        </ul>

        <div v-if="recent.length" class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium">{{ $t('cliInstances.syncRecent') }}</span>
          <span
            v-for="(g, i) in recent"
            :key="i"
            class="truncate text-muted-foreground"
            :title="g.notes.join(' ')"
          >
            {{ timeAgo(g.at) }} · {{ $t(EVENT_KEY[g.action] ?? g.action) }}
            {{ g.nums.length ? g.nums.map((n) => `#${n}`).join(' ') : g.notes[0] }}
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 border-t pt-3">
          <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="status.url ?? undefined">
            {{ $t('cliInstances.syncStore', { host: status.url ?? '?' }) }}
          </span>
          <Button variant="outline" size="sm" :disabled="working" @click="copyPairing">
            <Copy /> {{ $t('cliInstances.syncPairing') }}
          </Button>
          <Button variant="ghost" size="sm" :disabled="working" @click="disconnect">
            <Unplug /> {{ $t('cliInstances.syncDisconnect') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
