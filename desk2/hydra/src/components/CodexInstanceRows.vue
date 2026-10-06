<script setup lang="ts">
// The Codex rows of the combined Instances table (owner, 2026-09-30). InstancesView.vue owns the
// table, its header, the empty state and the create/refresh controls; this renders ONLY one shared
// InstanceRow per Codex instance (the columns it is handed, the model it builds), plus this
// provider's dialogs (reka dialogs teleport, so they can sit beside the rows).
import {
  AppWindow,
  ArrowRightLeft,
  Eraser,
  Info,
  LogIn,
  LogOut,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCodexInstances } from '@/composables/useCodexInstances'
import { quotaSortColumns, useInstanceSource } from '@/composables/useInstanceSource'
import { pii } from '@/composables/usePrivacy'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import { type CodexInstance, type CodexMovePlan, moveCodexChat, planCodexChatMove } from '@/lib/api'
import { shortDisplayName } from '@/lib/instance-appearance'
import type { InstanceFacts } from '@/lib/instance-filter'
import { type InstanceColumn, type InstanceRowModel, nameTooltipFor } from '@/lib/instance-table'
import { moveTargets } from '@/lib/move-chats'
import { runUsageCatchup, selectUsageCatchup } from '@/lib/usage-catchup'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

// The table's column list (lib/instance-table.ts): the one the header draws, so the cells follow it.
defineProps<{ columns: InstanceColumn[] }>()

const {
  instances,
  loading,
  busyIds,
  refresh,
  startPolling,
  create,
  launchCli,
  login,
  logout,
  openDesktop,
  focusDesktop,
  quitDesktop,
  rename,
  remove,
  redeemResetCredit,
} = useCodexInstances()
const { t } = useI18n()
// Which Codex surfaces Settings exposes: the same singleton InstancesView gated the old section on.
const { codexDesktopEnabled: desktopEnabled, codexCliEnabled: cliEnabled } = useAppSettings()
const isBusy = (instance: CodexInstance) => busyIds.value.has(instance.id)

// Quota shares the app-wide usage store, keyed `codex:<id>` — so the Codex rows reuse the same
// chip, the same cache, the same superseded-window rule as every other provider's rows.
const { snapshotFor, clearUsage, isChecking, checkCodex, setSnapshot, hydrated } = useUsage()
const usageKey = (instance: CodexInstance) => `codex:${instance.id}`
const usageFor = (instance: CodexInstance) => {
  const snap = snapshotFor(usageKey(instance))
  return instance.account?.authMode === 'chatgpt' &&
    snap?.codexAccountId === instance.account.accountId
    ? snap
    : undefined
}
const isCheckingUsage = (instance: CodexInstance) => isChecking(usageKey(instance))
const onCheckUsage = (instance: CodexInstance) => checkCodex(instance.id)
/** Blank this row's old 5-hour and weekly numbers until its next reading; nothing is deleted. */
async function onClearUsage(instance: CodexInstance) {
  if (await clearUsage([usageKey(instance)])) toast.success(t('codexInstances.toastUsageCleared'))
  else toast.error(t('codexInstances.toastUsageClearFailed'))
}
const catchupSignal = { aborted: false }
let didInitialUsage = false
watch(
  [instances, hydrated],
  ([list, ready]) => {
    if (didInitialUsage || !ready || !list.length) return
    didInitialUsage = true
    const due = selectUsageCatchup(
      list.filter((i) => i.account?.authMode === 'chatgpt'),
      usageFor,
    )
    void runUsageCatchup(due, onCheckUsage, { signal: catchupSignal })
  },
  { immediate: true },
)
const refreshingUsage = ref(false)
async function refreshWithUsage() {
  if (refreshingUsage.value) return
  refreshingUsage.value = true
  try {
    await refresh()
    await Promise.all(
      instances.value.filter((i) => i.account?.authMode === 'chatgpt').map(onCheckUsage),
    )
    await refresh({ silent: true })
  } finally {
    refreshingUsage.value = false
  }
}
/** The Refresh button's spinner: the list re-read or the usage checks that follow it. */
const refreshing = computed(() => loading.value || refreshingUsage.value)

