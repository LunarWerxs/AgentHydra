<script setup lang="ts">
// CLI Instances: the table of every CLI login on this PC.
// A "CLI instance" is an isolated CLAUDE_CONFIG_DIR the daemon can run a real `claude` against (as
// opposed to a Claude Desktop profile).
//
// One LINKED to a desktop instance is the same Anthropic account signed in twice. It shows on that
// account's row in InstancesView (the ⌨ icon) AND here, marked with a chip naming the row (owner,
// 2026-10-03: "When I add a CLI instance... it needs to also add it to the CLI row... I need to see
// it over there"). Full lifecycle (create / rename / associate / link / delete) lives here; the
// account row carries launch / sign-in / unlink as well.
import {
  ArrowRightLeft,
  Cloud,
  CreditCard,
  Eraser,
  FileDown,
  Funnel,
  Link2,
  LogIn,
  LogOut,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Terminal,
  Timer,
  Trash2,
  Unlink,
} from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AssociateCliInstanceDialog from '@/components/AssociateCliInstanceDialog.vue'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import CliLimitResetDialog from '@/components/CliLimitResetDialog.vue'
import CliLimitResetIcon from '@/components/CliLimitResetIcon.vue'
import CliLoginMoveDialog from '@/components/CliLoginMoveDialog.vue'
import CliLoginSyncDialog from '@/components/CliLoginSyncDialog.vue'
import CliQuickAdd from '@/components/CliQuickAdd.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import InstanceSectionHeader from '@/components/InstanceSectionHeader.vue'
import InstanceTable from '@/components/InstanceTable.vue'
import LinkCliInstanceDialog from '@/components/LinkCliInstanceDialog.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import PooledUsageGauges from '@/components/PooledUsageGauges.vue'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { TableBody } from '@/components/ui/table'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { quotaSortColumns, useInstanceSource } from '@/composables/useInstanceSource'
import { useInstances } from '@/composables/useInstances'
import { useQuickAddTarget } from '@/composables/useQuickAddTarget'
import { useCliTokenWindow } from '@/composables/useTokenWindow'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliInstance } from '@/lib/api'
import { formatUsd, timeAgo } from '@/lib/format'
import { displayName, shortDisplayName } from '@/lib/instance-appearance'
import {
  type InstanceRowModel,
  instanceColumns,
  nameTooltipFor,
  withoutPlanSuffix,
} from '@/lib/instance-table'
import { tokenPartsFor } from '@/lib/token-window'
import { billsPastLimit, usageReasonMessageKey, windowLengthMs, windowResetMs } from '@/lib/usage'
import { planSize, pooledRemaining } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const {
  cliInstances,
  loading,
  busyIds,
  startPolling,
  stopPolling,
  refreshCliInstances,
  launch,
  logout,
  rename,
  associate,
  linkDesktop,
  remove,
  checkUsage,
} = useCliInstances()
const {
  snapshotFor,
  clearUsage,
  isChecking,
  checkCli,
  reasonFor,
  startPolling: startUsagePolling,
  stopPolling: stopUsagePolling,
} = useUsage()
const { accounts, refreshAccounts } = useData()
// The desktop instances are the link targets. useInstances is a module singleton that the Instances
// tab keeps loaded; this table lives on the CLI tab, so a window opened straight onto it reads the
// list once on mount (below), or every linked CLI instance would show here without its link chip.
const { instances: desktopInstances, refreshInstances } = useInstances()
const { target: quickAddTarget, setQuickAddTarget, clearQuickAddTarget } = useQuickAddTarget()

const { t } = useI18n()
/** Whether the accounts table is unfolded, kept in this browser (see the header's comment). */
const accountsOpen = useStorage('agenthydra.cli.accountsOpen', true)

const usageKey = (inst: CliInstance) => `cli:${inst.id}`
const usageFor = (inst: CliInstance) => snapshotFor(usageKey(inst))

// Usage mode is a TAB-WIDE mode, not a per-table one (see composables/useUsageMode.ts): the toolbar
// toggle up in InstancesView flips this table too, because "how much quota is left" is a question
// you ask of every instance at once. Here the swap trades the config-dir column — the least useful
// thing on screen when you're asking about quota — for the two reset countdowns.
const { usageMode, now } = useUsageMode(true)
// The folded table's two gauges (PooledUsageGauges.vue): what is left of each window across EVERY
// CLI account, the ones linked to a desktop row included, since CliMayte runs on those too.
const poolOf = (which: 'session' | 'weekAll') =>
  pooledRemaining(
    cliInstances.value.map((inst) => ({
      signedIn: inst.loggedIn,
      planLabel: planFor(inst),
      limit: usageFor(inst)?.[which],
    })),
    now.value,
  )
