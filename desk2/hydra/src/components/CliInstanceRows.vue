<script setup lang="ts">
// The CLI login rows of the one Instances table (owner, 2026-10-07: one Instances table, Desktop, CLI
// and Free as toggles). InstancesView.vue owns the card, the header, the table, the skeleton, the empty
// state, the heading count and Quick add; this renders ONLY one shared InstanceRow per CLI login (the
// columns it is handed, the model it builds), plus this kind's dialogs (reka dialogs teleport, so they
// can sit beside the rows).
//
// A "CLI instance" is an isolated CLAUDE_CONFIG_DIR the daemon can run a real `claude` against (as
// opposed to a Claude Desktop profile).
//
// One LINKED to a desktop instance is the same Anthropic account signed in twice. It shows on that
// account's row (the ⌨ icon) AND here, marked with a chip naming the row (owner, 2026-10-03: "When I
// add a CLI instance... it needs to also add it to the CLI row... I need to see it over there"). Full
// lifecycle (create / rename / associate / link / delete) lives here; the account row carries
// launch / sign-in / unlink as well.
import {
  ArrowRightLeft,
  CreditCard,
  Eraser,
  Gauge,
  Link2,
  LogIn,
  LogOut,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlink,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AssociateCliInstanceDialog from '@/components/AssociateCliInstanceDialog.vue'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import CliLimitResetDialog from '@/components/CliLimitResetDialog.vue'
import CliLimitResetIcon from '@/components/CliLimitResetIcon.vue'
import CliLoginMoveDialog from '@/components/CliLoginMoveDialog.vue'
import CliLoginSyncDialog from '@/components/CliLoginSyncDialog.vue'
import CliPlacementDialog from '@/components/CliPlacementDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import LinkCliInstanceDialog from '@/components/LinkCliInstanceDialog.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { TableBody } from '@/components/ui/table'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { quotaSortColumns, useInstanceSource } from '@/composables/useInstanceSource'
import { useInstances } from '@/composables/useInstances'
import { pii, piiDisplayName, piiName } from '@/composables/usePrivacy'
import { useQuickAddTarget } from '@/composables/useQuickAddTarget'
import { useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliInstance } from '@/lib/api'
import { formatUsd, timeAgo } from '@/lib/format'
import { shortDisplayName } from '@/lib/instance-appearance'
import { searchText } from '@/lib/instance-filter'
import {
  type InstanceColumn,
  type InstanceRowModel,
  nameTooltipFor,
  withoutPlanSuffix,
} from '@/lib/instance-table'
import { tokenPartsFor } from '@/lib/token-window'
import { billsPastLimit, usageReasonMessageKey, windowLengthMs, windowResetMs } from '@/lib/usage'
import { planSize } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'

// The table's column list (lib/instance-table.ts): the one the header draws, so the cells follow it.
defineProps<{ columns: InstanceColumn[] }>()
// A row's "Log in" has pointed Quick add at it, or the header's plus asked for a new one (no target):
// the host owns <CliQuickAdd> and focuses its email row.
const emit = defineEmits<{ quickAdd: [] }>()

const {
  cliInstances,
  loading,
  busyIds,
  startPolling,
  refreshCliInstances,
  launch,
  logout,
  rename,
  setPlacement,
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
  hydrate: hydrateUsage,
} = useUsage()
const { accounts, refreshAccounts } = useData()
// The desktop instances are the link targets. useInstances is a module singleton that the Instances
// tab keeps loaded; a window opened straight onto this table reads the list once on mount (below),
// or every linked CLI instance would show here without its link chip.
const { instances: desktopInstances, refreshInstances } = useInstances()
const { target: quickAddTarget, setQuickAddTarget, clearQuickAddTarget } = useQuickAddTarget()

const { t } = useI18n()

const usageKey = (inst: CliInstance) => `cli:${inst.id}`
const usageFor = (inst: CliInstance) => snapshotFor(usageKey(inst))

// Usage mode is a TAB-WIDE mode, not a per-table one (see composables/useUsageMode.ts): with one
// table it is the desktop table's mode (owner, 2026-10-07), so no 'cli' argument. The swap trades the
// config-dir column, the least useful thing on screen when you're asking about quota, for the two
// reset countdowns.
const { now } = useUsageMode(true)

/**
 * EVERY CLI instance lives in this table, the linked ones included.
 *
 * A linked one is the same Anthropic account as its desktop instance, signed in twice, so the
 * desktop row shows it too (the ⌨ icon). It used to be listed ONLY there, and a login added from a
 * desktop row then never appeared as a CLI row at all (owner, 2026-10-03: "I need to see it over
 * there"). Here it keeps its own row and a chip naming the desktop row it belongs to.
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
const filterFacts = (inst: CliInstance) => ({
  usage: usageFor(inst),
  signedIn: inst.loggedIn,
  search: searchText(
    inst.num,
    inst.name,
    inst.associatedAccountLabel,
    inst.associatedDesktopLabel,
    inst.planLabel,
    'cli',
  ),
})

// One token window for the whole table (owner, 2026-10-07): the desktop table's.
const tokenWindow = useDesktopTokenWindow()

// One sort for the whole table: these rows follow the sort the header's click remembers (the persisted
// key InstancesView sorts the Claude rows by), under the same column keys. A key these rows hold no
// fact for (uptime, memory, pid) leaves them in list order.
const { desktopSortKey, desktopSortDirection } = useUiPrefs()

const { visibleRows, hiddenByFilter, isDimmed } = useInstanceSource({
  rows: () => cliInstances.value,
  rowKey: (i: CliInstance) => i.id,
  facts: filterFacts,
  persisted: { key: desktopSortKey, direction: desktopSortDirection },
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

/** "3h ago", reading the shared clock so the cell ticks. */
function lastActiveLabel(at: number): string {
  void now.value
  return timeAgo(at)
}

/** The address the login's own `.claude.json` names (accountEmail), else the one quick add named it
 *  after, else the linked account's label when it is one, else none (owner, 2026-10-06). It is also
 *  what "Log in again" puts back in Quick add's email box. */
function previousEmailOf(inst: CliInstance): string | null {
  if (inst.accountEmail) return inst.accountEmail
  const name = withoutPlanSuffix(inst.name, planFor(inst))
  return name.includes('@')
    ? name
    : inst.associatedAccountLabel?.includes('@')
      ? inst.associatedAccountLabel
      : null
}

/** The address "Log in again" puts back: only for a login that ended by itself (its credential file is still
 *  there and the daemon noted it dead, loginNote). A log out you chose deletes the file, so that row offers a
 *  plain "Log in" with an empty box (owner, 2026-10-06: "Sign in again is for accounts that got logged out"). */
function reloginEmailOf(inst: CliInstance): string | null {
  return !inst.loggedIn && inst.loginNote ? previousEmailOf(inst) : null
}

/** What the shared row draws for one CLI login (components/InstanceRow.vue). */
function rowModel(inst: CliInstance): InstanceRowModel {
  const plan = planFor(inst)
  // The plan has its own column, so it stays out of the name.
  const name = withoutPlanSuffix(inst.name, plan)
  const email = previousEmailOf(inst)
  return {
    id: inst.id,
    num: inst.num,
    dimmed: isDimmed(inst),
    status: {
      on: inst.loggedIn,
      title: inst.loggedIn ? t('cliInstances.loggedIn') : t('cliInstances.loggedOut'),
    },
    name: {
      shown: shortDisplayName(pii(name), nameMax),
      tooltip: (clipped) =>
        nameTooltipFor(
          {
            full: pii(name),
            shown: shortDisplayName(pii(name), nameMax),
            email: email && pii(email),
            account: inst.accountName && piiName(inst.accountName),
            folder: inst.configDir,
            copyHint: t('instances.nameCopyHint'),
          },
          clipped,
        ),
      copy: email,
    },
    // The name IS the account here.
    account: {},
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
    remoteWorkers: inst.remoteWorkers,
    menu: { name: inst.name, actions: menuActionsFor(inst), width: 'md' },
  }
}

const linkedLabel = (inst: CliInstance) =>
  t('cliInstances.linkedTo', {
    num: linkedDesktop(inst)?.num,
    name: linkedDesktop(inst) ? piiDisplayName(linkedDesktop(inst)!) : '',
  })

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

/** The priority and caps dialog (CliPlacementDialog.vue): how much of AgentHydra's work this account gets. */
const placementOpen = ref(false)
const placementTarget = ref<CliInstance | null>(null)
const placementSaving = ref(false)
const placementError = ref<string | null>(null)
function openPlacement(inst: CliInstance) {
  placementTarget.value = inst
  placementError.value = null
  placementOpen.value = true
}
async function onPlacementSubmit(placement: {
  priority: number
  maxSessionPct: number | null
  maxWeekPct: number | null
}) {
  const inst = placementTarget.value
  if (!inst) return
  placementSaving.value = true
  placementError.value = null
  try {
    const result = await setPlacement(inst.id, placement)
    if (result?.ok) {
      toast.success(t('cliInstances.toastPlacementSaved'))
      placementOpen.value = false
      placementTarget.value = null
    } else {
      placementError.value = result?.message ?? t('cliInstances.toastPlacementFailed')
    }
  } finally {
    placementSaving.value = false
  }
}

const PRIORITY_KEYS: Record<number, string> = {
  2: 'cliInstances.priorityTop',
  1: 'cliInstances.priorityHigh',
  [-1]: 'cliInstances.priorityLow',
}

/** The row's chip for a priority other than Normal or a cap: its words, and the hover that explains them.
 *  Null for a plain account. */
function placementChip(inst: CliInstance): { text: string; label: string } | null {
  const p = inst.placement
  if (!p) return null
  const level = PRIORITY_KEYS[p.priority]
  const caps =
    p.maxSessionPct == null && p.maxWeekPct == null
      ? null
      : `${p.maxSessionPct ?? 85}/${p.maxWeekPct ?? 85}%`
  if (!level && !caps) return null
  const text = [level ? t(level) : null, caps].filter(Boolean).join(' · ')
  return {
    text,
    label: t('cliInstances.placementChip', {
      priority: t(level ?? 'cliInstances.priorityNormal'),
      session: p.maxSessionPct ?? 85,
      week: p.maxWeekPct ?? 85,
    }),
  }
}
const placementChips = computed(
  () => new Map(visibleRows.value.map((i) => [i.id, placementChip(i)])),
)

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
/** Unlink straight from the row's menu, as the desktop row's linked-CLI menu does. */
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
// 2026-09-30): point the box at it and tell the host to bring it into view and put the cursor in its
// email field. The header's plus asks the same of it with no target (openCreate below): Quick add
// shows its email row on request (owner, 2026-10-02), and it replaced the dialog that created an
// instance by name. The host owns the Quick add element now, so this emits instead of focusing it.
function onLogin(inst: CliInstance) {
  setQuickAddTarget({
    id: inst.id,
    num: inst.num,
    name: inst.name,
    email: reloginEmailOf(inst),
  })
  emit('quickAdd')
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
        model: n.model ?? 'Haiku 5.5',
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

// One model and one nudge note per visible row, built once per change instead of in the template.
const rowModels = computed(() => new Map(visibleRows.value.map((i) => [i.id, rowModel(i)])))
const nudgeNotes = computed(() => new Map(visibleRows.value.map((i) => [i.id, nudgeNote(i)])))

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
function openSync() {
  syncOpen.value = true
}
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
  // The server's usage cache: a window the keepalive started (or the background sweep re-read) lands
  // there and nowhere else, so a row stays blank until something asks. Read now; lib/warm-data.ts
  // reads it again about every 2 minutes.
  void hydrateUsage()
  if (desktopInstances.value.length === 0) void refreshInstances({ silent: true })
})