// Holds the shared clock while these rows are mounted; each row's own countdown cells read it.
useUsageMode(true)
/** The one fact the status dot reports: is the thing this row launches actually up? With the
 *  desktop surface switched off in Settings there is no desktop to be up, so the dot falls back to
 *  the CLI's own fact — signed in or not. */
const statusOn = (instance: CodexInstance) =>
  desktopEnabled.value ? instance.isDesktopRunning : instance.loggedIn
/** Both facts in one tooltip, because the column is a dot: "Desktop stopped · signed out" is one
 *  hover away instead of setting the column's width. */
function statusTitle(instance: CodexInstance): string {
  const parts: string[] = []
  if (desktopEnabled.value) {
    parts.push(
      instance.isDesktopRunning
        ? t('codexInstances.desktopRunning')
        : t('codexInstances.desktopStopped'),
    )
  }
  if (cliEnabled.value) {
    parts.push(instance.loggedIn ? t('codexInstances.loggedIn') : t('codexInstances.loggedOut'))
  }
  return parts.join(' · ')
}

// Mirrors the server's own redeem guard (core/codex-account.ts's codexResetGuard) against the
// already-cached snapshot, so the button can disable itself instead of round-tripping just to
// learn the redeem would be refused. Only disables on a CONCRETE refusal (a known credit count of
// zero, or a known busiest-window % under the threshold) — an unchecked/stale snapshot leaves the
// button enabled and lets the server give the real answer.
const CODEX_RESET_EXHAUSTED_PERCENT = 100
function redeemDisabledReason(instance: CodexInstance): string | null {
  const snap = usageFor(instance)
  if (!snap) return null
  const available = snap.resetCredits ?? null
  if (available !== null && available <= 0) return t('codexInstances.redeemNoCredits')
  const pcts = [snap.session?.pct, snap.weekAll?.pct].filter(
    (p): p is number => typeof p === 'number',
  )
  const worst = pcts.length > 0 ? Math.max(...pcts) : null
  if (worst === null || worst >= CODEX_RESET_EXHAUSTED_PERCENT) return null
  return t('codexInstances.redeemNotExhausted', { pct: Math.round(worst) })
}

async function onRedeemResetCredit(instance: CodexInstance) {
  const result = await redeemResetCredit(instance.id)
  if (result?.ok) {
    if (result.usage) setSnapshot(`codex:${instance.id}`, result.usage)
    toast.success(result.message || t('codexInstances.toastRedeemed'))
  } else {
    toast.error(result?.message ?? t('codexInstances.toastRedeemFailed'))
  }
}

// The combined table's header is the only sort control now, so these rows follow ITS remembered
// sort (the persisted key InstancesView sorts the Claude rows by), under the same column keys. A
// key these rows hold no fact for (uptime, memory, last launched) leaves them in list order.
const { desktopSortKey, desktopSortDirection } = useUiPrefs()

// The tab's filter is tab-wide (composables/useInstanceFilter.ts), and a Codex row is an account
// like any other: it has a desktop profile that is open or shut, a plan, and a quota reading.
/** `open` is left UNKNOWN when the Codex desktop surface is switched off in Settings: "closed"
 *  would be a claim about a profile this view is not even reporting on. An unknown fact never sets
 *  a row aside (see lib/instance-filter.ts). */
const filterFacts = (instance: CodexInstance): InstanceFacts => ({
  usage: usageFor(instance),
  open: desktopEnabled.value ? instance.isDesktopRunning : null,
  plan: instance.account?.planLabel ?? null,
  signedIn: instance.loggedIn,
})