const sessionPool = computed(() => poolOf('session'))
const weekPool = computed(() => poolOf('weekAll'))

/**
 * EVERY CLI instance lives in this table, the linked ones included.
 *
 * A linked one is the same Anthropic account as its desktop instance, signed in twice, so the
 * Instances tab shows it on that row too (the ⌨ icon). It used to be listed ONLY there, and a login
 * added from a desktop row then never appeared on the CLI tab at all (owner, 2026-10-03: "I need to
 * see it over there"). Here it keeps its own row and a chip naming the desktop row it belongs to.
 *
 * A link only counts while its desktop instance still exists. removeInstance() clears it
 * server-side when the desktop instance is deleted (core/lifecycle.ts); checking the live desktop
 * list too is a frontend backstop, so a ghost link to a vanished folder never draws a chip pointing
 * at nothing.
 */
const desktopByDir = computed(() => new Map(desktopInstances.value.map((d) => [d.dir, d])))
/** The desktop instance this CLI login is linked to, or null when it is not (or the link is stale). */
function linkedDesktop(inst: CliInstance) {
  const dir = inst.associatedDesktopDir
  return dir ? (desktopByDir.value.get(dir) ?? null) : null
}
/** What the Plan cell shows, and so what its sort orders by: the login's own plan, else its desktop
 *  row's, since a linked login is that same account. */
function planFor(inst: CliInstance): string | null {
  return inst.planLabel ?? linkedDesktop(inst)?.account?.planLabel ?? null
}

/**
 * What one CLI row is, as far as the filter is concerned.
 *
 * `open` is deliberately absent, not `false`: a CLI login, linked or not, is a CLAUDE_CONFIG_DIR,
 * not an app, so it is never open OR closed, and the filter's "an unknown fact never sets a row aside"
 * rule leaves this table alone when you filter by status. Claiming `false` would empty it the
 * moment someone asked for the open accounts. Its plan is left out too, as the filter flyout
 * offers no CLI plans (InstancesView's presentPlans), so a plan the menu cannot name never sets a
 * CLI row aside.
 */
const filterFacts = (inst: CliInstance) => ({ usage: usageFor(inst), signedIn: inst.loggedIn })

const tokenWindow = useCliTokenWindow()

const { toggleSort, indicatorFor, visibleRows, hiddenByFilter, isDimmed } = useInstanceSource({
  rows: () => cliInstances.value,
  rowKey: (i: CliInstance) => i.id,
  facts: filterFacts,
  columns: [
    { key: 'status', accessor: (i: CliInstance) => i.loggedIn },
    { key: 'name', accessor: (i: CliInstance) => i.name },
    { key: 'configDir', accessor: (i: CliInstance) => i.configDir },
    { key: 'lastActive', accessor: (i: CliInstance) => i.lastActiveAt ?? undefined },
    // By plan size (Pro 1, Max 5x 5, Max 20x 20), not the label's spelling; no plan sorts last.
    ...quotaSortColumns(usageFor, (i: CliInstance) => planSize(planFor(i)), now),
    // Biggest first: the question asked of this column is which account ran the most.
    {
      key: 'tokens',
      accessor: (i: CliInstance) => tokenPartsFor(i.tokens, tokenWindow.value)?.total,
      first: 'desc',
    },
  ],
})

/** How much of a name the row shows (a CLI name is an email address). */
const nameMax = 36
/** There ARE CLI instances, the filter just took all of them. */
const allHiddenByFilter = computed(
  () => cliInstances.value.length > 0 && visibleRows.value.length === 0,
)

/**
 * The heading's parenthetical: the row count, or "x of y" while the usage filter has set rows
 * aside. Every CLI instance is a row here, linked or not, so a shortfall has no other cause.
 */
const headingCount = computed(() =>
  // No count before the first answer: a "(0)" over loading bars read as "my accounts are gone"
  // (SUE round, 2026-10-01).
  loading.value && cliInstances.value.length === 0
    ? '…'
    : hiddenByFilter.value === 0
      ? String(visibleRows.value.length)
      : t('cliInstances.countOfTotal', {
          shown: visibleRows.value.length,
          total: cliInstances.value.length,
        }),
)

const columns = computed(() => instanceColumns('cli', { usageMode: usageMode.value }))

/** "3h ago", reading the shared clock so the cell ticks. */
function lastActiveLabel(at: number): string {
  void now.value
  return timeAgo(at)
}

