<script setup lang="ts">
// CLI Instances: the table of CLI logins that DON'T belong to a desktop instance yet.
// A "CLI instance" is an isolated CLAUDE_CONFIG_DIR the daemon can run a real `claude` against (as
// opposed to a Claude Desktop profile).
//
// This table used to list every CLI instance. It no longer does: once one is LINKED to a desktop
// instance it is the same Anthropic account signed in twice, so it moves UP onto that account's row
// in InstancesView and disappears from here. Listing it in both places was the half-measure that
// made the "unified per-account view" not actually unified. Full lifecycle (create / rename /
// associate / delete) still lives here; the account row carries launch / sign-in / unlink.
import {
  ArrowDown,
  ArrowUp,
  CreditCard,
  EllipsisVertical,
  Funnel,
  Link2,
  LogIn,
  LogOut,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
} from '@lucide/vue'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AssociateCliInstanceDialog from '@/components/AssociateCliInstanceDialog.vue'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import CliLimitResetDialog from '@/components/CliLimitResetDialog.vue'
import CliLimitResetIcon from '@/components/CliLimitResetIcon.vue'
import CliQuickAdd from '@/components/CliQuickAdd.vue'
import CopyResetDate from '@/components/CopyResetDate.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import InstanceMenuHeader, { type MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import InstanceSectionHeader from '@/components/InstanceSectionHeader.vue'
import LinkCliInstanceDialog from '@/components/LinkCliInstanceDialog.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import UsageBadge from '@/components/UsageBadge.vue'
import UsageBar from '@/components/UsageBar.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useInstances } from '@/composables/useInstances'
import { useQuickAddTarget } from '@/composables/useQuickAddTarget'
import { useSortable } from '@/composables/useSortable'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliInstance } from '@/lib/api'
import { nameOverflowTitle, shortDisplayName } from '@/lib/instance-appearance'
import { billsPastLimit, bindingWeeklyPct, usageReasonMessageKey } from '@/lib/usage'
import {
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'
import IconTooltip from '@/shell/IconTooltip.vue'

const {
  cliInstances,
  loading,
  busyIds,
  startPolling,
  stopPolling,
  refreshCliInstances,
  create,
  launch,
  logout,
  rename,
  associate,
  linkDesktop,
  remove,
  checkUsage,
} = useCliInstances()
const { snapshotFor, isChecking, checkCli, reasonFor } = useUsage()
const { accounts, refreshAccounts } = useData()
// The desktop instances are the link targets. useInstances is a module singleton that the Instances
// tab keeps loaded; this table lives on the CLI tab, so a window opened straight onto it reads the
// list once on mount (below), or every linked CLI instance would show here as unlinked.
const { instances: desktopInstances, refreshInstances } = useInstances()
const { target: quickAddTarget, setQuickAddTarget, clearQuickAddTarget } = useQuickAddTarget()

const { t } = useI18n()

const usageKey = (inst: CliInstance) => `cli:${inst.id}`
const usageFor = (inst: CliInstance) => snapshotFor(usageKey(inst))

// Usage mode is a TAB-WIDE mode, not a per-table one (see composables/useUsageMode.ts): the toolbar
// toggle up in InstancesView flips this table too, because "how much quota is left" is a question
// you ask of every instance at once. Here the swap trades the config-dir column — the least useful
// thing on screen when you're asking about quota — for the two reset countdowns.
const { usageMode, now } = useUsageMode(true)
const sessionResetFor = (inst: CliInstance) => resetLabel(usageFor(inst)?.session, now.value)
const weeklyResetFor = (inst: CliInstance) => resetLabel(usageFor(inst)?.weekAll, now.value)
// One number per window drives the bar's length; the WEEKLY one also drives its colour, and the
// 5-hour bar is drawn `neutral` — see InstancesView and UsageBar's UsageBarVariant.
const sessionRemaining = (inst: CliInstance) =>
  windowRemainingPct(usageFor(inst)?.session, SESSION_WINDOW_MS, now.value) ?? 0
const weeklyRemaining = (inst: CliInstance) =>
  windowRemainingPct(usageFor(inst)?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0
const weeklyWait = (inst: CliInstance) => waitSeverity(weeklyRemaining(inst))

/**
 * ONLY the UNLINKED CLI instances live in this table.
 *
 * A CLI instance that has been linked to a desktop instance is the same Anthropic account signed in
 * twice, so it belongs to that account, not to a separate list. It is rendered on its desktop
 * instance's row up in InstancesView (that row IS the account) and is deliberately NOT repeated
 * here — showing it in both places is duplication, not a unified view. "Unlink" on the account row
 * sends it back down here.
 *
 * "Unlinked" also covers a CLI instance whose associatedDesktopDir no longer matches any CURRENTLY
 * existing desktop instance — a ghost link. removeInstance() clears the link server-side when its
 * desktop instance is deleted (core/lifecycle.ts), but checking desktopInstances here too is a
 * frontend backstop: if that cleanup were ever bypassed, a CLI instance pointing at a vanished
 * desktop dir would otherwise stay "linked" forever — hidden from this table with no row left to
 * show it, and so unmanageable. Comparing against the live desktop list guarantees it always
 * surfaces somewhere.
 */
const unlinkedCliInstances = computed(() => {
  const desktopDirs = new Set(desktopInstances.value.map((i) => i.dir))
  return cliInstances.value.filter(
    (c) => !c.associatedDesktopDir || !desktopDirs.has(c.associatedDesktopDir),
  )
})
/** How many moved up onto a desktop instance's row (so the header can explain the shortfall). */
const linkedCount = computed(() => cliInstances.value.length - unlinkedCliInstances.value.length)

const { sortedRows, toggleSort, indicatorFor } = useSortable(
  () => unlinkedCliInstances.value,
  [
    { key: 'loggedIn', accessor: (i: CliInstance) => i.loggedIn },
    { key: 'name', accessor: (i: CliInstance) => i.name },
    { key: 'account', accessor: (i: CliInstance) => i.associatedAccountLabel ?? null },
    { key: 'configDir', accessor: (i: CliInstance) => i.configDir },
    // Usage-mode columns — by time remaining, so "soonest reset first" is what a sort gives you.
    {
      key: 'session',
      accessor: (i: CliInstance) => msUntilReset(usageFor(i)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (i: CliInstance) => msUntilReset(usageFor(i)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (i: CliInstance) => {
        const snap = usageFor(i)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    { key: 'usageSession', accessor: (i: CliInstance) => usageFor(i)?.session?.pct ?? undefined },
  ],
  undefined,
  { rowKey: (i: CliInstance) => i.id },
)

// The filter is tab-wide too (composables/useInstanceFilter.ts): "show me the rows I'm after" is
// asked of every table at once, so a CLI login over the quota threshold is set aside here on
// exactly the same terms as a desktop instance up above.
const { dimmed: filterDimmed, visible: filterVisible } = useInstanceFilter()

/**
 * What one CLI row is, as far as the filter is concerned.
 *
 * `open` is deliberately absent, not `false`: an unlinked CLI login is a CLAUDE_CONFIG_DIR, not an
 * app, so it is never open OR closed, and the filter's "an unknown fact never sets a row aside"
 * rule leaves this table alone when you filter by status. Claiming `false` would empty it the
 * moment someone asked for the open accounts. Its plan is unknown for the same kind of reason —
 * a CLI login carries no account record of its own; the linked ones live on their desktop row,
 * which has the plan.
 */
const filterFacts = (inst: CliInstance) => ({ usage: usageFor(inst), signedIn: inst.loggedIn })

const visibleRows = computed(() => filterVisible(sortedRows.value, filterFacts))
/** Rows this table dropped for the filter — said out loud in the heading beside the count. */
const hiddenByFilter = computed(() => sortedRows.value.length - visibleRows.value.length)
/** There ARE unlinked CLI instances, the filter just took all of them. */
const allHiddenByFilter = computed(
  () => unlinkedCliInstances.value.length > 0 && visibleRows.value.length === 0,
)

/**
 * The heading's parenthetical. "x of y" whenever this table is showing fewer rows than there are
 * CLI instances — for either reason, a linked one that moved up onto its account row or one the
 * usage filter set aside. A bare "(0)" read as "you have no CLI instances" to someone who could
 * plainly see one elsewhere, which is the whole reason this says the total.
 */
const headingCount = computed(() =>
  visibleRows.value.length === cliInstances.value.length
    ? String(cliInstances.value.length)
    : t('cliInstances.countOfTotal', {
        shown: visibleRows.value.length,
        total: cliInstances.value.length,
      }),
)

function isBusy(inst: CliInstance): boolean {
  return busyIds.value.has(inst.id)
}

// --- create ---
const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
function openCreateDialog() {
  createError.value = null
  createOpen.value = true
}
async function onCreateSubmit(name: string) {
  creating.value = true
  createError.value = null
  try {
    const result = await create(name)
    if (result?.ok) {
      toast.success(t('cliInstances.toastCreated'))
      createOpen.value = false
    } else {
      createError.value = result?.message ?? t('cliInstances.toastCreateFailed')
    }
  } finally {
    creating.value = false
  }
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
  if (desktopInstances.value.length === 0) void refreshInstances({ silent: true })
})
onUnmounted(() => stopPolling())
</script>

<template>
  <!-- No border-t: the parent (CliView) separates this table from CliMayte with space instead. -->
  <div>
    <!-- The shared header every instance table uses; the count says "x of y" when rows are
         elsewhere (see headingCount). Not collapsible: it is the CLI tab's own table, and folding
         it away would leave the tab's first screen empty. -->
    <InstanceSectionHeader
      :collapsible="false"
      provider="claude"
      :title="$t('cliInstances.title')"
      :count="headingCount"
      :refresh-label="$t('cliInstances.refresh')"
      :refreshing="loading"
      :create-label="$t('cliInstances.createInstance')"
      @refresh="refreshCliInstances()"
      @create="openCreateDialog"
    >
      <template #meta>
        <!-- Linked ones aren't missing, they've moved onto their account's row in the Instances
             tab. Say so, or their absence from this count reads as a bug. -->
        <span v-if="linkedCount > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('cliInstances.linkedElsewhere', { count: linkedCount }) }}
        </span>
        <span v-if="hiddenByFilter > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
        </span>
      </template>
    </InstanceSectionHeader>

    <!-- Quick add: type an email, confirm in the browser, the new CLI instance lands in the table. -->
    <CliQuickAdd
      ref="quickAdd"
      class="px-3 pb-3"
      @signed-in="refreshCliInstances({ silent: true })"
    />

    <Table>
      <TableHeader sticky>
        <TableRow>
          <TableHead class="w-10 cursor-pointer select-none" @click="toggleSort('loggedIn')">
            <span class="inline-flex items-center gap-0.5">
              ● <ArrowUp v-if="indicatorFor('loggedIn') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('loggedIn') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="w-44 cursor-pointer select-none" @click="toggleSort('name')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('cliInstances.colName') }}
              <ArrowUp v-if="indicatorFor('name') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('name') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="w-40 cursor-pointer select-none" @click="toggleSort('account')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('cliInstances.colAccount') }}
              <ArrowUp v-if="indicatorFor('account') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('account') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead
            v-if="!usageMode"
            class="cursor-pointer select-none"
            @click="toggleSort('configDir')"
          >
            <span class="inline-flex items-center gap-0.5">
              {{ $t('cliInstances.colConfigDir') }}
              <ArrowUp v-if="indicatorFor('configDir') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('configDir') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <!-- Fixed widths, matching the Instances table's quota columns, so the same fact has the
               same bar length on both tabs. -->
          <template v-else>
            <TableHead class="w-28 cursor-pointer select-none" @click="toggleSort('session')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colSession') }}
                <ArrowUp v-if="indicatorFor('session') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('session') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="w-28 cursor-pointer select-none" @click="toggleSort('weekly')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colWeekly') }}
                <ArrowUp v-if="indicatorFor('weekly') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('weekly') === 'desc'" class="size-3" />
              </span>
            </TableHead>
          </template>
          <TableHead
            v-if="usageMode"
            class="w-24 cursor-pointer select-none"
            @click="toggleSort('usageSession')"
          >
            <span class="inline-flex items-center gap-0.5">
              {{ $t('instances.colUsageSession') }}
              <ArrowUp v-if="indicatorFor('usageSession') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('usageSession') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="w-24 cursor-pointer select-none" @click="toggleSort('usage')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('cliInstances.colUsage') }}
              <ArrowUp v-if="indicatorFor('usage') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('usage') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <!-- The account's plan, the same badge as the Instances table (owner, 2026-09-30). -->
          <TableHead class="w-24">{{ $t('instances.colPlan') }}</TableHead>
          <TableHead class="text-end">{{ $t('cliInstances.colActions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <!-- visibleRows, not unlinkedCliInstances: with the usage filter set to hide, this table can
           be emptied while it still has rows to show, and a blank tbody explains nothing. -->
      <TableBody v-if="visibleRows.length === 0">
        <TableEmpty v-if="!loading" :colspan="usageMode ? 9 : 7">
          <div class="flex flex-col items-center gap-1 text-center">
            <component :is="allHiddenByFilter ? Funnel : Terminal" class="mb-1 size-6 opacity-40" />
            <p class="font-medium text-foreground">
              {{
                allHiddenByFilter
                  ? $t('instances.filterAllHidden')
                  : linkedCount > 0
                    ? $t('cliInstances.allLinked')
                    : $t('cliInstances.empty')
              }}
            </p>
            <p class="text-xs text-muted-foreground">
              {{
                allHiddenByFilter
                  ? $t('instances.filterAllHiddenHint')
                  : linkedCount > 0
                    ? $t('cliInstances.allLinkedHint')
                    : $t('cliInstances.emptyHint')
              }}
            </p>
          </div>
        </TableEmpty>
        <TableRow v-for="i in 2" v-else :key="i">
          <TableCell><Skeleton class="size-2" /></TableCell>
          <TableCell><Skeleton class="h-4 w-28" /></TableCell>
          <TableCell><Skeleton class="h-5 w-20" /></TableCell>
          <TableCell v-if="!usageMode"><Skeleton class="h-3 w-32" /></TableCell>
          <template v-else>
            <TableCell><Skeleton class="h-8 w-16" /></TableCell>
            <TableCell><Skeleton class="h-8 w-16" /></TableCell>
            <TableCell><Skeleton class="h-5 w-14" /></TableCell>
          </template>
          <TableCell><Skeleton class="h-5 w-14" /></TableCell>
          <TableCell><Skeleton class="h-5 w-14" /></TableCell>
          <TableCell>
            <div class="flex justify-end"><Skeleton class="h-6 w-20" /></div>
          </TableCell>
        </TableRow>
      </TableBody>
      <TableBody v-else>
        <!-- Dimmed, never disabled, and inert to the pointer — same contract as the desktop table
             above: a filtered row is one you've set aside, not one you've lost access to, and it
             shouldn't light up every time the cursor crosses it. -->
        <TableRow
          v-for="inst in visibleRows"
          :key="inst.id"
          :variant="filterDimmed(filterFacts(inst)) ? 'faded' : 'default'"
        >
          <TableCell>
            <span
              class="inline-block size-2 rounded-full"
              :class="inst.loggedIn ? 'bg-success' : 'bg-muted-foreground/40'"
              :title="inst.loggedIn ? $t('cliInstances.loggedIn') : $t('cliInstances.loggedOut')"
            />
          </TableCell>
          <TableCell>
            <!-- Same chip as the desktop table on purpose: the number comes from ONE sequence
                 spanning all three instance families, so it must look identical everywhere or
                 that guarantee stops being obvious. -->
            <div class="flex items-center gap-1.5 font-medium">
              <InstanceNumber :num="inst.num" />
              <!-- Capped to the column like the desktop table's name, with the full name on
                   hover: these are names a person typed, so nothing stops one being a sentence,
                   and table layout is auto — one long name widens this column and the three
                   stacked tables stop lining up. Native title, not IconTooltip: this cell has no
                   other hover to extend, and the row above it already reveals its path this way. -->
              <span :title="nameOverflowTitle(inst.name)">{{ shortDisplayName(inst.name) }}</span>
              <!-- How many Claude sessions run on this login right now, CliMayte's workers included.
                   Hidden at 0: an idle account needs no badge saying so. -->
              <IconTooltip
                v-if="(inst.liveSessions ?? 0) > 0"
                :label="$t('cliInstances.liveSessions', inst.liveSessions ?? 0)"
              >
                <span
                  class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-info/15 px-1 text-3xs font-semibold tabular-nums text-info"
                  :aria-label="$t('cliInstances.liveSessions', inst.liveSessions ?? 0)"
                >
                  {{ inst.liveSessions }}
                </span>
              </IconTooltip>
              <CliLimitResetIcon :result="inst.lastLimitReset" />
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
            </div>
          </TableCell>
          <TableCell>
            <Badge v-if="inst.associatedAccountLabel" variant="outline">
              {{ inst.associatedAccountLabel }}
            </Badge>
            <span v-else class="text-xs text-muted-foreground">{{ $t('cliInstances.noAccount') }}</span>
          </TableCell>
          <TableCell v-if="!usageMode" class="max-w-[16rem]">
            <span class="mono block truncate text-3xs text-muted-foreground">{{ inst.configDir }}</span>
          </TableCell>
          <template v-else>
            <TableCell>
              <UsageBar
                v-if="sessionResetFor(inst)"
                :fill-pct="sessionRemaining(inst)"
                variant="neutral"
                :label="sessionResetFor(inst) ?? ''"
                :aria-label="$t('instances.resetsIn', { when: sessionResetFor(inst) })"
              />
              <span v-else class="text-muted-foreground">—</span>
            </TableCell>
            <TableCell>
              <CopyResetDate v-if="weeklyResetFor(inst)" :limit="usageFor(inst)?.weekAll">
                <UsageBar
                  :fill-pct="weeklyRemaining(inst)"
                  :variant="weeklyWait(inst)"
                  :label="weeklyResetFor(inst) ?? ''"
                  :aria-label="$t('instances.resetsIn', { when: weeklyResetFor(inst) })"
                />
              </CopyResetDate>
              <span v-else class="text-muted-foreground">—</span>
            </TableCell>
          </template>
          <TableCell v-if="usageMode">
            <UsageBadge
              scope="session"
              :snapshot="usageFor(inst)"
              :checking="isChecking(usageKey(inst)) || isBusy(inst)"
              :usage-key="usageKey(inst)"
              @check="onCheckUsageFromPopover(inst)"
            />
          </TableCell>
          <TableCell>
            <UsageBadge
              :snapshot="usageFor(inst)"
              :checking="isChecking(usageKey(inst)) || isBusy(inst)"
              :usage-key="usageKey(inst)"
              @check="onCheckUsageFromPopover(inst)"
            />
          </TableCell>
          <TableCell>
            <Badge v-if="inst.planLabel" variant="outline">{{ inst.planLabel }}</Badge>
            <span v-else class="text-xs text-muted-foreground">—</span>
          </TableCell>
          <TableCell>
            <div class="flex items-center justify-end gap-1">
              <Button variant="outline" size="sm" :disabled="isBusy(inst)" @click="onLaunch(inst)">
                <Play /> {{ $t('cliInstances.launch') }}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="$t('cliInstances.moreActions')"
                  >
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-56">
                  <!-- Which instance this menu belongs to, by number, then its quick actions as
                       icons — the same header on every table's kebab. -->
                  <InstanceMenuHeader :num="inst.num" :actions="menuActionsFor(inst)" />
                  <DropdownMenuItem :disabled="isBusy(inst)" @click="onLogin(inst)">
                    <LogIn /> {{ $t('cliInstances.login') }}
                  </DropdownMenuItem>
                  <DropdownMenuItem :disabled="isBusy(inst)" @click="openLinkDialog(inst)">
                    <Monitor /> {{ $t('cliInstances.linkDesktop') }}
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    :disabled="isBusy(inst)"
                    @click="openDeleteDialog(inst)"
                  >
                    <Trash2 /> {{ $t('cliInstances.delete') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <CliInstanceNameDialog
      v-model:open="createOpen"
      mode="create"
      :submitting="creating"
      :error-message="createError"
      @submit="onCreateSubmit"
    />
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
  </div>
</template>
