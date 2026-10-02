<script setup lang="ts">
// Login sync (server/src/core/cli-login-sync.ts; owner, 2026-10-01: "point the login manager at my
// cloud thingy, and it manages and syncs my logins between the 2 PCs"). Not set up: join with the
// other PC's pairing code, or point at a new store (its address and access token). Set up: ONE
// switch, "Sync all", on by default, beside how many logins are in sync and Sync now (owner,
// 2026-10-01: "there just needs to be a check button that says Sync All, and if I turn that off,
// then it can show me the giant list"). While it is on the list stays away, except for a login that
// cannot sync; turned off, every login is one line with a short state and a switch to leave it out
// here, and what the last passes did. Every explanation is behind an info bubble, never a paragraph
// (owner, 2026-10-01: "verbose as FUCK", then "give it one of those little info bubbles"). CLI and
// desktop logins are listed together, each tagged with its kind. Nothing here shows a login.
import { Cloud, Copy, LoaderCircle, Pause, Play, RefreshCw, Unplug } from '@lucide/vue'
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
  type CliLoginSyncStatusQueue,
  disconnectLoginSync,
  getLoginSync,
  getLoginSyncPairingCode,
  joinLoginSync,
  runLoginSyncNow,
  setLoginSyncEnabled,
  setLoginSyncExcluded,
  setLoginSyncQueue,
  setupLoginSync,
} from '@/lib/api'
import { timeAgo } from '@/lib/format'
import InfoHint from '@/shell/InfoHint.vue'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const status = ref<CliLoginSyncStatusQueue | null>(null)
/** The owner turned "Sync all" off to choose logins; the list is open until it is turned back on. */
const choosing = ref(false)
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
    choosing.value = false
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

/** On while nothing is left out and the list is not open: the default, and what a fresh join is. */
const syncAll = computed(
  () => !choosing.value && !(status.value?.logins ?? []).some((l) => l.excluded),
)
/** Off opens the list. On takes every left-out login back in, then closes it. */
async function setSyncAll(on: boolean) {
  if (!on) {
    choosing.value = true
    return
  }
  working.value = true
  try {
    for (const l of (status.value?.logins ?? []).filter((x) => x.excluded))
      status.value = await setLoginSyncExcluded(l.id, false)
    choosing.value = false
    emit('changed')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    working.value = false
  }
}