/** What the shared row draws for one CLI login (components/InstanceRow.vue). */
function rowModel(inst: CliInstance): InstanceRowModel {
  const plan = planFor(inst)
  // The plan has its own column, so it stays out of the name.
  const name = withoutPlanSuffix(inst.name, plan)
  return {
    id: inst.id,
    num: inst.num,
    dimmed: isDimmed(inst),
    status: {
      on: inst.loggedIn,
      title: inst.loggedIn ? t('cliInstances.loggedIn') : t('cliInstances.loggedOut'),
    },
    name: {
      shown: shortDisplayName(name, nameMax),
      tooltip: (clipped) =>
        nameTooltipFor(
          { full: name, shown: shortDisplayName(name, nameMax), folder: inst.configDir },
          clipped,
        ),
    },
    // The name IS the account here; only a legacy pasted credential adds a second line.
    account: { fallback: inst.associatedAccountLabel },
    lastRunning: inst.lastActiveAt
      ? {
          label: lastActiveLabel(inst.lastActiveAt),
          running: (inst.liveSessions ?? 0) > 0,
          title: new Date(inst.lastActiveAt).toLocaleString(),
        }
      : null,
    configDir: inst.configDir,
    usage: {
      snapshot: usageFor(inst),
      checking: isChecking(usageKey(inst)) || isBusy(inst),
      key: usageKey(inst),
      onCheck: () => void onCheckUsageFromPopover(inst),
    },
    plan: plan ? { label: plan } : null,
    tokens: tokenPartsFor(inst.tokens, tokenWindow.value),
    menu: { name: inst.name, actions: menuActionsFor(inst), class: 'max-w-56' },
  }
}

const linkedLabel = (inst: CliInstance) =>
  t('cliInstances.linkedTo', {
    num: linkedDesktop(inst)?.num,
    name: linkedDesktop(inst) ? displayName(linkedDesktop(inst)!) : '',
  })

/** What the table says when it has no rows: the filter took them all, or there are none yet. */
const emptyState = computed(() =>
  visibleRows.value.length > 0 || loading.value
    ? null
    : allHiddenByFilter.value
      ? {
          icon: Funnel,
          title: t('instances.filterAllHidden'),
          hint: t('instances.filterAllHiddenHint'),
        }
      : { icon: Terminal, title: t('cliInstances.empty'), hint: t('cliInstances.emptyHint') },
)

function isBusy(inst: CliInstance): boolean {
  return busyIds.value.has(inst.id)
}

// --- rename ---
const renameOpen = ref(false)
const renameTarget = ref<CliInstance | null>(null)
const renaming = ref(false)
const renameError = ref<string | null>(null)
function openRenameDialog(inst: CliInstance) {
  renameTarget.value = inst
  renameError.value = null
  renameOpen.value = true
}
async function onRenameSubmit(name: string) {
  const inst = renameTarget.value
  if (!inst) return
  renaming.value = true
  renameError.value = null
  try {
    const result = await rename(inst.id, name)
    if (result?.ok) {
      toast.success(t('cliInstances.toastRenamed'))
      renameOpen.value = false
      renameTarget.value = null
    } else {
      renameError.value = result?.message ?? t('cliInstances.toastRenameFailed')
    }
  } finally {
    renaming.value = false
  }
}

// --- associate ---
const associateOpen = ref(false)
const associateTarget = ref<CliInstance | null>(null)
const associating = ref(false)
const associateError = ref<string | null>(null)
function openAssociateDialog(inst: CliInstance) {
  associateTarget.value = inst
  associateError.value = null
  associateOpen.value = true
  void refreshAccounts()
}
async function onAssociateSubmit(accountId: string | null) {
  const inst = associateTarget.value
  if (!inst) return
  associating.value = true
  associateError.value = null
  try {
    const result = await associate(inst.id, accountId)
    if (result?.ok) {
      toast.success(t('cliInstances.toastAssociated'))
      associateOpen.value = false
      associateTarget.value = null
    } else {
      associateError.value = result?.message ?? t('cliInstances.toastAssociateFailed')
    }
  } finally {
    associating.value = false
  }
}