// The sort compares time left, which is the reset instant minus one shared "now", so a frozen "now" gives
// the same order as the ticking one. Sorting on the tick would redraw every row every 15 s for nothing.
const sortNow = ref(new Date())

const { visibleRows, hiddenByFilter, isDimmed } = useInstanceSource({
  rows: () => instances.value,
  rowKey: (instance: CodexInstance) => instance.id,
  facts: filterFacts,
  persisted: { key: desktopSortKey, direction: desktopSortDirection },
  columns: [
    {
      key: 'status',
      accessor: (instance: CodexInstance) =>
        `${desktopEnabled.value && instance.isDesktopRunning ? '0' : '1'}:${cliEnabled.value && instance.loggedIn ? '0' : '1'}`,
    },
    { key: 'name', accessor: (instance: CodexInstance) => instance.name },
    { key: 'pid', accessor: (instance: CodexInstance) => instance.desktopPid ?? undefined },
    ...quotaSortColumns(
      usageFor,
      (instance: CodexInstance) => instance.account?.planLabel ?? undefined,
      sortNow,
    ),
  ],
})

/** What the shared row draws for one Codex instance (components/InstanceRow.vue). */
function rowModel(instance: CodexInstance): InstanceRowModel {
  const email = instance.account?.email
  return {
    id: instance.id,
    num: instance.num,
    dimmed: isDimmed(instance),
    provider: 'codex',
    status: { on: !!statusOn(instance), title: statusTitle(instance) },
    glyph: { dir: instance.codexHome, running: !!statusOn(instance) },
    name: {
      shown: shortDisplayName(pii(instance.name)),
      // The hover is the address and the folder; a click copies the address (owner, 2026-10-06).
      tooltip: (clipped) =>
        nameTooltipFor(
          {
            full: pii(instance.name),
            shown: shortDisplayName(pii(instance.name)),
            email,
            folder: instance.codexHome,
            copyHint: t('instances.nameCopyHint'),
          },
          clipped,
        ),
      copy: email,
    },
    badge: instance.isExternal ? { label: t('instances.external') } : undefined,
    // The email comes straight off the list payload (the server resolves it from auth.json); without
    // one the row says how it is signed in instead.
    account: {
      note: email
        ? null
        : instance.account?.authMode === 'apikey'
          ? t('codexInstances.authApiKey')
          : t('codexInstances.loggedOutShort'),
    },
    pid: instance.desktopPid,
    usage: {
      snapshot: usageFor(instance),
      checking: isCheckingUsage(instance),
      key: usageKey(instance),
      onCheck: () => void onCheckUsage(instance),
    },
    // Plan, from `plan_type`. The live check prefers ChatGPT's server-computed value over the
    // id_token's mint-time claim, so a lapsed or upgraded plan cannot linger here.
    plan: instance.account?.planLabel ? { label: instance.account.planLabel } : null,
    // "Now" while its desktop runs; Codex keeps no record of when it last did.
    lastRunning: instance.isDesktopRunning
      ? { label: t('instances.lastRunningNow'), running: true }
      : null,
    // A DISCOVERED row (the default install, or a Codex Desktop running from a profile we didn't
    // create) has no store entry, so every mutating action would fail with "not found": it is
    // listed to be READ and offers no menu.
    menu: instance.isExternal
      ? undefined
      : { name: instance.name, actions: menuActionsFor(instance), class: 'max-w-52' },
  }
}

const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
function openCreate() {
  createOpen.value = true
}
async function onCreate(name: string) {
  creating.value = true
  createError.value = null
  try {
    const result = await create(name)
    if (result?.ok) {
      createOpen.value = false
      toast.success(t('codexInstances.toastCreated'))
    } else createError.value = result?.message ?? t('codexInstances.toastCreateFailed')
  } finally {
    creating.value = false
  }
}