// The host's header: the plus asks for Quick add's email row with no target, Refresh re-reads the
// list and the usage cache, and the count and filter note read the numbers below (the host reads them
// through a ref, so plain values, as CodexInstanceRows does).
function openCreate() {
  emit('quickAdd')
}
async function refresh() {
  await Promise.all([refreshCliInstances(), hydrateUsage()])
}
const refreshing = computed(() => loading.value)
const visibleCount = computed(() => visibleRows.value.length)
const total = computed(() => cliInstances.value.length)
defineExpose({
  openCreate,
  refresh,
  refreshing,
  hiddenByFilter,
  visibleCount,
  total,
  loading,
  openSync,
  openMoveIn,
})
</script>

<template>
  <TableBody v-if="visibleRows.length > 0">
    <InstanceRow
      v-for="inst in visibleRows"
      :key="inst.id"
      :columns="columns"
      :row="rowModels.get(inst.id)!"
    >
      <template #name-extra>
        <!-- Linked to a desktop instance: the same account, also shown on that row. The chip names
             the row by its number; the hover says the rest. -->
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
        <!-- The owner's priority and caps for AgentHydra's work here (CliPlacementDialog.vue). -->
        <IconTooltip
          v-if="placementChips.get(inst.id)"
          :label="placementChips.get(inst.id)!.label"
        >
          <span
            class="inline-flex items-center gap-0.5 rounded-full bg-info/10 px-1.5 text-3xs font-semibold text-info"
            :aria-label="placementChips.get(inst.id)!.label"
          >
            <Gauge class="size-3" />
            {{ placementChips.get(inst.id)!.text }}
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
      <!-- The keepalive started this 5-hour window, or its last nudge did not (session-keepalive.ts):
           a dot on the 5-hour counter, not an icon by the name (owner, 2026-10-06). At half strength:
           a note, not an alarm (owner, 2026-10-06: "about half as vibrant"). -->
      <template #session-mark>
        <IconTooltip
          v-if="nudgeNotes.get(inst.id)"
          :label="nudgeNotes.get(inst.id)!.label"
          :description="nudgeNotes.get(inst.id)!.description"
        >
          <span
            role="img"
            class="block size-2 rounded-full ring-2 ring-background"
            :class="nudgeNotes.get(inst.id)!.ok ? 'bg-info/50' : 'bg-warning/50'"
            :aria-label="nudgeNotes.get(inst.id)!.label"
          />
        </IconTooltip>
      </template>
      <template #menu>
        <!-- Launch lives here, not on the row (owner, 2026-10-01: "I kinda never need to
             launch the cli"). -->
        <DropdownMenuItem :disabled="isBusy(inst)" @click="onLaunch(inst)">
          <Play /> {{ $t('cliInstances.launch') }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!inst.loggedIn" :disabled="isBusy(inst)" @click="onLogin(inst)">
          <LogIn /> {{ reloginEmailOf(inst) ? $t('cliInstances.loginAgain') : $t('cliInstances.login') }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="isBusy(inst)" @click="openPlacement(inst)">
          <Gauge /> {{ $t('cliInstances.placement') }}
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

  <!-- The dialogs teleport to <body>, so sitting beside the rows puts nothing inside the table. -->
  <CliInstanceNameDialog
    v-model:open="renameOpen"
    mode="rename"
    :current-name="renameTarget?.name ?? null"
    :submitting="renaming"
    :error-message="renameError"
    @submit="onRenameSubmit"
  />
  <CliPlacementDialog
    v-model:open="placementOpen"
    :instance-name="placementTarget ? pii(placementTarget.name) : null"
    :current="placementTarget?.placement ?? null"
    :submitting="placementSaving"
    :error-message="placementError"
    @submit="onPlacementSubmit"
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
</template>