// --- link to a desktop instance ---
const linkOpen = ref(false)
const linkTarget = ref<CliInstance | null>(null)
const linking = ref(false)
const linkError = ref<string | null>(null)
function openLinkDialog(inst: CliInstance) {
  linkTarget.value = inst
  linkError.value = null
  linkOpen.value = true
}
/** Unlink straight from the row's menu, as the Instances table's linked-CLI menu does. */
async function onUnlink(inst: CliInstance) {
  const result = await linkDesktop(inst.id, null)
  if (result?.ok) toast.success(t('cliInstances.toastUnlinked'))
  else toast.error(result?.message ?? t('cliInstances.toastLinkFailed'))
}
async function onLinkSubmit(desktopDir: string | null) {
  const inst = linkTarget.value
  if (!inst) return
  linking.value = true
  linkError.value = null
  try {
    const result = await linkDesktop(inst.id, desktopDir)
    if (result?.ok) {
      toast.success(desktopDir ? t('cliInstances.toastLinked') : t('cliInstances.toastUnlinked'))
      linkOpen.value = false
      linkTarget.value = null
    } else {
      linkError.value = result?.message ?? t('cliInstances.toastLinkFailed')
    }
  } finally {
    linking.value = false
  }
}

// --- delete ---
const deleteOpen = ref(false)
const deleteTarget = ref<CliInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDeleteDialog(inst: CliInstance) {
  deleteTarget.value = inst
  deleteError.value = null
  deleteOpen.value = true
}
async function onDeleteConfirm(confirmName: string) {
  const inst = deleteTarget.value
  if (!inst) return
  deleting.value = true
  deleteError.value = null
  try {
    const result = await remove(inst.id, confirmName)
    if (result?.ok) {
      toast.success(t('cliInstances.toastDeleted'))
      // Quick add must not sign in again into an instance that is gone.
      if (quickAddTarget.value?.id === inst.id) clearQuickAddTarget()
      deleteOpen.value = false
      deleteTarget.value = null
    } else {
      deleteError.value = result?.message ?? t('cliInstances.toastDeleteFailed')
    }
  } finally {
    deleting.value = false
  }
}

// --- limit reset: the CLI's own /limit-reset, confirmed first (CliLimitResetDialog.vue) ---
const limitResetOpen = ref(false)
const limitResetTarget = ref<CliInstance | null>(null)
function openLimitReset(inst: CliInstance) {
  limitResetTarget.value = inst
  limitResetOpen.value = true
}
async function onLimitResetDone() {
  const inst = limitResetTarget.value
  await refreshCliInstances({ silent: true })
  // A reset changes the quota numbers; read them again rather than show the old ones.
  if (inst) void checkUsage(inst.id)
}

// --- log out: a plain confirm first, the same dialog the desktop and Codex rows use ---
const logoutOpen = ref(false)
const logoutTarget = ref<CliInstance | null>(null)
const loggingOut = ref(false)
function openLogout(inst: CliInstance) {
  logoutTarget.value = inst
  logoutOpen.value = true
}
async function onLogoutConfirm() {
  const inst = logoutTarget.value
  if (!inst) return
  loggingOut.value = true
  try {
    const result = await logout(inst.id)
    if (result?.ok) toast.success(t('cliInstances.toastLogout'))
    else toast.error(result?.message ?? t('cliInstances.toastLogoutFailed'))
  } finally {
    loggingOut.value = false
    logoutOpen.value = false
    logoutTarget.value = null
  }
}

// --- launch / login / check usage ---
async function onLaunch(inst: CliInstance) {
  const result = await launch(inst.id)
  if (result?.ok) toast.success(t('cliInstances.toastLaunched'))
  else toast.error(result?.message ?? t('cliInstances.toastLaunchFailed'))
}
// "Log in" signs this instance in again through Quick add, not a terminal running /login (owner,
// 2026-09-30): point the box at it, bring it into view and put the cursor in its email field.
// The header's plus asks the same of it with no target: Quick add shows its email row on request
// (owner, 2026-10-02), and it replaced the dialog that created an instance by name.
const quickAdd = ref<{ focusEmail: () => void } | null>(null)
async function onLogin(inst: CliInstance) {
  setQuickAddTarget({ id: inst.id, num: inst.num, name: inst.name })
  await nextTick()
  quickAdd.value?.focusEmail()
}
async function onCheckUsage(inst: CliInstance) {
  const ok = await checkUsage(inst.id)
  if (!ok) {
    toast.error(t('cliInstances.toastUsageCheckFailed'))
    return
  }
  // The API call itself can succeed while still coming back with no usable numbers (no
  // login yet, no associated account, or the probe returned nothing). A manual click should
  // never go silent; a real result just updates the cell instead.
  const reasonKey = usageReasonMessageKey(reasonFor(usageKey(inst)))
  if (reasonKey) toast.error(t(reasonKey))
}
/** Blank this row's old 5-hour and weekly numbers until its next reading; nothing is deleted. */
async function onClearUsage(inst: CliInstance) {
  if (await clearUsage([usageKey(inst)])) toast.success(t('cliInstances.toastUsageCleared'))
  else toast.error(t('cliInstances.toastUsageClearFailed'))
}
// The popover's inline "Check now" fires the same underlying probe as the kebab action, via
// useUsage.checkCli directly. checkUsage() above additionally refreshes the list (so
// lastUsageCheck / other fields stay current), which the popover doesn't need on its own.
async function onCheckUsageFromPopover(inst: CliInstance) {
  const ok = await checkCli(inst.id)
  if (!ok) {
    toast.error(t('cliInstances.toastUsageCheckFailed'))
  } else {
    const reasonKey = usageReasonMessageKey(reasonFor(usageKey(inst)))
    if (reasonKey) toast.error(t(reasonKey))
  }
  void refreshCliInstances({ silent: true })
}

