<script setup lang="ts">
// The Codex rows of the combined Instances table (owner, 2026-09-30). InstancesView.vue owns the
// <Table>, its header, the empty state and the create/refresh controls; this renders ONLY one
// <TableRow> per Codex instance, in the 10-column contract every provider's rows follow, plus this
// provider's dialogs (reka dialogs teleport, so they can sit beside the rows).
import {
  AppWindow,
  ArrowRightLeft,
  EllipsisVertical,
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
import CopyResetDate from '@/components/CopyResetDate.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import InstanceAccountBadge from '@/components/InstanceAccountBadge.vue'
import InstanceGlyph from '@/components/InstanceGlyph.vue'
import InstanceMenuHeader, { type MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import ProviderLogo from '@/components/ProviderLogo.vue'
import UsageBadge from '@/components/UsageBadge.vue'
import UsageBar from '@/components/UsageBar.vue'
import { Badge } from '@/components/ui/badge'
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TableCell, TableRow } from '@/components/ui/table'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCodexInstances } from '@/composables/useCodexInstances'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useSortable } from '@/composables/useSortable'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import { type CodexInstance, type CodexMovePlan, moveCodexChat, planCodexChatMove } from '@/lib/api'
import { shortDisplayName } from '@/lib/instance-appearance'
import type { InstanceFacts } from '@/lib/instance-filter'
import { moveTargets } from '@/lib/move-chats'
import { bindingWeeklyPct } from '@/lib/usage'
import { runUsageCatchup, selectUsageCatchup } from '@/lib/usage-catchup'
import {
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'
import IconTooltip from '@/shell/IconTooltip.vue'

// Usage mode is TAB-WIDE (composables/useUsageMode.ts); the combined table passes it down so its
// header and these rows can never disagree about which three columns sit in slots 4-6.
defineProps<{ usageMode: boolean }>()

const {
  instances,
  loading,
  busyIds,
  refresh,
  startPolling,
  stopPolling,
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
const { snapshotFor, isChecking, checkCodex, setSnapshot, hydrated } = useUsage()
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

// The shared clock every countdown cell on the tab formats against, so the whole tab ticks together.
const { now } = useUsageMode(true)
const sessionResetFor = (instance: CodexInstance) =>
  resetLabel(usageFor(instance)?.session, now.value)
const weeklyResetFor = (instance: CodexInstance) =>
  resetLabel(usageFor(instance)?.weekAll, now.value)
// One number per window drives the bar's length; the WEEKLY one also drives its colour, and the
// 5-hour bar is drawn `neutral` — same contract as the Claude rows (see UsageBar).
const sessionRemaining = (instance: CodexInstance) =>
  windowRemainingPct(usageFor(instance)?.session, SESSION_WINDOW_MS, now.value) ?? 0
const weeklyRemaining = (instance: CodexInstance) =>
  windowRemainingPct(usageFor(instance)?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0
const weeklyWait = (instance: CodexInstance) => waitSeverity(weeklyRemaining(instance))

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
const { sortedRows } = useSortable(
  () => instances.value,
  [
    {
      key: 'running',
      accessor: (instance: CodexInstance) =>
        `${desktopEnabled.value && instance.isDesktopRunning ? '0' : '1'}:${cliEnabled.value && instance.loggedIn ? '0' : '1'}`,
    },
    { key: 'name', accessor: (instance: CodexInstance) => instance.name },
    {
      key: 'account',
      accessor: (instance: CodexInstance) =>
        instance.account?.email ?? instance.account?.name ?? undefined,
    },
    { key: 'pid', accessor: (instance: CodexInstance) => instance.desktopPid ?? undefined },
    {
      key: 'plan',
      accessor: (instance: CodexInstance) => instance.account?.planLabel ?? undefined,
    },
    // Usage-mode columns — by time remaining, so "soonest reset first" is what a sort gives you.
    {
      key: 'session',
      accessor: (instance: CodexInstance) =>
        msUntilReset(usageFor(instance)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (instance: CodexInstance) =>
        msUntilReset(usageFor(instance)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (instance: CodexInstance) => {
        const snap = usageFor(instance)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    {
      key: 'usageSession',
      accessor: (instance: CodexInstance) => usageFor(instance)?.session?.pct ?? undefined,
    },
  ],
  { key: desktopSortKey, direction: desktopSortDirection },
  { rowKey: (instance: CodexInstance) => instance.id },
)

// --- filter -------------------------------------------------------------------------------------
// The tab's filter is tab-wide (composables/useInstanceFilter.ts), and a Codex row is an account
// like any other: it has a desktop profile that is open or shut, a plan, and a quota reading. It
// runs AFTER the sort — it removes or greys rows, it never reorders them.
const { dimmed: filterDimmed, visible: filterVisible } = useInstanceFilter()

/** `open` is left UNKNOWN when the Codex desktop surface is switched off in Settings: "closed"
 *  would be a claim about a profile this view is not even reporting on. An unknown fact never sets
 *  a row aside (see lib/instance-filter.ts). */
const filterFacts = (instance: CodexInstance): InstanceFacts => ({
  usage: usageFor(instance),
  open: desktopEnabled.value ? instance.isDesktopRunning : null,
  plan: instance.account?.planLabel ?? null,
  signedIn: instance.loggedIn,
})

const visibleRows = computed(() => filterVisible(sortedRows.value, filterFacts))
/** Codex rows the filter dropped, for the combined heading's "hidden by filter" note: a row that
 *  quietly stopped being listed reads as a bug rather than as the filter working. */
const hiddenByFilter = computed(() => sortedRows.value.length - visibleRows.value.length)

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
  stopPolling()
})

// `refresh` is the old section's Refresh button (list, then every ChatGPT login's usage, then the
// list again); `refreshing` and `hiddenByFilter` feed the combined header's spinner and filter note.
// visibleCount: the combined table's heading counts the rows actually drawn (filter included).
const visibleCount = computed(() => visibleRows.value.length)
defineExpose({ openCreate, refresh: refreshWithUsage, refreshing, hiddenByFilter, visibleCount })
</script>

<template>
  <TableRow
    v-for="instance in visibleRows"
    :key="instance.id"
    :variant="filterDimmed(filterFacts(instance)) ? 'faded' : 'default'"
  >
    <!-- 1. Status: one dot, same size and colours as the other providers' rows; both facts
         (desktop up, CLI signed in) live in its title. -->
    <TableCell>
      <span
        class="inline-block size-2 rounded-full"
        :class="statusOn(instance) ? 'bg-success' : 'bg-muted-foreground/40'"
        :title="statusTitle(instance)"
      />
    </TableCell>
    <!-- 2. Name: max-w-0 so a long name elides instead of widening the table. Codex instances
         share ONE number sequence with the Claude rows, so `#7` here can never be a different `#7`
         there. CODEX_HOME, which used to be a column of its own, is in the name's hover, the same
         place the Claude rows keep their profile folder. -->
    <TableCell class="max-w-0">
      <div class="flex min-w-0 items-center gap-1.5 font-medium">
        <ProviderLogo provider="codex" class="size-3.5" />
        <InstanceNumber :num="instance.num" />
        <InstanceGlyph :dir="instance.codexHome" :running="statusOn(instance)" />
        <IconTooltip :label="instance.name" :description="instance.codexHome">
          <span class="min-w-0 cursor-default truncate">{{ shortDisplayName(instance.name) }}</span>
        </IconTooltip>
        <Badge v-if="instance.isExternal" variant="outline">{{ $t('instances.external') }}</Badge>
      </div>
    </TableCell>
    <!-- 3. Account: the same email-handle pill as the Claude rows (InstanceAccountBadge). The
         email comes straight off the list payload (the server resolves it from auth.json). -->
    <TableCell>
      <InstanceAccountBadge
        :email="instance.account?.email"
        :profile="instance.account?.name"
        :fallback="
          instance.account?.authMode === 'apikey'
            ? $t('codexInstances.authApiKey')
            : $t('codexInstances.loggedOutShort')
        "
        :variant="instance.account?.email ? 'success' : 'outline'"
      />
    </TableCell>
    <!-- 4-6. Process columns: the desktop's PID; Codex reports no start time or memory. -->
    <template v-if="!usageMode">
      <TableCell>
        <span v-if="instance.desktopPid != null" class="mono text-muted-foreground">
          {{ instance.desktopPid }}
        </span>
        <span v-else class="text-xs text-muted-foreground">—</span>
      </TableCell>
      <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
      <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
    </template>
    <!-- 4-6. Quota columns: the two reset countdowns and the 5-hour chip. -->
    <template v-else>
      <TableCell>
        <UsageBar
          v-if="sessionResetFor(instance)"
          :fill-pct="sessionRemaining(instance)"
          variant="neutral"
          :label="sessionResetFor(instance) ?? ''"
          :aria-label="$t('instances.resetsIn', { when: sessionResetFor(instance) })"
        />
        <span
          v-else
          class="text-xs text-muted-foreground"
          :title="
            usageFor(instance)?.sessionLimitUnavailable
              ? $t('codexInstances.noSessionLimit')
              : undefined
          "
        >{{ usageFor(instance)?.sessionLimitUnavailable ? 'N/A' : '—' }}</span>
      </TableCell>
      <TableCell>
        <CopyResetDate v-if="weeklyResetFor(instance)" :limit="usageFor(instance)?.weekAll">
          <UsageBar
            :fill-pct="weeklyRemaining(instance)"
            :variant="weeklyWait(instance)"
            :label="weeklyResetFor(instance) ?? ''"
            :aria-label="$t('instances.resetsIn', { when: weeklyResetFor(instance) })"
          />
        </CopyResetDate>
        <span v-else class="text-xs text-muted-foreground">—</span>
      </TableCell>
      <TableCell>
        <UsageBadge
          scope="session"
          :snapshot="usageFor(instance)"
          :checking="isCheckingUsage(instance)"
          :usage-key="usageKey(instance)"
          @check="onCheckUsage(instance)"
        />
      </TableCell>
    </template>
    <!-- 7. Usage -->
    <TableCell>
      <UsageBadge
        :snapshot="usageFor(instance)"
        :checking="isCheckingUsage(instance)"
        :usage-key="usageKey(instance)"
        @check="onCheckUsage(instance)"
      />
    </TableCell>
    <!-- 8. Plan, from `plan_type`. The live check prefers ChatGPT's server-computed value over the
         id_token's mint-time claim, so a lapsed or upgraded plan cannot linger here. -->
    <TableCell>
      <Badge v-if="instance.account?.planLabel" variant="outline">
        {{ instance.account.planLabel }}
      </Badge>
      <span v-else class="text-xs text-muted-foreground">—</span>
    </TableCell>
    <!-- 9. Last running: "Now" while its desktop runs; Codex keeps no record of when it last did. -->
    <TableCell>
      <span v-if="instance.isDesktopRunning" class="text-xs text-success">
        {{ $t('instances.lastRunningNow') }}
      </span>
      <span v-else class="text-xs text-muted-foreground">—</span>
    </TableCell>
    <!-- 10. Actions -->
    <TableCell>
      <!-- A DISCOVERED row (the default install, or a Codex Desktop running from a profile we
           didn't create) has no store entry, so every mutating action would fail with "not found".
           It is listed to be READ — identity, plan, quota — and says so instead of offering buttons
           that cannot work. -->
      <div v-if="instance.isExternal" class="flex items-center justify-end">
        <span class="whitespace-nowrap text-3xs text-muted-foreground">
          {{ $t('codexInstances.externalHint') }}
        </span>
      </div>
      <div v-else class="flex items-center justify-end gap-1">
        <Button
          v-if="desktopEnabled && !instance.isDesktopRunning"
          variant="outline"
          size="sm"
          :disabled="isBusy(instance)"
          @click="onOpenDesktop(instance)"
        >
          <Play /> {{ $t('codexInstances.openDesktop') }}
        </Button>
        <Button
          v-else-if="desktopEnabled"
          variant="outline"
          size="sm"
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
          {{ $t('codexInstances.focusDesktop') }}
        </Button>
        <Button
          v-else-if="cliEnabled"
          variant="outline"
          size="sm"
          :disabled="isBusy(instance)"
          @click="onLaunchCli(instance)"
        >
          <Terminal /> {{ $t('codexInstances.launch') }}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="$t('codexInstances.moreActions')">
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-52">
            <InstanceMenuHeader :num="instance.num" :actions="menuActionsFor(instance)" />
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
                <DropdownMenuItem v-if="moveTargetsFor(instance).length === 0" disabled>
                  {{
                    moveShowClosed
                      ? $t('instances.moveChatsNoTargets')
                      : $t('instances.moveChatsNoRunningTargets')
                  }}
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-for="to in moveTargetsFor(instance)"
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
              :disabled="isBusy(instance) || !!redeemDisabledReason(instance)"
              :title="redeemDisabledReason(instance) ?? undefined"
              @click="onRedeemResetCredit(instance)"
            >
              <RotateCcw /> {{ $t('codexInstances.redeemResetCredit') }}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              :disabled="instance.isDesktopRunning || isBusy(instance)"
              @click="openDelete(instance)"
            >
              <Trash2 /> {{ $t('codexInstances.delete') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TableCell>
  </TableRow>

  <!-- The dialogs teleport to <body>, so sitting beside the rows puts nothing inside the tbody. -->
  <Dialog
    :open="moveJob !== null"
    @update:open="(value) => { if (!value && !moveBusy) moveJob = null }"
  >
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{
            $t('instances.moveChatsConfirmTitle', {
              n: moveJob?.plan.chats.length ?? 0,
              from: moveJob ? moveLabel(moveJob.from) : '',
              to: moveJob ? moveLabel(moveJob.to) : '',
            })
          }}
        </DialogTitle>
        <DialogDescription>{{ $t('codexInstances.moveDescription') }}</DialogDescription>
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