async function setShareQueue(on: boolean) {
  working.value = true
  try {
    status.value = await setLoginSyncQueue(on)
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

type Login = CliLoginSyncStatusQueue['logins'][number]
const NOTE_KEY: Record<NonNullable<Login['note']>, [string, string]> = {
  own: ['cliInstances.syncStateOwn', 'cliInstances.syncStateOwnHint'],
  waiting: ['cliInstances.syncStateWaiting', 'cliInstances.syncStateWaitingHint'],
  fed: ['cliInstances.syncStateFed', 'cliInstances.syncStateFedHint'],
}
/** A row's state: a word or two on the row, the sentence behind it on hover. Left out first (it is
 *  what the row's switch says), then what sync leaves alone by design, then a real error. */
function stateOf(l: Login): { label: string; title: string; bad: boolean } {
  // The hint key is spelled out, not built from the label's, so the i18n check sees it used.
  const plain = (key: string, hint: string) => ({ label: t(key), title: t(hint), bad: false })
  if (l.excluded) return plain('cliInstances.syncStateOut', 'cliInstances.syncStateOutHint')
  if (l.note) return plain(...NOTE_KEY[l.note])
  if (l.problem) return { label: t('cliInstances.syncStateProblem'), title: l.problem, bad: true }
  if (l.inSync) return plain('cliInstances.syncStateInSync', 'cliInstances.syncStateInSyncHint')
  // While sync runs, a login that is not there yet is on its way; the row says which way on hover.
  // "Only in the store" on every row right after a join read as "did it work or not?".
  const coming = status.value?.enabled ? 'cliInstances.syncStateOnTheWay' : null
  if (l.inStore && !l.here)
    return coming
      ? { label: t(coming), title: t('cliInstances.syncStateStoreOnlyHint'), bad: false }
      : plain('cliInstances.syncStateStoreOnly', 'cliInstances.syncStateStoreOnlyHint')
  if (l.here && !l.inStore)
    return coming
      ? { label: t(coming), title: t('cliInstances.syncStateHereOnlyHint'), bad: false }
      : plain('cliInstances.syncStateHereOnly', 'cliInstances.syncStateHereOnlyHint')
  return plain('cliInstances.syncStatePending', 'cliInstances.syncStatePendingHint')
}
/** The desktop sentence is only for someone who has a desktop login in the list. */
const hasDesktop = computed(() => rows.value.some((r) => r.login.kind === 'desktop'))
const failing = (l: Login) => !l.excluded && !l.note && !!l.problem
/** Every login this PC or the store knows, the ones that cannot sync first. */
const rows = computed(() =>
  (status.value?.logins ?? [])
    .filter((l) => l.here || l.inStore || l.excluded)
    .map((l) => ({ login: l, state: stateOf(l) }))
    .sort((a, b) => Number(failing(b.login)) - Number(failing(a.login))),
)
/** What the dialog lists: every login once the owner chooses, else only the ones that cannot sync. */
const shown = computed(() =>
  syncAll.value ? rows.value.filter((r) => failing(r.login)) : rows.value,
)
/** "X of Y in sync": Y is the logins that take part, so not the left-out ones, nor the ones sync
 *  leaves alone for good (signed in separately here, or fed by a desktop login that syncs itself). */
const syncCount = computed(() => {
  const taking = rows.value
    .map((r) => r.login)
    .filter((l) => !l.excluded && l.note !== 'own' && l.note !== 'fed')
  const n = taking.filter((l) => l.inSync).length
  // Still on their way: taking part, not there yet, and nothing wrong with them. Sync brings them
  // in by itself, so the dialog says so instead of leaving a half-full count to be read as stuck.
  const arriving = taking.filter((l) => !l.inSync && !l.problem).length
  return { n, total: taking.length, arriving }
})
/** Sync is on and has logins left to bring in (or has not finished its first pass). */
const syncing = computed(
  () => !!status.value?.enabled && (syncCount.value.arriving > 0 || !status.value.lastSyncAt),
)

/** The one status line: paused, or how many are in sync and when the last pass ran. */
const statusLine = computed(() => {
  const s = status.value
  if (!s) return ''
  if (!s.enabled) return t('cliInstances.syncPaused')
  const count =
    syncing.value && syncCount.value.arriving > 0
      ? t('cliInstances.syncCountArriving', syncCount.value)
      : t('cliInstances.syncCount', syncCount.value)
  const last = s.lastSyncAt
    ? t('cliInstances.syncLast', { ago: timeAgo(s.lastSyncAt) })
    : t('cliInstances.syncFirst')
  return `${count} · ${last}`
})
/** What "Sync all" means; with a desktop login in the list, also the one thing not to do with it. */
const syncAllHint = computed(() =>
  [t('cliInstances.syncAllHint'), hasDesktop.value ? t('cliInstances.syncDesktopNote') : '']
    .filter(Boolean)
    .join(' '),
)

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
            <InfoHint :text="$t('cliInstances.syncIntro')" />
          </span>
        </DialogTitle>
        <DialogDescription class="sr-only">{{ $t('cliInstances.syncIntro') }}</DialogDescription>
      </DialogHeader>

      <!-- Not set up on this PC: join the other PC's store, or point at a new one. -->
      <div v-if="status && !status.configured" class="flex flex-col gap-4">
        <section class="flex flex-col gap-1.5">
          <h4 class="flex items-center gap-1.5 font-medium">
            {{ $t('cliInstances.syncJoinTitle') }}
            <InfoHint :text="$t('cliInstances.syncJoinHint')" />
          </h4>
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
          <h4 class="flex items-center gap-1.5 font-medium">
            {{ $t('cliInstances.syncSetupTitle') }}
            <InfoHint :text="$t('cliInstances.syncSetupHint')" />
          </h4>
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

      <!-- Set up: Sync all and the status on one row, the list only when it is wanted or needed, and
           the way to the other PC. No height cap in here: the dialog itself scrolls on a long list. -->
      <div v-else-if="status" class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="flex items-center gap-1.5">
            <label class="flex cursor-pointer items-center gap-2 font-medium">
              <Switch
                :model-value="syncAll"
                :disabled="working"
                :aria-label="$t('cliInstances.syncAll')"
                @update:model-value="setSyncAll"
              />
              {{ $t('cliInstances.syncAll') }}
            </label>
            <InfoHint :text="syncAllHint" />
          </span>
          <!-- The one live region: what a join or a Sync now is doing, without re-reading the list. -->
          <span role="status" class="flex items-center gap-1.5 tabular-nums text-muted-foreground">
            <LoaderCircle v-if="syncing" class="size-3 animate-spin" aria-hidden="true" />
            {{ statusLine }}
          </span>
          <Button
            v-if="status.enabled"
            size="sm"
            class="ms-auto"
            :disabled="working"
            :aria-busy="working"
            @click="syncNow"
          >
            <RefreshCw :class="working ? 'animate-spin' : ''" /> {{ $t('cliInstances.syncNow') }}
          </Button>
          <Button v-else size="sm" class="ms-auto" :disabled="working" @click="toggle(true)">
            <Play /> {{ $t('cliInstances.syncResume') }}
          </Button>
        </div>
        <p v-if="status.lastError" class="text-destructive">{{ status.lastError }}</p>

        <div class="flex min-w-0 flex-col gap-1">
          <span class="flex items-center gap-1.5">
            <label class="flex cursor-pointer items-center gap-2 font-medium">
              <Switch
                :model-value="!!status.shareQueue"
                :disabled="working"
                :aria-label="$t('cliInstances.syncQueue')"
                @update:model-value="setShareQueue"
              />
              {{ $t('cliInstances.syncQueue') }}
            </label>
            <InfoHint :text="$t('cliInstances.syncQueueHint')" />
          </span>
          <p v-if="status.queueError" class="text-destructive">{{ status.queueError }}</p>
        </div>

        <ul
          v-if="shown.length"
          class="flex flex-col divide-y rounded-md border"
          :aria-label="$t('cliInstances.syncLogins')"
        >
          <li v-for="{ login: l, state } in shown" :key="l.id" class="flex items-center gap-2 px-2 py-1.5">
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
              class="min-w-24 shrink-0 whitespace-nowrap text-end"
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

        <div v-if="!syncAll && recent.length" class="flex min-w-0 flex-col gap-0.5">
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
          <span class="flex items-center gap-1.5">
            <Button variant="outline" size="sm" :disabled="working" @click="copyPairing">
              <Copy /> {{ $t('cliInstances.syncPairing') }}
            </Button>
            <InfoHint :text="$t('cliInstances.syncPairingHint')" />
          </span>
          <Button
            v-if="status.enabled"
            variant="ghost"
            size="sm"
            :disabled="working"
            @click="toggle(false)"
          >
            <Pause /> {{ $t('cliInstances.syncPause') }}
          </Button>
          <Button variant="ghost" size="sm" :disabled="working" @click="disconnect">
            <Unplug /> {{ $t('cliInstances.syncDisconnect') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