const renameOpen = ref(false)
const renameTarget = ref<CodexInstance | null>(null)
const renaming = ref(false)
const renameError = ref<string | null>(null)
function openRename(instance: CodexInstance) {
  renameTarget.value = instance
  renameError.value = null
  renameOpen.value = true
}
async function onRename(name: string) {
  const target = renameTarget.value
  if (!target) return
  renaming.value = true
  try {
    const result = await rename(target.id, name)
    if (result?.ok) {
      renameOpen.value = false
      toast.success(t('codexInstances.toastRenamed'))
    } else renameError.value = result?.message ?? t('codexInstances.toastRenameFailed')
  } finally {
    renaming.value = false
  }
}

const deleteOpen = ref(false)
const deleteTarget = ref<CodexInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDelete(instance: CodexInstance) {
  deleteTarget.value = instance
  deleteError.value = null
  deleteOpen.value = true
}
async function onDelete(name: string) {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    const result = await remove(target.id, name)
    if (result?.ok) {
      deleteOpen.value = false
      toast.success(t('codexInstances.toastDeleted'))
    } else deleteError.value = result?.message ?? t('codexInstances.toastDeleteFailed')
  } finally {
    deleting.value = false
  }
}

async function onLaunchCli(instance: CodexInstance) {
  const result = await launchCli(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastCliLaunched'))
  else toast.error(result?.message ?? t('codexInstances.toastCliLaunchFailed'))
}

async function onLogin(instance: CodexInstance) {
  const result = await login(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastLoginOpened'))
  else toast.error(result?.message ?? t('codexInstances.toastLoginFailed'))
}

// Log out goes through a confirm dialog, like the Claude Desktop rows: it removes the stored login.
const logoutOpen = ref(false)
const logoutTarget = ref<CodexInstance | null>(null)
const loggingOut = ref(false)

function openLogout(instance: CodexInstance) {
  logoutTarget.value = instance
  logoutOpen.value = true
}

async function onLogoutConfirm() {
  const target = logoutTarget.value
  if (!target) return
  loggingOut.value = true
  try {
    const result = await logout(target.id)
    if (result?.ok) toast.success(result.message || t('codexInstances.toastLoggedOut'))
    else toast.error(result?.message ?? t('codexInstances.toastLogoutFailed'))
  } finally {
    loggingOut.value = false
    logoutOpen.value = false
    logoutTarget.value = null
  }
}

async function onOpenDesktop(instance: CodexInstance) {
  const result = await openDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopOpened'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopOpenFailed'))
}

async function onFocusDesktop(instance: CodexInstance) {
  const result = await focusDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopFocused'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopFocusFailed'))
}

/** The icons at the top of a row's ⋯ menu (InstanceMenuHeader, which adds Copy number last):
 *  Rename, then Log out — an icon there on every table, never a list item. Both open a dialog. */
function menuActionsFor(instance: CodexInstance): MenuIconAction[] {
  const actions: MenuIconAction[] = [
    {
      key: 'rename',
      icon: Pencil,
      label: t('codexInstances.rename'),
      closes: true,
      disabled: isBusy(instance),
      run: () => openRename(instance),
    },
  ]
  if (instance.loggedIn && !instance.isExternal) {
    actions.push({
      key: 'logout',
      icon: LogOut,
      // An icon has no other place to say why it is disabled, so while the desktop is up the
      // "quit it first" hint IS its label.
      label: instance.isDesktopRunning
        ? t('codexInstances.logoutQuitFirst')
        : t('codexInstances.logout'),
      closes: true,
      disabled: instance.isDesktopRunning || isBusy(instance),
      run: () => openLogout(instance),
    })
  }
  return actions
}

async function onQuitDesktop(instance: CodexInstance) {
  const result = await quitDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopQuit'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopQuitFailed'))
}