// The keepalive's switch (server/src/session-keepalive.ts): the same setting as in Settings, here
// behind the table's gear.
const {
  keepaliveEnabled,
  keepaliveWeeklyFloorPct,
  loaded: settingsLoaded,
  load: loadSettings,
  update: updateSettings,
} = useAppSettings()
// A switch turned on runs a pass at once; its nudges reach the rows on a refresh 15 s later. One
// pending refresh at a time, and none after the tab is left.
let keepaliveRefresh: ReturnType<typeof setTimeout> | null = null
const clearKeepaliveRefresh = (): void => {
  if (keepaliveRefresh !== null) clearTimeout(keepaliveRefresh)
  keepaliveRefresh = null
}
async function onKeepaliveSwitch(value: boolean) {
  if (!(await updateSettings({ keepaliveEnabled: value }))) {
    toast.error(t('cliInstances.keepaliveSaveFailed'))
    return
  }
  clearKeepaliveRefresh()
  if (value)
    keepaliveRefresh = setTimeout(() => {
      keepaliveRefresh = null
      void refreshCliInstances({ silent: true })
    }, 15_000)
}
async function onKeepaliveFloor(value: string | number) {
  if (!(await updateSettings({ keepaliveWeeklyFloorPct: Number(value) })))
    toast.error(t('cliInstances.keepaliveSaveFailed'))
}
/** A row's nudge note: shown while the window a nudge started still runs, or for six hours after a
 *  nudge that did not start one (it is tried again after an hour; the note says why it failed). */
function nudgeNote(inst: CliInstance): { ok: boolean; label: string; description: string } | null {
  const n = inst.lastNudge
  if (!n) return null
  const nowMs = now.value.getTime()
  if (n.ok) {
    const until = windowResetMs(n.resetsAt) ?? n.at + windowLengthMs('5h')
    if (!(until > nowMs)) return null
    return {
      ok: true,
      label: t('cliInstances.nudgedLabel', { ago: timeAgo(n.at) }),
      description: t('cliInstances.nudgedHint', {
        when: new Date(until).toLocaleString(),
        model: n.model ?? 'Haiku',
        cost: n.costUsd == null ? '?' : formatUsd(n.costUsd),
      }),
    }
  }
  if (nowMs - n.at > 6 * 3_600_000) return null
  return {
    ok: false,
    label: t('cliInstances.nudgeFailedLabel'),
    description: t('cliInstances.nudgeFailedHint', { note: n.note, ago: timeAgo(n.at) }),
  }
}

// Move logins to the other PC (CliLoginMoveDialog.vue, server/src/core/cli-login-move.ts).
const moveOpen = ref(false)
const moveMode = ref<'out' | 'in'>('out')
const movePreselect = ref<string[]>([])
function openMoveOut(inst: CliInstance) {
  moveMode.value = 'out'
  movePreselect.value = [inst.id]
  moveOpen.value = true
}
/** Login sync through the owner's own store (CliLoginSyncDialog.vue, core/cli-login-sync.ts). */
const syncOpen = ref(false)
function openMoveIn() {
  moveMode.value = 'in'
  movePreselect.value = []
  moveOpen.value = true
}

/** The icon row at the top of a row's kebab (InstanceMenuHeader), in the order every table uses. */
function menuActionsFor(inst: CliInstance): MenuIconAction[] {
  return [
    {
      key: 'checkUsage',
      icon: RefreshCw,
      label: t('cliInstances.checkUsage'),
      run: () => void onCheckUsage(inst),
      spin: isChecking(usageKey(inst)),
      disabled: isBusy(inst),
    },
    {
      key: 'rename',
      icon: Pencil,
      label: t('cliInstances.rename'),
      closes: true,
      run: () => openRenameDialog(inst),
      disabled: isBusy(inst),
    },
    {
      key: 'logout',
      icon: LogOut,
      label: t('cliInstances.logout'),
      closes: true,
      run: () => openLogout(inst),
      disabled: !inst.loggedIn || isBusy(inst),
    },
  ]
}

const associateAccountOptions = computed(() => accounts.value)

onMounted(() => {
  startPolling()
  // The server's usage cache, every few seconds, as the Instances tab reads it: a window the
  // keepalive started (or the background sweep re-read) lands there and nowhere else, so without
  // this a row stayed blank until something on the page asked again (owner, 2026-10-02).
  startUsagePolling()
  if (!settingsLoaded.value) void loadSettings()
  if (desktopInstances.value.length === 0) void refreshInstances({ silent: true })
})
onUnmounted(() => {
  stopPolling()
  stopUsagePolling()
  clearKeepaliveRefresh()
})
</script>

<template>
  <!-- No border-t: the parent (CliView) separates this table from CliMayte with space instead. -->
  <div>
    <!-- The shared header every instance table uses; the count says "x of y" while the filter
         sets rows aside (see headingCount). It folds the table away (owner, 2026-10-01: "the
         list of accounts should be collapsable"), which leaves CliMayte below the whole window;
         folded, the header carries the two pooled gauges. Its plus shows Quick add's email row. -->
    <InstanceSectionHeader
      v-model:open="accountsOpen"
      provider="claude"
      :title="$t('cliInstances.title')"
      :count="headingCount"
      :refresh-label="$t('cliInstances.refresh')"
      :refreshing="loading"
      :create-label="$t('cliInstances.createInstance')"
      @refresh="refreshCliInstances()"
      @create="quickAdd?.focusEmail()"
    >
      <!-- Only while folded: open, the rows say it per account. -->
      <template #summary>
        <PooledUsageGauges
          v-if="!accountsOpen && cliInstances.length > 0"
          :session="sessionPool"
          :week="weekPool"
        />
      </template>
      <template #tools>
        <!-- This table's own settings, behind a gear on the table (owner, 2026-10-01: a setting
             lives on the page where he would look for it, and "Keep windows running" is a setting,
             not a labelled switch across the header). The Popover root sits INSIDE the tooltip's
             slot: see scripts/checks/reka-popper-root-inside-tooltip.mjs. -->
        <IconTooltip :label="$t('cliInstances.tableSettings')">
          <span class="inline-flex">
            <Popover>
              <PopoverTrigger as-child>
                <Button
                  variant="outline"
                  size="icon"
                  :aria-label="$t('cliInstances.tableSettings')"
                >
                  <Settings2 />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-64">
                <div class="flex items-center gap-1.5 text-xs">
                  <label class="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3">
                    <span class="flex items-center gap-1.5">
                      <Timer class="size-3.5 text-muted-foreground" />
                      {{ $t('cliInstances.keepaliveSwitch') }}
                    </span>
                    <!-- Drawn once the setting is known: a switch that starts off and turns itself
                         on a moment later reads as one that moved by itself (SUE round, 2026-10-01). -->
                    <Switch
                      v-if="settingsLoaded"
                      :model-value="keepaliveEnabled"
                      :aria-label="$t('cliInstances.keepaliveSwitch')"
                      @update:model-value="onKeepaliveSwitch"
                    />
                    <Skeleton v-else class="h-4 w-7" />
                  </label>
                  <InfoHint
                    :text="$t('cliInstances.keepaliveSwitchHint', { floor: keepaliveWeeklyFloorPct })"
                  />
                </div>
                <!-- Its one number, here with it (it was in the Settings panel's Providers section). -->
                <div v-if="settingsLoaded && keepaliveEnabled" class="mt-2 flex items-center gap-1.5 text-xs">
                  <label class="flex min-w-0 flex-1 items-center justify-between gap-3">
                    {{ $t('settings.keepaliveFloorLabel') }}
                    <Input
                      class="w-16"
                      type="number"
                      min="0"
                      max="100"
                      :model-value="keepaliveWeeklyFloorPct"
                      @update:model-value="onKeepaliveFloor"
                    />
                  </label>
                  <InfoHint :text="$t('settings.keepaliveFloorHint')" />
                </div>
              </PopoverContent>
            </Popover>
          </span>
        </IconTooltip>
        <!-- A cloud and nothing else (owner, 2026-10-01: "The login sync should just be the icon of
             a cloud"); its name is the tooltip. -->
        <IconTooltip :label="$t('cliInstances.sync')" :description="$t('cliInstances.syncHint')">
          <Button
            variant="outline"
            size="icon"
            :aria-label="$t('cliInstances.sync')"
            @click="syncOpen = true"
          >
            <Cloud />
          </Button>
        </IconTooltip>
        <IconTooltip :label="$t('cliInstances.moveIn')">
          <Button
            variant="outline"
            size="icon"
            :aria-label="$t('cliInstances.moveIn')"
            @click="openMoveIn"
          >
            <FileDown />
          </Button>
        </IconTooltip>
      </template>
      <template #meta>
        <span v-if="hiddenByFilter > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
        </span>
      </template>
    </InstanceSectionHeader>

    <!-- Quick add: type an email, confirm in the browser, the new CLI instance lands in the table.
         It draws nothing until the header's plus (or a row's "Log in") asks for its email row. -->
    <CliQuickAdd
      ref="quickAdd"
      class="px-3 pb-3"
      @signed-in="refreshCliInstances({ silent: true })"
    />

    <!-- As long as its rows: unfolded, the table never scrolls inside itself, the tab scrolls instead
         (owner, 2026-10-01: "make this not scroll when expanded (just make it long)"). -->
    <div v-show="accountsOpen">
      <!-- visibleRows, not cliInstances: with the usage filter set to hide, this table can be
           emptied while it still has rows to show, and a blank tbody explains nothing. -->
      <InstanceTable
        :columns="columns"
        :indicator-for="indicatorFor"
        :skeleton="loading && visibleRows.length === 0"
        :skeleton-rows="2"
        :empty="emptyState"
        @sort="toggleSort"
      >
        <TableBody v-if="visibleRows.length > 0">
          <InstanceRow v-for="inst in visibleRows" :key="inst.id" :columns="columns" :row="rowModel(inst)">
            <template #name-extra>
              <!-- Linked to a desktop instance: the same account, also shown on that row in the
                   Instances tab. The chip names the row by its number; the hover says the rest. -->
              <IconTooltip
                v-if="linkedDesktop(inst)"
                :label="linkedLabel(inst)"
                :description="$t('cliInstances.linkedToHint')"
              >
                <span class="inline-flex items-center gap-0.5 text-muted-foreground" :aria-label="linkedLabel(inst)">
                  <Monitor class="size-3.5" />
                  <InstanceNumber :num="linkedDesktop(inst)!.num" />
                </span>
              </IconTooltip>
              <!-- How many Claude sessions run on this login right now, CliMayte's workers included.
                   Hidden at 0: an idle account needs no badge saying so. Green, the colour of
                   running (owner, 2026-10-01: "that should be green, not blue"). -->
              <IconTooltip
                v-if="(inst.liveSessions ?? 0) > 0"
                :label="$t('cliInstances.liveSessions', inst.liveSessions ?? 0)"
              >
                <span
                  class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-success/15 px-1 text-3xs font-semibold tabular-nums text-success"
                  :aria-label="$t('cliInstances.liveSessions', inst.liveSessions ?? 0)"
                >
                  {{ inst.liveSessions }}
                </span>
              </IconTooltip>
              <CliLimitResetIcon :result="inst.lastLimitReset" />
              <!-- The keepalive started this window, or its last nudge did not (session-keepalive.ts). -->
              <IconTooltip
                v-if="nudgeNote(inst)"
                :label="nudgeNote(inst)!.label"
                :description="nudgeNote(inst)!.description"
              >
                <span class="inline-flex items-center" :aria-label="nudgeNote(inst)!.label">
                  <Timer
                    class="size-3.5"
                    :class="nudgeNote(inst)!.ok ? 'text-info' : 'text-warning'"
                  />
                </span>
              </IconTooltip>
              <!-- Its login went to the other PC from here (cli-login-move.ts). -->
              <IconTooltip
                v-if="inst.movedAway"
                :label="$t('cliInstances.movedAwayLabel')"
                :description="
                  $t('cliInstances.movedAwayHint', {
                    ago: timeAgo(inst.movedAway.at),
                    file: inst.movedAway.file,
                  })
                "
              >
                <span class="inline-flex items-center" :aria-label="$t('cliInstances.movedAwayLabel')">
                  <ArrowRightLeft class="size-3.5 text-muted-foreground" />
                </span>
              </IconTooltip>
              <!-- Paid extra usage ON: past its limits this account bills instead of stopping. -->
              <IconTooltip
                v-if="billsPastLimit(usageFor(inst))"
                :label="$t('instances.usageCreditsOn')"
                :description="$t('instances.extraUsageOnHint')"
              >
                <span class="inline-flex items-center" :aria-label="$t('instances.usageCreditsOn')">
                  <CreditCard class="size-3.5 text-warning" />
                </span>
              </IconTooltip>
            </template>
            <template #menu>
              <!-- Launch lives here, not on the row (owner, 2026-10-01: "I kinda never need to
                   launch the cli"). -->
              <DropdownMenuItem :disabled="isBusy(inst)" @click="onLaunch(inst)">
                <Play /> {{ $t('cliInstances.launch') }}
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="isBusy(inst)" @click="onLogin(inst)">
                <LogIn /> {{ $t('cliInstances.login') }}
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="isBusy(inst)" @click="openLinkDialog(inst)">
                <Monitor /> {{ $t('cliInstances.linkDesktop') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="linkedDesktop(inst)"
                :disabled="isBusy(inst)"
                @click="onUnlink(inst)"
              >
                <Unlink /> {{ $t('instances.unlinkCli') }}
              </DropdownMenuItem>
              <!-- "Associate account" points a CLI instance at a LEGACY pasted credential.
                   With none saved (the norm now — accounts come from signing in instances),
                   the dialog is an empty dead end, so hide it until such a credential exists.
                   "Link to desktop instance" above is the primary path either way. -->
              <DropdownMenuItem
                v-if="associateAccountOptions.length > 0"
                :disabled="isBusy(inst)"
                @click="openAssociateDialog(inst)"
              >
                <Link2 /> {{ $t('cliInstances.associate') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="inst.loggedIn"
                :disabled="isBusy(inst)"
                @click="openLimitReset(inst)"
              >
                <RotateCcw /> {{ $t('cliInstances.limitReset') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="inst.loggedIn"
                :disabled="isBusy(inst) || (inst.liveSessions ?? 0) > 0"
                @click="openMoveOut(inst)"
              >
                <ArrowRightLeft /> {{ $t('cliInstances.moveOut') }}
              </DropdownMenuItem>
              <!-- A signed-out account keeps its last reading, dimmed; this blanks it until
                   the next reading (owner, 2026-10-02). -->
              <DropdownMenuItem :disabled="!usageFor(inst)" @click="onClearUsage(inst)">
                <Eraser /> {{ $t('cliInstances.clearUsage') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                :disabled="isBusy(inst)"
                @click="openDeleteDialog(inst)"
              >
                <Trash2 /> {{ $t('cliInstances.delete') }}
              </DropdownMenuItem>
            </template>
          </InstanceRow>
        </TableBody>
      </InstanceTable>
    </div>

    <CliInstanceNameDialog
      v-model:open="renameOpen"
      mode="rename"
      :current-name="renameTarget?.name ?? null"
      :submitting="renaming"
      :error-message="renameError"
      @submit="onRenameSubmit"
    />
    <AssociateCliInstanceDialog
      v-model:open="associateOpen"
      :instance-name="associateTarget?.name ?? null"
      :accounts="associateAccountOptions"
      :current-account-id="associateTarget?.associatedAccountId ?? null"
      :submitting="associating"
      :error-message="associateError"
      @submit="onAssociateSubmit"
    />
    <LinkCliInstanceDialog
      v-model:open="linkOpen"
      :instance-name="linkTarget?.name ?? null"
      :desktop-instances="desktopInstances"
      :current-desktop-dir="linkTarget?.associatedDesktopDir ?? null"
      :submitting="linking"
      :error-message="linkError"
      @submit="onLinkSubmit"
    />
    <DeleteInstanceDialog
      namespace="cliInstances"
      v-model:open="deleteOpen"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="deleting"
      :error-message="deleteError"
      @confirm="onDeleteConfirm"
    />
    <LogoutInstanceDialog
      v-model:open="logoutOpen"
      :instance-name="logoutTarget?.name ?? null"
      :account-email="logoutTarget?.associatedAccountLabel ?? null"
      :description="$t('cliInstances.logoutDialogDescription')"
      :submitting="loggingOut"
      @confirm="onLogoutConfirm"
    />
    <CliLimitResetDialog
      v-model:open="limitResetOpen"
      :instance="limitResetTarget"
      @done="onLimitResetDone"
    />
    <CliLoginSyncDialog v-model:open="syncOpen" @changed="refreshCliInstances({ silent: true })" />
    <CliLoginMoveDialog
      v-model:open="moveOpen"
      :mode="moveMode"
      :instances="cliInstances"
      :preselect="movePreselect"
      @done="refreshCliInstances({ silent: true })"
    />
  </div>
</template>