const moveShowClosed = ref(false)
const moveBusy = ref(false)
const moveJob = ref<{ from: CodexInstance; to: CodexInstance; plan: CodexMovePlan } | null>(null)
const moveErrors = ref<string[]>([])
const moveLabel = (instance: CodexInstance) => `#${instance.num} ${instance.name}`
const moveTargetsFor = (from: CodexInstance) =>
  moveTargets(
    instances.value
      .filter((i) => !i.isExternal && i.account?.authMode === 'chatgpt')
      .map((i) => ({ ...i, dir: i.codexHome, isRunning: i.isDesktopRunning })),
    { ...from, dir: from.codexHome, isRunning: from.isDesktopRunning },
    moveShowClosed.value,
    moveLabel,
  )
// Each row's move targets, worked out once per list or toggle change and only for rows whose menu asks.
const moveTargetsOf = computed(() => {
  void instances.value
  void moveShowClosed.value
  const cache = new Map<string, CodexInstance[]>()
  return (from: CodexInstance) => {
    let targets = cache.get(from.id)
    if (!targets) {
      targets = moveTargetsFor(from)
      cache.set(from.id, targets)
    }
    return targets
  }
})
async function prepareMove(from: CodexInstance, to: CodexInstance) {
  if (moveBusy.value) return
  moveBusy.value = true
  moveErrors.value = []
  const id = `codex-move-${from.id}`
  toast.loading(t('instances.moveChatsCounting'), { id })
  try {
    const plan = await planCodexChatMove(from.id, to.id)
    toast.dismiss(id)
    if (!plan.chats.length) toast.info(t('instances.moveChatsNone', { from: moveLabel(from) }))
    else moveJob.value = { from, to, plan }
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : t('instances.moveChatsFailed', { from: moveLabel(from) }),
      { id },
    )
  } finally {
    moveBusy.value = false
  }
}
async function runMove() {
  const job = moveJob.value
  if (!job || moveBusy.value) return
  moveBusy.value = true
  moveErrors.value = []
  let moved = 0
  const id = `codex-move-${job.from.id}`
  const failed = [] as typeof job.plan.chats
  try {
    for (const [index, chat] of job.plan.chats.entries()) {
      toast.loading(
        t('instances.moveChatsProgress', { done: index + 1, n: job.plan.chats.length }),
        { id },
      )
      try {
        const result = await moveCodexChat(job.from.id, {
          targetId: job.to.id,
          threadId: chat.id,
          updatedAt: chat.updatedAt,
          sourceAccountId: job.plan.sourceAccountId,
          targetAccountId: job.plan.targetAccountId,
        })
        if (!result.ok) throw new Error(result.error)
        moved++
      } catch (error) {
        failed.push(chat)
        moveErrors.value.push(
          `${chat.title}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const summary = t('instances.moveChatsDone', {
      ok: moved,
      n: job.plan.chats.length,
      to: moveLabel(job.to),
    })
    if (failed.length) {
      job.plan.chats = failed
      toast.error(summary, { id })
    } else {
      moveJob.value = null
      toast.success(summary, { id })
    }
    await refresh({ silent: true })
  } finally {
    moveBusy.value = false
  }
}

onMounted(startPolling)
onUnmounted(() => {
  catchupSignal.aborted = true
})

// `refresh` is the old section's Refresh button (list, then every ChatGPT login's usage, then the
// list again); `refreshing` and `hiddenByFilter` feed the combined header's spinner and filter note.
// visibleCount: the combined table's heading counts the rows actually drawn (filter included).
// One model per drawn row, rebuilt only when the rows or the facts they read change, so a row whose data
// did not change gets the same prop and does not redraw.
const rowModels = computed(() => new Map(visibleRows.value.map((i) => [i.id, rowModel(i)])))
const redeemReasons = computed(
  () => new Map(visibleRows.value.map((i) => [i.id, redeemDisabledReason(i)])),
)
const visibleCount = computed(() => visibleRows.value.length)
defineExpose({ openCreate, refresh: refreshWithUsage, refreshing, hiddenByFilter, visibleCount })
</script>

<template>
  <InstanceRow
    v-for="instance in visibleRows"
    :key="instance.id"
    :columns="columns"
    :row="rowModels.get(instance.id)!"
  >
    <template #primary>
      <!-- Icon-only actions (owner, 2026-10-06): the word is the tooltip and the aria-label; the
           external row's note is a muted Info icon whose tooltip is that text. -->
      <IconTooltip v-if="instance.isExternal" :label="$t('codexInstances.externalHint')">
        <span
          class="inline-flex size-6 items-center justify-center text-muted-foreground"
          role="img"
          :aria-label="$t('codexInstances.externalHint')"
        >
          <Info class="size-3.5" aria-hidden="true" />
        </span>
      </IconTooltip>
      <template v-else>
        <IconTooltip
          v-if="desktopEnabled && !instance.isDesktopRunning"
          :label="$t('codexInstances.openDesktop')"
        >
          <Button
            variant="outline"
            size="icon-sm"
            :aria-label="$t('codexInstances.openDesktop')"
            :disabled="isBusy(instance)"
            @click="onOpenDesktop(instance)"
          >
            <Play />
          </Button>
        </IconTooltip>
        <IconTooltip v-else-if="desktopEnabled" :label="$t('codexInstances.focusDesktop')">
          <Button
            variant="outline"
            size="icon-sm"
            :aria-label="$t('codexInstances.focusDesktop')"
            :disabled="isBusy(instance)"
            @click="onFocusDesktop(instance)"
          >
            <!-- Same running dot as the Claude rows' Focus button: this button only exists while the
                 desktop app is up, and the dot says so where the eye already is. -->
            <span class="relative inline-flex">
              <AppWindow />
              <span
                class="absolute -right-1 -top-1 size-1.5 rounded-full bg-success ring-2 ring-background animate-pulse"
              />
            </span>
          </Button>
        </IconTooltip>
        <IconTooltip v-else-if="cliEnabled" :label="$t('codexInstances.launch')">
          <Button
            variant="outline"
            size="icon-sm"
            :aria-label="$t('codexInstances.launch')"
            :disabled="isBusy(instance)"
            @click="onLaunchCli(instance)"
          >
            <Terminal />
          </Button>
        </IconTooltip>
      </template>
    </template>
    <template #menu>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger :disabled="moveBusy || isBusy(instance)">
          <ArrowRightLeft /> {{ $t('instances.moveChats') }}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="max-w-72">
          <DropdownMenuCheckboxItem
            :model-value="moveShowClosed"
            @select.prevent
            @update:model-value="moveShowClosed = $event"
          >
            {{ $t('instances.moveChatsShowNotRunning') }}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem v-if="moveTargetsOf(instance).length === 0" disabled>
            {{
              moveShowClosed
                ? $t('instances.moveChatsNoTargets')
                : $t('instances.moveChatsNoRunningTargets')
            }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="to in moveTargetsOf(instance)"
            :key="to.id"
            @click="prepareMove(instance, to)"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="to.isDesktopRunning ? 'bg-success' : 'bg-muted-foreground/40'"
            />
            <span class="truncate">{{ moveLabel(to) }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem
        v-if="desktopEnabled"
        :disabled="!instance.isDesktopRunning || isBusy(instance)"
        @click="onQuitDesktop(instance)"
      >
        <Square /> {{ $t('codexInstances.quitDesktop') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator v-if="desktopEnabled && cliEnabled" />
      <DropdownMenuItem
        v-if="cliEnabled"
        :disabled="isBusy(instance)"
        @click="onLaunchCli(instance)"
      >
        <Terminal /> {{ $t('codexInstances.launchCli') }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-if="cliEnabled"
        :disabled="isBusy(instance)"
        @click="onLogin(instance)"
      >
        <LogIn /> {{ $t('codexInstances.login') }}
      </DropdownMenuItem>
      <!-- Only for a signed-in ChatGPT login: an API-key auth has no ChatGPT subscription and
           so no bankable reset credits. Disabled (with a title explaining why) when the cached
           usage already shows the redeem would be refused; the click still round-trips to the
           server otherwise, which gives the authoritative answer when the cache is stale. -->
      <DropdownMenuItem
        v-if="instance.account?.authMode === 'chatgpt'"
        :disabled="isBusy(instance) || !!redeemReasons.get(instance.id)"
        :title="redeemReasons.get(instance.id) ?? undefined"
        @click="onRedeemResetCredit(instance)"
      >
        <RotateCcw /> {{ $t('codexInstances.redeemResetCredit') }}
      </DropdownMenuItem>
      <!-- Blanks the row's old numbers until its next reading (owner, 2026-10-02). -->
      <DropdownMenuItem :disabled="!usageFor(instance)" @click="onClearUsage(instance)">
        <Eraser /> {{ $t('codexInstances.clearUsage') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        :disabled="instance.isDesktopRunning || isBusy(instance)"
        @click="openDelete(instance)"
      >
        <Trash2 /> {{ $t('codexInstances.delete') }}
      </DropdownMenuItem>
    </template>
  </InstanceRow>

  <!-- The dialogs teleport to <body>, so sitting beside the rows puts nothing inside the tbody. -->
  <Dialog
    :open="moveJob !== null"
    @update:open="(value) => { if (!value && !moveBusy) moveJob = null }"
  >
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          <span class="flex items-center gap-1.5">
            {{
              $t('instances.moveChatsConfirmTitle', {
                n: moveJob?.plan.chats.length ?? 0,
                from: moveJob ? moveLabel(moveJob.from) : '',
                to: moveJob ? moveLabel(moveJob.to) : '',
              })
            }}
            <InfoHint :text="$t('codexInstances.moveDescription')" />
          </span>
        </DialogTitle>
        <DialogDescription class="sr-only">{{ $t('codexInstances.moveDescription') }}</DialogDescription>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ $t('codexInstances.moveCloseSource') }}</p>
      <ul class="max-h-64 space-y-2 overflow-auto text-sm">
        <li v-for="chat in moveJob?.plan.chats" :key="chat.id">
          <div class="font-medium">{{ chat.title }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ chat.cwd }}</div>
        </li>
      </ul>
      <ul
        v-if="moveErrors.length"
        class="max-h-40 space-y-1 overflow-auto text-xs text-destructive"
      >
        <li v-for="error in moveErrors" :key="error">{{ error }}</li>
      </ul>
      <DialogFooter>
        <Button variant="ghost" :disabled="moveBusy" @click="moveJob = null">
          {{ $t('instances.moveChatsCancel') }}
        </Button>
        <Button :disabled="moveBusy" @click="runMove">
          {{ $t('instances.moveChatsConfirmSubmit', { n: moveJob?.plan.chats.length ?? 0 }) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <CliInstanceNameDialog
    v-model:open="createOpen"
    namespace="codexInstances"
    mode="create"
    :submitting="creating"
    :error-message="createError"
    @submit="onCreate"
  />
  <CliInstanceNameDialog
    v-model:open="renameOpen"
    namespace="codexInstances"
    mode="rename"
    :current-name="renameTarget?.name ?? null"
    :submitting="renaming"
    :error-message="renameError"
    @submit="onRename"
  />
  <DeleteInstanceDialog
    v-model:open="deleteOpen"
    namespace="codexInstances"
    :instance-name="deleteTarget?.name ?? null"
    :submitting="deleting"
    :error-message="deleteError"
    @confirm="onDelete"
  />
  <LogoutInstanceDialog
    v-model:open="logoutOpen"
    :instance-name="logoutTarget?.name ?? null"
    :account-email="logoutTarget?.account?.email ?? null"
    :description="$t('codexInstances.logoutDialogDescription')"
    :submitting="loggingOut"
    @confirm="onLogoutConfirm"
  />
</template>
