<script setup lang="ts">
import {
  AppWindow,
  ArrowRightLeft,
  Boxes,
  Coins,
  Cpu,
  CreditCard,
  EllipsisVertical,
  Eraser,
  FolderOpen,
  Funnel,
  Gauge,
  LogIn,
  LogOut,
  MessagesSquare,
  MonitorDown,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Unlink,
  UserRound,
} from '@lucide/vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CodexInstanceRows from '@/components/CodexInstanceRows.vue'
import CopyResetDate from '@/components/CopyResetDate.vue'
import CreateInstanceDialog from '@/components/CreateInstanceDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import DshInstanceRows from '@/components/DshInstanceRows.vue'
import EditInstanceDialog from '@/components/EditInstanceDialog.vue'
import InstanceAccountBadge from '@/components/InstanceAccountBadge.vue'
import InstanceChatsDialog from '@/components/InstanceChatsDialog.vue'
import InstanceFilterMenu from '@/components/InstanceFilterMenu.vue'
import InstanceGlyph from '@/components/InstanceGlyph.vue'
import InstanceMenuHeader, { type MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import InstanceSectionHeader from '@/components/InstanceSectionHeader.vue'
import InstanceSettings from '@/components/InstanceSettings.vue'
import LoginHistoryPopover from '@/components/LoginHistoryPopover.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import PageSettingsDialog from '@/components/PageSettingsDialog.vue'
import ProviderLogo, { type Provider } from '@/components/ProviderLogo.vue'
import QuitExternalInstanceDialog from '@/components/QuitExternalInstanceDialog.vue'
import SortButton from '@/components/SortButton.vue'
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { useAppSettings } from '@/composables/useAppSettings'
import { useClaudeAppHints } from '@/composables/useClaudeAppHints'
import { useCliInstances } from '@/composables/useCliInstances'
import { useCodexInstances } from '@/composables/useCodexInstances'
import { useDshInstances } from '@/composables/useDshInstances'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useInstances } from '@/composables/useInstances'
import { useMoveAllChats } from '@/composables/useMoveAllChats'
import { useSortable } from '@/composables/useSortable'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { ChatListRow, CliInstance, CMDesktopInstall, CMInstance } from '@/lib/api'
import {
  CLASSIC_DESKTOP_INSTALLER_URL,
  DESKTOP_DOWNLOAD_PAGE_URL,
  getChatCounts,
  getDesktopInstall,
} from '@/lib/api'
import { formatBytes, formatUptime, timeAgo } from '@/lib/format'
import {
  accountDisplayName,
  accountEmail,
  accountHandle,
  displayName,
  labelDisagreesWithAccount,
  shortDisplayName,
} from '@/lib/instance-appearance'
import type { InstanceFacts } from '@/lib/instance-filter'
import { groupByProject } from '@/lib/session-groups'
import { requestSessionJump } from '@/lib/session-jump'
import { useTooltipConfig } from '@/lib/tooltip-config'
import { billsPastLimit, bindingWeeklyPct, usageReasonMessageKey } from '@/lib/usage'
import { runUsageCatchup, selectUsageCatchup } from '@/lib/usage-catchup'
import { planSize } from '@/lib/usage-pool'
import {
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const {
  instances,
  loading,
  busyDirs,
  startPolling,
  stopPolling,
  refreshInstances,
  open,
  quit,
  focus,
  logout,
  revealFolder,
  createShortcut,
  create,
  remove,
  setAppearance,
} = useInstances()

const { t } = useI18n()
const { enabled: tooltipsEnabled } = useTooltipConfig()
const {
  snapshotFor,
  clearUsage,
  isChecking,
  checkDesktop,
  checkCodex,
  reasonFor,
  hydrated: usageHydrated,
  startPolling: startUsagePolling,
  stopPolling: stopUsagePolling,
} = useUsage()

const usageKeyFor = (inst: CMInstance) => `desktop:${inst.dir}`
const usageFor = (inst: CMInstance) => snapshotFor(usageKeyFor(inst))

// What only the running Claude app serves: the row's banked-reset, credit and billing hints.
const { resetBankedHint, codeCreditFor, codeCreditLabel, codeCreditHint, usageCreditsHint } =
  useClaudeAppHints(usageFor)

// --- usage mode ---------------------------------------------------------------------------------
// One toolbar toggle swaps the PROCESS columns (PID / uptime / memory — "is it healthy?") for the
// QUOTA columns ("how much is left, and when does it come back?"). See composables/useUsageMode.ts
// for why it's a mode rather than a per-column picker. `now` is the shared clock every countdown
// cell in both tables formats against, so the whole tab ticks together.
const { usageMode, toggle: toggleUsageMode, now } = useUsageMode(true)

/** "2h 14m" left on a window, or null when there is no reset instant to count down to. */
function sessionResetFor(inst: CMInstance): string | null {
  return resetLabel(usageFor(inst)?.session, now.value)
}
function weeklyResetFor(inst: CMInstance): string | null {
  return resetLabel(usageFor(inst)?.weekAll, now.value)
}
// How much of each window is still to run — the bar's LENGTH, on both windows.
function sessionRemaining(inst: CMInstance): number {
  return windowRemainingPct(usageFor(inst)?.session, SESSION_WINDOW_MS, now.value) ?? 0
}
function weeklyRemaining(inst: CMInstance): number {
  return windowRemainingPct(usageFor(inst)?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0
}
// Colour, on the WEEKLY window only. Same number as the length (waitSeverity bands it as a
// fraction of its own window), so short+green = nearly back and long+red = most of the week still
// ahead. The 5-hour bar beside it is drawn `neutral` — see UsageBar's UsageBarVariant for why the
// row spends its colour on the window that decides whether an account is worth starting on.
function weeklyWait(inst: CMInstance) {
  return waitSeverity(weeklyRemaining(inst))
}

// The sort survives a reload: persisted through useUiPrefs. It orders the Claude rows; the Codex
// and DeepSeek rows below them keep their own order.
const { desktopSortKey, desktopSortDirection } = useUiPrefs()

const { sortedRows, toggleSort, indicatorFor } = useSortable(
  () => instances.value,
  [
    { key: 'running', accessor: (i: CMInstance) => i.isRunning },
    // sort by what the cell actually shows (the display label, falling back to folder name)
    { key: 'name', accessor: (i: CMInstance) => displayName(i) },
    // Sort by what the cell actually shows (see accountCellName).
    { key: 'account', accessor: (i: CMInstance) => accountCellName(i) },
    { key: 'pid', accessor: (i: CMInstance) => i.pid ?? undefined },
    { key: 'uptime', accessor: (i: CMInstance) => (i.isRunning ? i.startTime : null) },
    { key: 'memory', accessor: (i: CMInstance) => i.memoryBytes ?? undefined },
    // Usage-mode columns. Sorted by TIME REMAINING, not by the reset timestamp string: "soonest
    // reset first" is the ordering anyone asking this question wants, and it is stable as the
    // clock advances because every row shifts by the same amount.
    {
      key: 'session',
      accessor: (i: CMInstance) => msUntilReset(usageFor(i)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (i: CMInstance) => msUntilReset(usageFor(i)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (i: CMInstance) => {
        const snap = usageFor(i)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    { key: 'usageSession', accessor: (i: CMInstance) => usageFor(i)?.session?.pct ?? undefined },
    // By plan size (Pro 1, Max 5x 5, Max 20x 20), not the label's spelling; no plan sorts last.
    { key: 'plan', accessor: (i: CMInstance) => planSize(i.account?.planLabel) },
    // By the instant, not the "3h ago" text, so the order is true across units.
    {
      key: 'lastRunning',
      accessor: (i: CMInstance) =>
        i.isRunning
          ? Number.MAX_SAFE_INTEGER
          : i.lastRunningAt
            ? Date.parse(i.lastRunningAt)
            : undefined,
    },
  ],
  { key: desktopSortKey, direction: desktopSortDirection },
  { rowKey: (i: CMInstance) => i.dir },
)

/** "Now" while it runs, else "3h ago" since it was last seen running on this PC (owner,
 *  2026-09-30: last running, not last launched). Reads the shared clock so the cell ticks. */
function lastRunningLabel(inst: CMInstance): string {
  void now.value
  return inst.isRunning ? t('instances.lastRunningNow') : timeAgo(inst.lastRunningAt)
}
/** The exact local time behind the relative label, for the hover. */
function lastRunningExact(inst: CMInstance): string | undefined {
  if (!inst.lastRunningAt) return undefined
  const at = Date.parse(inst.lastRunningAt)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : undefined
}

// --- filter -----------------------------------------------------------------------------------
// "Show me the rows I'm after" (composables/useInstanceFilter.ts): open or closed, which plan, how
// much quota is left. It runs AFTER the sort — it removes or greys rows, it never reorders them.
// Its provider choice decides which providers' rows the table draws at all (see "which providers
// the table draws" below).
const {
  dimmed: filterDimmed,
  visible: filterVisible,
  providerShown,
  showProvider,
} = useInstanceFilter()

/** What one row is, as far as the filter is concerned. A desktop instance knows all three facts:
 *  it has a window that is open or shut, and an account with a plan and a quota reading. */
const filterFacts = (inst: CMInstance): InstanceFacts => ({
  usage: usageFor(inst),
  open: inst.isRunning,
  plan: inst.account?.planLabel ?? null,
  // `loginUuid`, not `account`: account is resolved lazily and is null for a second after every
  // refresh, which would make signed-in rows flicker out of a filtered table. loginUuid is read
  // straight off config.json with every list.
  signedIn: inst.loginUuid != null,
})

const visibleRows = computed(() => filterVisible(sortedRows.value, filterFacts))

/**
 * The plan labels the FILTER FLYOUT offers, gathered from every provider it can act on.
 *
 * Read from the module-scope singletons rather than passed down, because the plans on offer are a
 * property of the whole tab, not of the Claude rows: filtering to "Pro" has to be possible when the
 * only Pro account on the machine is a Codex one. Reading `instances` does not start Codex's
 * polling — its rows are rendered below and do their own — so an unused provider simply
 * contributes nothing. (CLI logins have no plan of their own: a linked one shares its desktop row's
 * account, and an unlinked one carries no account record at all.)
 */
const { instances: codexInstances, refresh: refreshCodex } = useCodexInstances()
const presentPlans = computed(() => [
  ...instances.value.map((i) => i.account?.planLabel),
  ...codexInstances.value.map((i) => i.account?.planLabel),
])

const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)

const deleteOpen = ref(false)
const deleteTarget = ref<CMInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

const editOpen = ref(false)
const editTarget = ref<CMInstance | null>(null)
const editing = ref(false)
const editError = ref<string | null>(null)

// What the name cell PRINTS: the row's name, cut to the column's width (see shortDisplayName).
// Sorting, filtering, the move submenu and every dialog keep using displayName() — the cut is for
// this one cell, and a truncated name must never become a value anything acts on.
function nameCellText(inst: CMInstance): string {
  return shortDisplayName(displayName(inst))
}

// The name cell's hover, and the only place the FULL name is readable once the cell elides it
// (owner directive, 2026-09-11: cap the name, hover for the rest).
//
// Three facts compete for two lines here, so the cut decides the order. A name that fits keeps the
// hover exactly as it was — folder on top, "click to focus" under it — because repeating text the
// cell is already showing in full is noise. A name that was cut leads with the full name and pushes
// the other two down a line each; `detail` on IconTooltip exists for that third line.
function nameTooltip(inst: CMInstance): { label: string; description?: string; detail?: string } {
  const full = displayName(inst)
  const focus = inst.isRunning ? t('instances.focusHint') : undefined
  return nameCellText(inst) === full && clippedName.value !== inst.dir
    ? { label: inst.dir, description: focus }
    : { label: full, description: inst.dir, detail: focus }
}

// The name column also gives way when the window is narrow, so the CSS can elide a name the
// character cap left whole. Measured on hover, the one moment the tooltip is about to be read,
// so a name cut either way leads its hover with the full text.
const clippedName = ref<string | null>(null)
function noteNameClip(e: PointerEvent, inst: CMInstance): void {
  const el = e.currentTarget as HTMLElement
  clippedName.value = el.scrollWidth > el.clientWidth ? inst.dir : null
}

// The account cell identifies the LOGIN, so it shows the email handle and nothing else — see
// accountHandle for why it is no longer accountName. The account's own label is the last resort so
// a logged-out row still reads "(not logged in)" instead of collapsing to "Resolving…".
function accountCellName(inst: CMInstance): string | null {
  return accountHandle(inst.account) ?? inst.account?.label ?? null
}

// The pill itself (hover, copy-the-full-address click) is InstanceAccountBadge, shared by every
// provider's rows.
function accountBadgeVariant(inst: CMInstance) {
  switch (inst.account?.status) {
    case 'live':
      return 'success' as const
    case 'cache':
    case 'offline':
      return 'warning' as const
    case 'loggedout':
      return 'outline' as const
    default:
      return 'ghost' as const
  }
}

async function handleRefresh() {
  // fresh: bypass the server's 5-minute detection cache so installing the classic build and
  // hitting Refresh actually clears the warning banner below.
  // force: re-resolve every account live. Accounts resolve themselves now, so this button is the
  // one way left to say "that identity is stale, go ask again" (e.g. after a plan upgrade).
  // The Codex and DeepSeek rows share this table, so the one Refresh reloads them too.
  await Promise.all([
    refreshInstances({ force: true, resolve: 'full' }),
    refreshDesktopInstall(true),
    ...(codexEnabled.value ? [refreshRows(codexRows.value, () => refreshCodex())] : []),
    ...(dshEnabled.value ? [refreshRows(dshRows.value, () => refreshDsh())] : []),
  ])
}

async function onCheckUsage(inst: CMInstance) {
  const ok = await checkDesktop(inst.dir)
  if (!ok) {
    toast.error(t('instances.toastUsageCheckFailed'))
    return
  }
  // The API call itself can succeed while still coming back with no usable numbers (not
  // signed in, no usage-capable token, or the probe returned nothing). A manual click should
  // never go silent, so surface the reason; a real result just updates the cell.
  const reasonKey = usageReasonMessageKey(reasonFor(usageKeyFor(inst)))
  if (reasonKey) toast.error(t(reasonKey))
}

/** Blank this row's old 5-hour and weekly numbers until its next reading; nothing is deleted. */
async function onClearUsage(inst: CMInstance) {
  if (await clearUsage([usageKeyFor(inst)])) toast.success(t('instances.toastUsageCleared'))
  else toast.error(t('instances.toastUsageClearFailed'))
}

// Which providers to show, and the CLI instances (so "refresh all" covers them too, not just
// desktop).
const {
  showDesktopInstances,
  showCliInstances,
  codexDesktopEnabled,
  codexCliEnabled,
  dshEnabled,
  load: loadAppSettings,
} = useAppSettings()
const {
  cliInstances,
  startPolling: startCliPolling,
  stopPolling: stopCliPolling,
  checkUsage: checkCliUsage,
  create: createCli,
  launch: launchCli,
  login: loginCli,
  linkDesktop: linkCliDesktop,
  remove: removeCli,
} = useCliInstances()
onMounted(loadAppSettings)

// --- which providers the table draws ------------------------------------------------------------
// One table for every desktop instance (owner, 2026-09-30): the Claude rows here, then the Codex
// and DeepSeek rows, which are their own components rendering the same ten cells. A provider's rows
// are drawn when Settings → Providers has it on AND the filter's provider choice keeps it.
const { instances: dshInstances, refresh: refreshDsh } = useDshInstances()
const codexEnabled = computed(() => codexDesktopEnabled.value || codexCliEnabled.value)
const claudeShown = computed(() => showDesktopInstances.value && providerShown('claude'))
const codexShown = computed(() => codexEnabled.value && providerShown('codex'))
const dshShown = computed(() => dshEnabled.value && providerShown('deepseek'))

/**
 * What CodexInstanceRows and DshInstanceRows hand this table through defineExpose. `refresh` and
 * `visibleCount` are optional: a component that filters its own rows can say how many it drew, and
 * one that does not draws its whole list.
 */
interface ProviderRowsHandle {
  openCreate: () => void
  refresh?: () => unknown
  visibleCount?: number
}
/** The gear's dialog: this tab's own settings (InstanceSettings.vue). */
const instanceSettingsOpen = ref(false)
const codexRows = ref<ProviderRowsHandle | null>(null)
const dshRows = ref<ProviderRowsHandle | null>(null)

/** A row component's own refresh while it is mounted, else the bare list, so a provider the filter
 *  is leaving out still has a current count. */
function refreshRows(rows: ProviderRowsHandle | null, list: () => unknown): unknown {
  return rows?.refresh ? rows.refresh() : list()
}

// Rows per provider: every row Settings lets this tab list, and the rows actually drawn.
const claudeTotal = computed(() => (showDesktopInstances.value ? instances.value.length : 0))
const codexTotal = computed(() => (codexEnabled.value ? codexInstances.value.length : 0))
const dshTotal = computed(() => (dshEnabled.value ? dshInstances.value.length : 0))
const claudeDrawn = computed(() => (claudeShown.value ? visibleRows.value.length : 0))
const codexDrawn = computed(() =>
  codexShown.value ? (codexRows.value?.visibleCount ?? codexInstances.value.length) : 0,
)
const dshDrawn = computed(() =>
  dshShown.value ? (dshRows.value?.visibleCount ?? dshInstances.value.length) : 0,
)
const totalRows = computed(() => claudeTotal.value + codexTotal.value + dshTotal.value)
const shownRows = computed(() => claudeDrawn.value + codexDrawn.value + dshDrawn.value)
/** How many rows the filter (its provider choice included) took out of the table — the heading has
 *  to say so, or an instance that quietly stopped being listed reads as a bug rather than as the
 *  filter working. */
const hiddenByFilter = computed(() => totalRows.value - shownRows.value)
/** Every row filtered away. The table is not empty (there ARE instances), so the empty state has to
 *  explain the filter rather than tell the user to create their first instance. */
const allHiddenByFilter = computed(() => totalRows.value > 0 && shownRows.value === 0)

/** The provider whose rows close the table: its last row drops the bottom border, the others keep
 *  theirs so one provider's rows do not run straight into the next one's. */
const lastProvider = computed<Provider>(() =>
  dshShown.value ? 'deepseek' : codexShown.value ? 'codex' : 'claude',
)

// --- create: one + menu for every provider --------------------------------------------------------
/** The providers the + menu offers: those switched on in Settings → Providers. */
const createProviders = computed<Provider[]>(() => [
  ...(showDesktopInstances.value ? (['claude'] as const) : []),
  ...(codexEnabled.value ? (['codex'] as const) : []),
  ...(dshEnabled.value ? (['deepseek'] as const) : []),
])
const CREATE_LABEL: Record<Provider, string> = {
  claude: 'instances.createClaude',
  codex: 'instances.createCodex',
  deepseek: 'instances.createDeepseek',
}

/**
 * "New … instance". A provider the filter is leaving out is listed again first, so the row being
 * created is one you will see, and so its row component, which owns that provider's create
 * dialog, is mounted to open it.
 */
async function onCreateFor(provider: Provider) {
  showProvider(provider)
  if (provider === 'claude') {
    openCreateDialog()
    return
  }
  await nextTick()
  const rows = provider === 'codex' ? codexRows.value : dshRows.value
  rows?.openCreate()
}

// --- unified per-account view -------------------------------------------------------------------
// A desktop instance and the CLI instance linked to it are the SAME Anthropic account, signed in
// twice (Electron safeStorage vs a CLAUDE_CONFIG_DIR). So the desktop row IS the account row: it
// shows its CLI login inline and can act on it, instead of making you cross-reference two tables to
// see that "4claude the app" and "4claude the CLI" are one quota.
//
// Returns an ARRAY (0 or 1) rather than an object, purely so the template can `v-for` over it and
// get a properly-typed local binding — Vue has no `v-let`, and this avoids `!` assertions.
function linkedClis(dir: string): CliInstance[] {
  return cliInstances.value.filter((c) => c.associatedDesktopDir === dir)
}
/** The 0-or-1 linked CLI login as a nullable, for `v-if` branching in the actions menu. */
function linkedCliFor(dir: string): CliInstance | null {
  return linkedClis(dir)[0] ?? null
}

async function onLaunchCli(cli: CliInstance) {
  const result = await launchCli(cli.id)
  if (result?.ok) toast.success(t('instances.toastCliLaunched'))
  else toast.error(result?.message ?? t('instances.toastCliLaunchFailed'))
}
async function onLoginCli(cli: CliInstance) {
  const result = await loginCli(cli.id)
  if (result?.ok) toast.success(t('instances.toastCliLoginOpened', { name: cli.name }))
  else toast.error(result?.message ?? t('instances.toastCliLoginFailed'))
}
/** Unlink a CLI instance from this desktop row: the icon here goes, its own row on the CLI tab stays
 *  (losing only its link chip). */
async function onUnlinkCli(cli: CliInstance) {
  const result = await linkCliDesktop(cli.id, null)
  if (result?.ok) toast.success(t('instances.toastCliUnlinked'))
  else toast.error(result?.message ?? t('instances.toastCliUnlinkFailed'))
}

// "Sign in CLI" on a row with NO linked CLI login yet: create one on demand, link it to this
// desktop instance, then open the /login terminal — the same three building blocks the CLI table
// uses, chained. The busy-set guards a double-click: two concurrent create+link chains for one row
// would orphan a CLI instance (the second link silently steals the association from the first).
const cliSignInBusy = ref(new Set<string>())
async function onSignInCli(inst: CMInstance) {
  if (cliSignInBusy.value.has(inst.dir)) return
  cliSignInBusy.value = new Set(cliSignInBusy.value).add(inst.dir)
  try {
    const cliName = `${displayName(inst)} (CLI)`
    const created = await createCli(cliName)
    const id = created?.ok ? (created.data?.id as string | undefined) : undefined
    if (!id) {
      toast.error(created?.message ?? t('instances.toastCliCreateFailed'))
      return
    }
    const linked = await linkCliDesktop(id, inst.dir)
    if (!linked?.ok) {
      // The link failed, so this CLI instance was created but never linked — leaving it behind
      // would orphan it in the CLI Instances table. Clean it up (confirmName mirrors the trim
      // createCliInstance applies to the name server-side) so a failed chain leaves no residue.
      await removeCli(id, cliName.trim())
      toast.error(linked?.message ?? t('instances.toastCliCreateFailed'))
      return
    }
    // Signed in from this desktop instance's own login (server core/desktop-cli-feed.ts): no
    // terminal, no second sign-in.
    if (linked.data?.signedInFromDesktop) {
      toast.success(t('instances.toastCliSignedInFromDesktop', { name: cliName }))
      return
    }
    const result = await loginCli(id)
    if (result?.ok)
      toast.success(
        linked.data?.desktopHasNoCodeLogin
          ? t('instances.toastCliLoginOpenedNoDesktop')
          : t('instances.toastCliLoginOpened', { name: cliName }),
      )
    else toast.error(result?.message ?? t('instances.toastCliLoginFailed'))
  } finally {
    const next = new Set(cliSignInBusy.value)
    next.delete(inst.dir)
    cliSignInBusy.value = next
  }
}

// Check every instance's usage concurrently — desktop AND CLI. Each check is a single ~300ms read of
// the quota endpoint (not a `claude` spawn), and the endpoint is neither rate-limited nor
// quota-consuming, so there is no reason to serialize. The user is waiting on this click, so it fans
// out rather than staggering the way the background sweep does.
const refreshingAllUsage = ref(false)
async function onRefreshAllUsage() {
  if (refreshingAllUsage.value) return
  refreshingAllUsage.value = true
  try {
    await Promise.all([
      ...(showDesktopInstances.value ? instances.value.map((i) => checkDesktop(i.dir)) : []),
      ...(showCliInstances.value ? cliInstances.value.map((i) => checkCliUsage(i.id)) : []),
      ...(codexEnabled.value
        ? codexInstances.value
            .filter((i) => i.account?.authMode === 'chatgpt')
            .map((i) => checkCodex(i.id))
        : []),
    ])
  } finally {
    refreshingAllUsage.value = false
  }
}

// --- cold-start usage: catch up the readings that have aged out, a couple at a time -------------
// The background usage poll only HYDRATES from the server's cache (a plain read), so something has
// to decide when a real probe is due. This used to be "every instance, right now, all at once" —
// one unbounded Promise.all the moment the lists arrived. Measured 2026-08-07 on a 15-instance
// install: 14 simultaneous probes at t+0.5s, slowest 8.8s, on every open of the app.
//
// That was over-correcting for a cache that is actually warm. The server persists its usage cache
// to disk and re-sweeps on a timer, so an opening window already has numbers on screen; the only
// rows worth a probe are the ones whose reading has aged past USAGE_CATCHUP_MAX_AGE_MS (plus any
// that have no reading at all, which is the genuinely blank cell). Those go out two at a time with
// a stagger — see lib/usage-catchup.ts for the whole rationale.
//
// Desktop and CLI lists arrive on independent polls (and Settings can hide either), so each gets
// its own one-shot guard and watches its show-flag too: a single shared flag, or watching only the
// list, would skip whichever became ready second.
//
// `hydrated` is in the guard because the decision READS the cache: running before the first
// /api/usage/cache response lands would see every snapshot as missing and probe everything, which
// is the exact herd this replaced.
const didInitialDesktopUsage = ref(false)
const didInitialCliUsage = ref(false)
// Aborts both catch-ups if the tab is left while they are still trickling through the queue.
const catchupSignal = { aborted: false }
watch(
  [instances, showDesktopInstances, usageHydrated],
  ([list, show, ready]) => {
    if (didInitialDesktopUsage.value || !show || !ready || list.length === 0) return
    didInitialDesktopUsage.value = true
    const due = selectUsageCatchup(list as CMInstance[], usageFor)
    if (due.length) {
      void runUsageCatchup(due, (i) => checkDesktop(i.dir), { signal: catchupSignal })
    }
  },
  { immediate: true },
)
watch(
  [cliInstances, showCliInstances, usageHydrated],
  ([list, show, ready]) => {
    if (didInitialCliUsage.value || !show || !ready || list.length === 0) return
    didInitialCliUsage.value = true
    const due = selectUsageCatchup(
      list as CliInstance[],
      (i) =>
        // A CLI row carries its own last reading in the list payload; fall back to the shared cache
        // for one that hasn't been folded in yet.
        snapshotFor(`cli:${i.id}`) ?? i.lastUsageCheck,
    )
    if (due.length) {
      void runUsageCatchup(due, (i) => checkCliUsage(i.id), { signal: catchupSignal })
    }
  },
  { immediate: true },
)

async function onOpen(inst: CMInstance) {
  const result = await open(inst.dir)
  if (result?.ok) {
    toast.success(t('instances.toastOpened'))
    // A successful isolated launch is live proof the install is manageable — re-check so a stale
    // "MSIX-only / not installed" banner clears itself instead of waiting on a manual Refresh.
    if (desktopWarning.value) void refreshDesktopInstall(true)
  }
  // Prefer the server's failure message — it explains the MSIX-only case (same convention
  // as the create dialog surfacing result.message).
  else toast.error(result?.message ?? t('instances.toastOpenFailed'))
}

// Quit: the External row is the user's REAL Claude Desktop (maybe mid-conversation) — route it
// through an explicit confirmation dialog; the server independently refuses it without the flag.
const quitExternalOpen = ref(false)
const quitExternalTarget = ref<CMInstance | null>(null)
const quittingExternal = ref(false)
async function onQuit(inst: CMInstance) {
  if (inst.isExternal) {
    quitExternalTarget.value = inst
    quitExternalOpen.value = true
    return
  }
  const ok = await quit(inst.dir)
  if (ok) toast.success(t('instances.toastQuit'))
  else toast.error(t('instances.toastQuitFailed'))
}
async function onQuitExternalConfirm() {
  const inst = quitExternalTarget.value
  if (!inst) return
  quittingExternal.value = true
  try {
    const ok = await quit(inst.dir, { confirmExternal: true })
    if (ok) toast.success(t('instances.toastQuit'))
    else toast.error(t('instances.toastQuitFailed'))
  } finally {
    quittingExternal.value = false
    quitExternalOpen.value = false
    quitExternalTarget.value = null
  }
}
// --- log out: confirmed, and never while the app is running -------------------------------------
const logoutOpen = ref(false)
const logoutTarget = ref<CMInstance | null>(null)
const loggingOut = ref(false)
function openLogoutDialog(inst: CMInstance) {
  logoutTarget.value = inst
  logoutOpen.value = true
}
async function onLogoutConfirm() {
  const inst = logoutTarget.value
  if (!inst) return
  loggingOut.value = true
  try {
    const result = await logout(inst.dir)
    // The server's own message is the useful one on failure: it explains the running-instance
    // refusal, which is the case a person will actually hit.
    if (result?.ok) toast.success(result.message ?? t('instances.toastLoggedOut'))
    else toast.error(result?.message ?? t('instances.toastLogoutFailed'))
  } finally {
    loggingOut.value = false
    logoutOpen.value = false
    logoutTarget.value = null
  }
}

async function onFocus(inst: CMInstance) {
  if (!inst.isRunning || isBusy(inst)) return
  const result = await focus(inst.dir)
  if (result?.ok) toast.success(t('instances.toastFocused'))
  else toast.error(result?.message ?? t('instances.toastFocusFailed'))
}
/**
 * The icon row at the top of a row's ⋮ menu (InstanceMenuHeader adds Copy number last). Check
 * usage is the former "Check usage" ITEM: re-checking one account is the thing you want twice in a
 * row, so it keeps the menu open; Edit and Log out each open a dialog, so they close it.
 */
function menuActionsFor(inst: CMInstance): MenuIconAction[] {
  const checking = isChecking(usageKeyFor(inst))
  return [
    {
      key: 'check-usage',
      icon: RefreshCw,
      label: t('instances.checkUsage'),
      run: () => void onCheckUsage(inst),
      disabled: checking,
      spin: checking,
    },
    {
      key: 'edit',
      icon: Pencil,
      label: t('instances.edit'),
      closes: true,
      run: () => openEditDialog(inst),
      disabled: isBusy(inst),
    },
    {
      key: 'logout',
      icon: LogOut,
      label: t('instances.logout'),
      closes: true,
      run: () => openLogoutDialog(inst),
      disabled: inst.isRunning || isBusy(inst),
    },
  ]
}
async function onRevealFolder(inst: CMInstance) {
  const result = await revealFolder(inst.dir)
  if (!result?.ok) toast.error(result?.message ?? t('instances.toastRevealFailed'))
}
async function onCreateShortcut(inst: CMInstance) {
  if (isBusy(inst)) return
  const result = await createShortcut(inst.dir)
  if (result?.ok) toast.success(t('instances.toastShortcutCreated'))
  // Prefer the server's message — it explains the MSIX-only case, same as onOpen.
  else toast.error(result?.message ?? t('instances.toastShortcutFailed'))
}

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
      toast.success(t('instances.toastCreated'))
      createOpen.value = false
      if (result.needsBrowserDance) toast.info(t('instances.browserDanceBody'))
      // Same self-heal as onOpen: a successful create disproves a stale "not manageable" verdict.
      if (desktopWarning.value) void refreshDesktopInstall(true)
    } else {
      createError.value = result?.message ?? t('instances.toastCreateFailed')
    }
  } finally {
    creating.value = false
  }
}

/**
 * Clear the stored label so the row is named after the account again.
 *
 * `setAppearance` with `label: null` is exactly what the edit dialog sends for an empty field, so
 * this is the same write, just without making the user open a dialog to delete text. Icon and
 * colour are passed through unchanged: they are a separate choice and clearing the name is not a
 * reason to lose the glyph.
 */
async function onUseAccountName(inst: CMInstance) {
  const next = accountDisplayName(inst.account)
  if (!next) return
  const result = await setAppearance(inst.dir, {
    label: null,
    icon: inst.icon,
    color: inst.color,
  })
  if (result?.ok) toast.success(t('instances.toastUsingAccountName', { name: next }))
  else toast.error(result?.message ?? t('instances.toastSaveFailed'))
}

function openEditDialog(inst: CMInstance) {
  editTarget.value = inst
  editError.value = null
  editOpen.value = true
}
/**
 * Persist an appearance edit AS IT HAPPENS, leaving the dialog open.
 *
 * No success toast: this fires on every debounced keystroke, so a toast per change would be a
 * stream of confetti for something the user can already see happening in the row behind the
 * dialog. A FAILURE still has to be said out loud, though — silence there would read as "saved".
 */
async function onEditApply(payload: {
  label: string | null
  icon: CMInstance['icon']
  color: CMInstance['color']
}) {
  const inst = editTarget.value
  if (!inst) return
  editing.value = true
  editError.value = null
  try {
    const result = await setAppearance(inst.dir, payload)
    if (!result?.ok) editError.value = result?.message ?? t('instances.toastSaveFailed')
  } finally {
    editing.value = false
  }
}
/** Closing is not a save (each edit already persisted); it just drops the target. */
function onEditClosed(isOpen: boolean) {
  if (isOpen) return
  editTarget.value = null
  editError.value = null
}

// --- right-click is the kebab -------------------------------------------------------------------
// One menu per row, opened by the ⋮ button OR by right-clicking anywhere on the row (owner ask,
// 2026-09-03: "right click on the instance ... or click the three little dots to trigger the exact
// same effect"). Controlled `open` on the row's DropdownMenu keyed by dir: the kebab's own click
// reports through update:open, and a right-click on another row moves the key, closing this one.
const rowMenuOpen = ref<string | null>(null)

// --- what chats are ON this account ------------------------------------------------------------
// The read that used to require opening the account (owner, 2026-09-07). The panel lives in its
// own component (InstanceChatsDialog.vue) because it owns a slow store scan with its own staleness
// guard; this file only says WHICH row to open it for.
const chatsOpen = ref(false)
const chatsTarget = ref<CMInstance | null>(null)
function openChats(inst: CMInstance) {
  rowMenuOpen.value = null
  chatsTarget.value = inst
  chatsOpen.value = true
}

// The number beside "Chats": how many chats on that account are ACTIVE, meaning not archived
// (owner, 2026-09-26: "a little number that says like zero, so you know there's no chats that
// are active"). It is the dialog's own default list counted, so the badge and the list it opens
// agree. Read when a row's menu opens rather than on the table's poll: it is one store scan for
// the whole fleet (~0.25s on 739 records), and a count nobody is looking at is not worth that
// every few seconds. A reading younger than CHAT_COUNTS_FRESH_MS is reused, so opening menus
// row after row costs one scan. Until the first answer the badge is simply absent, never a 0.
const CHAT_COUNTS_FRESH_MS = 5_000
const chatCounts = ref<Record<string, { active: number; archived: number }>>({})
let chatCountsAt = 0
let chatCountsInFlight: Promise<void> | null = null
function refreshChatCounts(force = false): Promise<void> {
  if (chatCountsInFlight) return chatCountsInFlight
  if (!force && Date.now() - chatCountsAt < CHAT_COUNTS_FRESH_MS) return Promise.resolve()
  chatCountsInFlight = getChatCounts()
    .then((got) => {
      chatCounts.value = got.counts
      chatCountsAt = Date.now()
    })
    .catch(() => {
      // Unreadable: keep the last reading rather than blanking every badge.
    })
    .finally(() => {
      chatCountsInFlight = null
    })
  return chatCountsInFlight
}
watch(rowMenuOpen, (dir) => {
  if (dir) void refreshChatCounts()
})
const activeChatsOf = (inst: CMInstance): number | undefined => chatCounts.value[inst.dir]?.active
/** A chat clicked inside the panel: land on it in Sessions (the tab switch happens in App.vue). */
function onChatsOpenRow(row: ChatListRow) {
  if (!row.sessionId) return
  requestSessionJump({ session_id: row.sessionId, source: 'claude' })
}

// --- move every active chat on one instance to another -----------------------------------------
// The whole flow (destinations, count, confirm, the two-pass move) lives in useMoveAllChats.
const {
  moveAll,
  moveAllBusy,
  moveShowClosed,
  instLabel,
  moveTargetsFor,
  prepareMoveAll,
  runMoveAll,
  openChatFromMoveDialog,
} = useMoveAllChats({
  instances,
  closeRowMenu: () => {
    rowMenuOpen.value = null
  },
  onMoved: () => {
    chatCountsAt = 0
  },
})

function openDeleteDialog(inst: CMInstance) {
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
    const result = await remove(inst.dir, confirmName)
    if (result?.ok) {
      toast.success(t('instances.toastDeleted'))
      deleteOpen.value = false
      deleteTarget.value = null
    } else {
      deleteError.value = result?.message ?? t('instances.toastDeleteFailed')
    }
  } finally {
    deleting.value = false
  }
}

function isBusy(inst: CMInstance): boolean {
  // Also busy while a "Sign in CLI" create+link chain is in flight for this row: without this,
  // Delete/Quit on the same row weren't disabled during the chain, so a race could still delete
  // the desktop instance out from under a CLI instance that's about to be linked to it — a ghost
  // in the making even with the create+link double-click guard in place.
  return busyDirs.value.has(inst.dir) || cliSignInBusy.value.has(inst.dir)
}

// Windows ships two Claude Desktop builds; only the classic (Squirrel .exe) one can be
// launched with an isolated profile. Warn when this machine has only the MSIX package
// (or nothing at all) — see server/src/core/desktop-install.ts.
const desktopInstall = ref<CMDesktopInstall | null>(null)
const desktopWarning = computed<{ titleKey: string; bodyKey: string } | null>(() => {
  const d = desktopInstall.value
  if (d?.platform !== 'win32' || d.manageable) return null
  return d.msixDetected
    ? { titleKey: 'instances.desktopMsixTitle', bodyKey: 'instances.desktopMsixBody' }
    : { titleKey: 'instances.desktopNoneTitle', bodyKey: 'instances.desktopNoneBody' }
})

async function refreshDesktopInstall(fresh = false) {
  try {
    desktopInstall.value = await getDesktopInstall({ fresh })
  } catch {
    // Best-effort — keep the last known state (no banner when it never resolved).
  }
}

// While the warning banner is up, re-verify the verdict every 60s (fresh, bypassing the server's
// 5-minute cache): the banner's own instruction is "install the classic build", and following it
// used to leave the stale banner pinned until a manual Refresh. No banner → no polling cost.
let desktopInstallTimer: number | null = null

onMounted(() => {
  startPolling()
  startUsagePolling()
  // The CLI table lives on the CLI tab now, but the Claude rows here still read the CLI list (the
  // linked-CLI badge and the ⋯ menu's CLI items), so this tab keeps it current while it is open.
  // One shared timer: the two tabs are never mounted at the same time.
  startCliPolling()
  refreshDesktopInstall()
  desktopInstallTimer = window.setInterval(() => {
    if (desktopWarning.value) void refreshDesktopInstall(true)
  }, 60_000)
})
onUnmounted(() => {
  stopPolling()
  stopUsagePolling()
  stopCliPolling()
  // Leaving the tab cancels whatever is still trickling through the catch-up queue: those probes
  // exist to fill in THIS table, and a tab you have navigated away from has no business holding a
  // slow queue of network requests open behind you.
  catchupSignal.aborted = true
  if (desktopInstallTimer !== null) window.clearInterval(desktopInstallTimer)
})
</script>

<template>
  <div class="flex min-h-full flex-col">
    <!-- Borderless toolbar, matching Sessions/Queue and the app header (App.vue): the sticky table
         header right below already draws a line there, and two rules a row apart was one of them
         doing nothing but adding weight.
         One table for every provider's desktop instances, so the heading is a title, not a
         collapse toggle, and carries no provider logo (each row carries its own). The count covers
         every provider and reads "x of y" once the filter is hiding rows, so it never silently
         disagrees with the number of instances that exist. -->
    <InstanceSectionHeader
      :title="$t('instances.title')"
      :count="
        hiddenByFilter > 0
          ? $t('instances.countOfTotal', { shown: shownRows, total: totalRows })
          : totalRows
      "
      :refresh-label="$t('instances.refresh')"
      :refresh-hint="$t('instances.refreshHint')"
      :refreshing="loading"
      :collapsible="false"
      @refresh="handleRefresh"
    >
      <template #meta>
        <span
          v-if="hiddenByFilter > 0"
          class="text-xs font-normal text-muted-foreground"
        >
          {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
        </span>
      </template>
      <template #tools>
        <!-- Usage mode: swaps the process columns for the quota ones across the whole tab. Pressed
             (secondary) while on, so the toolbar itself says which set of columns you're looking
             at — the glyph flips too, from a stopwatch (quota/time-to-reset) to a chip (process). -->
        <IconTooltip
          :label="usageMode ? $t('instances.usageModeOff') : $t('instances.usageModeOn')"
          :description="$t('instances.usageModeHint')"
        >
          <Button
            :variant="usageMode ? 'secondary' : 'outline'"
            size="icon"
            :aria-pressed="usageMode"
            :aria-label="usageMode ? $t('instances.usageModeOff') : $t('instances.usageModeOn')"
            @click="toggleUsageMode"
          >
            <component :is="usageMode ? Cpu : Timer" />
          </Button>
        </IconTooltip>
        <!-- Always here, in both column modes: status and plan are true whichever columns are on
             screen, and only the QUOTA facet stands down with them (see
             composables/useInstanceFilter.ts). A dimmed or short table must always have the
             control that explains it visible in the same toolbar. -->
        <InstanceFilterMenu :present-plans="presentPlans" />
        <IconTooltip
          :label="$t('instances.refreshAllUsage')"
          :description="$t('instances.refreshAllUsageHint')"
        >
          <Button
            variant="outline"
            size="icon"
            :disabled="
              refreshingAllUsage ||
              instances.length + cliInstances.length + codexInstances.length === 0
            "
            :aria-label="$t('instances.refreshAllUsage')"
            @click="onRefreshAllUsage"
          >
            <Gauge :class="refreshingAllUsage ? 'animate-pulse' : ''" />
          </Button>
        </IconTooltip>
        <PageSettingsDialog
          v-model:open="instanceSettingsOpen"
          trigger
          :title="$t('instances.settingsTitle')"
        >
          <InstanceSettings />
        </PageSettingsDialog>
        <!-- Create: a menu with one item per provider switched on. An icon with a tooltip like its
             neighbours: it used to widen on hover to show its label, which in a full row wrapped
             it out from under the pointer, so it flickered (owner, 2026-10-01). The DropdownMenu
             root sits INSIDE the tooltip's slot, wrapped in a span: see
             scripts/checks/reka-popper-root-inside-tooltip.mjs. -->
        <IconTooltip v-if="createProviders.length > 0" :label="$t('instances.createInstance')">
          <span class="inline-flex">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button size="icon" :aria-label="$t('instances.createInstance')">
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  v-for="provider in createProviders"
                  :key="provider"
                  @click="onCreateFor(provider)"
                >
                  <ProviderLogo :provider="provider" class="size-3.5" />
                  {{ $t(CREATE_LABEL[provider]) }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </IconTooltip>
      </template>
    </InstanceSectionHeader>

    <div
      v-if="desktopWarning"
      class="flex items-start gap-2 border-b border-border bg-warning/10 px-3 py-2"
    >
      <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
      <div class="min-w-0 text-sm">
        <p class="font-medium text-warning">{{ $t(desktopWarning.titleKey) }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ $t(desktopWarning.bodyKey) }}</p>
        <p class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a
            :href="CLASSIC_DESKTOP_INSTALLER_URL"
            target="_blank"
            rel="noreferrer"
            class="font-medium text-warning underline underline-offset-2"
          >
            {{ $t('instances.desktopWarnDownload') }}
          </a>
          <a
            :href="DESKTOP_DOWNLOAD_PAGE_URL"
            target="_blank"
            rel="noreferrer"
            class="text-muted-foreground underline underline-offset-2"
          >
            {{ $t('instances.desktopWarnAllDownloads') }}
          </a>
        </p>
      </div>
    </div>

    <!-- pb-16: the last section sat flush against the bottom edge of the scroll area, its last row
         half-hidden behind the window chrome (owner, 2026-09-20). -->
    <div class="flex flex-col gap-10 pb-16">
      <!-- px-1.5 rather than the kit's px-2: ten columns in the 1000px frame, and the 36px this
           gives back is what lets every capped name fit the Name column whole. -->
      <Table density="compact">
        <TableHeader sticky>
          <TableRow>
            <TableHead
              class="w-10"
              :title="tooltipsEnabled ? $t('instances.sortByStatus') : undefined"
            >
              <SortButton :direction="indicatorFor('running')" quiet @sort="toggleSort('running')">
                ●
              </SortButton>
            </TableHead>
            <!-- Both header hints exist because these two columns were the source of a real "where
                 do these names even come from?" — one row's Name can be a label you typed, the
                 next row's the account it is signed into, the next its folder, and nothing said
                 which. The rule is now written down where the question gets asked. -->
            <!-- Name is the one column that gives way. Ten nowrap columns needed 1008px inside a
                 988px frame, so the table scrolled sideways (owner, 2026-09-26); now this column
                 takes whatever the others leave (w-full, and max-w-0 on its cells so their content
                 cannot force the table wider), never below min-w-36, and the name elides.
                 Every other column carries NO width and so sits at its content's width. In auto
                 table layout a fixed width is a floor, not a size: the w-24 / w-28 / w-40 the
                 columns used to carry summed to ~940px of the ~990px frame, which left Name at
                 its 144px floor, one or two letters after its icons, while "Last running" kept
                 112px for "Now" (owner, 2026-10-03: "I can't view the name").
                 A header is a floor too: TableHead is nowrap, so "Last running" plus its sort
                 arrow and hint held that column at ~110px with the w-28 gone. The headers whose
                 label is far wider than their cells (Instance account, Usage 5h, Usage week, Last
                 running) may wrap instead (whitespace-normal), stacking onto two lines, so the
                 column is as wide as its longest word and the rest goes to Name. -->
            <TableHead class="w-full min-w-36">
              <span class="inline-flex items-center gap-0.5">
                <SortButton :direction="indicatorFor('name')" @sort="toggleSort('name')">
                  {{ $t('instances.colName') }}
                </SortButton>
                <InfoHint :text="$t('instances.colNameHint')" />
              </span>
            </TableHead>
            <TableHead class="whitespace-normal">
              <span class="inline-flex items-center gap-0.5">
                <SortButton :direction="indicatorFor('account')" @sort="toggleSort('account')">
                  {{ $t('instances.colAccount') }}
                </SortButton>
                <InfoHint :text="$t('instances.colAccountHint')" />
              </span>
            </TableHead>
            <!-- Process columns (default mode) … -->
            <template v-if="!usageMode">
              <TableHead>
                <SortButton :direction="indicatorFor('pid')" @sort="toggleSort('pid')">
                  {{ $t('instances.colPid') }}
                </SortButton>
              </TableHead>
              <TableHead>
                <SortButton :direction="indicatorFor('uptime')" @sort="toggleSort('uptime')">
                  {{ $t('instances.colUptime') }}
                </SortButton>
              </TableHead>
              <TableHead>
                <SortButton :direction="indicatorFor('memory')" @sort="toggleSort('memory')">
                  {{ $t('instances.colMemory') }}
                </SortButton>
              </TableHead>
            </template>
            <!-- … swapped one-for-one for the quota columns in usage mode, so the table keeps its
                 shape and only its subject changes. -->
            <!-- The quota columns once carried fixed widths so the same "Weekly" column did not
                 come out 110px in one table and 78px in the next. Name taking the slack (w-full,
                 here and in the CLI tab's table) does that now: every other column sits at its
                 content's width, which for the two bars is UsageBar's own min-w-20 in both tables.
                 The Codex and DeepSeek rows render into these same columns, so their cells follow
                 this header. -->
            <template v-else>
              <TableHead>
                <SortButton :direction="indicatorFor('session')" @sort="toggleSort('session')">
                  {{ $t('instances.colSession') }}
                </SortButton>
              </TableHead>
              <TableHead>
                <SortButton :direction="indicatorFor('weekly')" @sort="toggleSort('weekly')">
                  {{ $t('instances.colWeekly') }}
                </SortButton>
              </TableHead>
            </template>
            <TableHead v-if="usageMode" class="whitespace-normal">
              <SortButton :direction="indicatorFor('usageSession')" @sort="toggleSort('usageSession')">
                {{ $t('instances.colUsageSession') }}
              </SortButton>
            </TableHead>
            <TableHead class="whitespace-normal">
              <SortButton :direction="indicatorFor('usage')" @sort="toggleSort('usage')">
                {{ usageMode ? $t('instances.colUsageWeek') : $t('instances.colUsage') }}
              </SortButton>
            </TableHead>
            <TableHead>
              <SortButton :direction="indicatorFor('plan')" @sort="toggleSort('plan')">
                {{ $t('instances.colPlan') }}
              </SortButton>
            </TableHead>
            <!-- After Plan, before Actions, in both column modes: when an account was last opened
                 is as true in usage mode as in process mode, and placing it right of every other
                 column keeps the quota columns aligned with the tables below. -->
            <TableHead class="whitespace-normal">
              <span class="inline-flex items-center gap-0.5">
                <SortButton :direction="indicatorFor('lastRunning')" @sort="toggleSort('lastRunning')">
                  {{ $t('instances.colLastRunning') }}
                </SortButton>
                <InfoHint :text="$t('instances.colLastRunningHint')" />
              </span>
            </TableHead>
            <TableHead class="text-end">{{ $t('instances.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <!-- One body per provider, Claude first: a table may hold several tbody elements, and the
             Codex and DeepSeek row components render bare rows into theirs. -->
        <!-- first-load skeleton rows so the table never looks blank -->
        <TableBody v-if="claudeShown && loading && visibleRows.length === 0">
          <TableRow v-for="i in 4" :key="i">
            <TableCell><Skeleton class="size-2" /></TableCell>
            <TableCell>
              <Skeleton class="h-4 w-(--skeleton-w)" :style="{ '--skeleton-w': `${9 - (i % 3) * 2}rem` }" />
              <Skeleton class="mt-1.5 h-3 w-44" />
            </TableCell>
            <TableCell><Skeleton class="h-5 w-24" /></TableCell>
            <template v-if="!usageMode">
              <TableCell><Skeleton class="h-3 w-10" /></TableCell>
              <TableCell><Skeleton class="h-3 w-12" /></TableCell>
              <TableCell><Skeleton class="h-3 w-14" /></TableCell>
            </template>
            <template v-else>
              <TableCell><Skeleton class="h-8 w-20" /></TableCell>
              <TableCell><Skeleton class="h-8 w-20" /></TableCell>
              <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            </template>
            <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            <TableCell><Skeleton class="h-5 w-16" /></TableCell>
            <TableCell><Skeleton class="h-3 w-14" /></TableCell>
            <TableCell>
              <div class="flex justify-end"><Skeleton class="h-6 w-20" /></div>
            </TableCell>
          </TableRow>
        </TableBody>
        <TransitionGroup
          v-else-if="claudeShown"
          tag="tbody"
          name="row-fade"
          data-slot="table-body"
          class="[&>tr]:transition-colors [&>tr]:duration-200"
          :class="lastProvider === 'claude' ? '[&_tr:last-child]:border-0' : undefined"
        >
          <!-- Dimmed, not disabled: a filtered-out instance is one you've decided against for now,
               not one you can't touch — every action on the row still works. It does not react to
               the pointer at all, though (no lift on hover, and `hover:bg-transparent` overrides the
               kit row's own hover tint via tailwind-merge): a row that brightens as you sweep past
               it keeps pulling the eye back to the accounts you just told it to set aside, which is
               the opposite of what the filter is for. -->
          <TableRow
            v-for="inst in visibleRows"
            :key="inst.dir"
            :variant="filterDimmed(filterFacts(inst)) ? 'faded' : 'default'"
            class="group/row"
            @contextmenu.prevent="rowMenuOpen = inst.dir"
          >
            <TableCell>
              <!-- A status dot, as on every provider's rows, so the first column reads one way down
                   the whole table. The instance's own glyph moved beside its name. -->
              <span
                role="img"
                class="inline-block size-2 rounded-full"
                :class="inst.isRunning ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'"
                :title="inst.isRunning ? $t('instances.running') : $t('instances.stopped')"
                :aria-label="inst.isRunning ? $t('instances.running') : $t('instances.stopped')"
              />
            </TableCell>
            <TableCell class="max-w-0">
              <!-- The folder used to sit under the name as a permanent mono sub-line, which made
                   every row two lines tall to show a path nobody reads at rest. It moved into the
                   tooltip, where it is one hover away and costs no height. The tooltip is on EVERY
                   row now, not just running ones, because the folder is what it is really for; the
                   focus hint rides along as the description when clicking would actually focus.
                   A name too long for the column takes the first line instead, and pushes both of
                   those down one — see nameTooltip. -->
              <div class="flex min-w-0 items-center gap-1.5 font-medium">
                <!-- The provider's mark first: Claude, Codex and DeepSeek rows share this table. -->
                <ProviderLogo provider="claude" class="size-3.5" />
                <!-- The permanent number sits BEFORE the name because the name is the untrustworthy
                     half: a profile signed into a different account than the folder it was named
                     after keeps showing the old name, and the number never drifts. -->
                <InstanceNumber :num="inst.num" />
                <!-- The instance's own glyph and colour, its identity; faded while it is closed. -->
                <InstanceGlyph
                  :dir="inst.dir"
                  :icon="inst.icon"
                  :color="inst.color"
                  :running="inst.isRunning"
                />
                <!-- min-w-0 + truncate: when the column is squeezed, the name elides and the number
                     and marker icons around it keep their size. -->
                <IconTooltip v-bind="nameTooltip(inst)">
                  <button
                    v-if="inst.isRunning"
                    type="button"
                    class="min-w-0 cursor-pointer truncate text-start hover:underline"
                    :disabled="isBusy(inst)"
                    @pointerenter="noteNameClip($event, inst)"
                    @click="onFocus(inst)"
                  >
                    {{ nameCellText(inst) }}
                  </button>
                  <span
                    v-else
                    class="min-w-0 cursor-default truncate"
                    @pointerenter="noteNameClip($event, inst)"
                  >{{ nameCellText(inst) }}</span>
                </IconTooltip>
                <Badge v-if="inst.isExternal" variant="outline">{{ $t('instances.external') }}</Badge>
                <!-- The name you typed no longer matches the account this profile is signed into.
                     A label overrides everything and nothing ever re-checked one, so a row goes on
                     being named after an account it left — which is how a folder called `4claude`
                     ends up labelled "3claude". The marker only reports the disagreement; the ⋯
                     menu is where you resolve it, because the override is still yours to keep. -->
                <IconTooltip
                  v-if="labelDisagreesWithAccount(inst)"
                  :label="$t('instances.labelStale')"
                  :description="
                    $t('instances.labelStaleHint', {
                      label: inst.label ?? '',
                      account: accountDisplayName(inst.account) ?? '',
                    })
                  "
                >
                  <span
                    class="inline-flex items-center"
                    :aria-label="$t('instances.labelStale')"
                  >
                    <TriangleAlert class="size-3.5 text-warning" />
                  </span>
                </IconTooltip>
                <!-- A banked usage-limit reset (claude.ai Settings -> Usage -> Resets) this account
                     has not spent. Read from the running app; a closed app shows its last reading. -->
                <IconTooltip
                  v-if="(usageFor(inst)?.resetCredits ?? 0) > 0"
                  :label="
                    $t('instances.resetBanked', { count: usageFor(inst)?.resetCredits ?? 0 })
                  "
                  :description="resetBankedHint(inst)"
                >
                  <span
                    class="inline-flex items-center"
                    :aria-label="
                      $t('instances.resetBanked', { count: usageFor(inst)?.resetCredits ?? 0 })
                    "
                  >
                    <RotateCcw class="size-3.5 text-success" />
                  </span>
                </IconTooltip>
                <!-- claude.ai's one-time Claude Code & Cowork credit: money left to spend, or one
                     never claimed / held back, which the account is not getting. -->
                <IconTooltip
                  v-if="codeCreditFor(inst)"
                  :label="codeCreditLabel(inst)"
                  :description="codeCreditHint(inst)"
                >
                  <span class="inline-flex items-center" :aria-label="codeCreditLabel(inst)">
                    <Coins
                      class="size-3.5"
                      :class="
                        codeCreditFor(inst)?.state === 'active' ? 'text-success' : 'text-warning'
                      "
                    />
                  </span>
                </IconTooltip>
                <!-- Usage credits ON: this account bills usage past its plan limits. Off is the
                     quiet default and gets no icon (the usage chip's popover says it either way). -->
                <IconTooltip
                  v-if="billsPastLimit(usageFor(inst))"
                  :label="$t('instances.usageCreditsOn')"
                  :description="usageCreditsHint(inst)"
                >
                  <span class="inline-flex items-center" :aria-label="$t('instances.usageCreditsOn')">
                    <CreditCard class="size-3.5 text-warning" />
                  </span>
                </IconTooltip>
                <!-- A linked CLI login used to be visible NOWHERE on the row — its only trace was
                     the old "CLI instances (0 of 1)" shortfall in the CLI table (it now lists
                     every login, linked ones with a chip), which reads as
                     something hiding a row rather than as "it moved up here". An icon costs no row
                     height (the reason the old mono sub-line was removed) and answers "which of
                     these accounts owns the missing CLI login?" at a glance. Indicator only: the
                     actions stay in the ⋯ menu so a stray click can't launch a terminal. -->
                <IconTooltip
                  v-for="cli in linkedClis(inst.dir)"
                  :key="`cli-badge-${cli.id}`"
                  :label="$t('instances.linkedCliTooltip', { name: cli.name })"
                  :description="
                    cli.loggedIn
                      ? $t('instances.linkedCliSignedIn')
                      : $t('instances.linkedCliSignedOut')
                  "
                >
                  <span
                    class="inline-flex items-center"
                    :aria-label="$t('instances.linkedCliBadge')"
                  >
                    <Terminal
                      class="size-3.5"
                      :class="cli.loggedIn ? 'text-muted-foreground' : 'text-warning'"
                    />
                  </span>
                </IconTooltip>
              </div>
              <!-- No inline CLI sub-line here either: it made one row taller than the rest and
                   only ever showed for whichever account happened to be linked. The linked CLI
                   login's ACTIONS (and CLI sign-in for rows without one) live in the actions menu,
                   where EVERY row gets them without cluttering the table; only the badge above,
                   which is what makes the link discoverable at all, sits on the row. -->
            </TableCell>
            <TableCell>
              <!-- No "Resolve" button: every instance resolves itself (see
                   useInstances.autoResolveAccounts), so a missing account is a moment, not a
                   state you act on. The cell shows the account's EMAIL HANDLE — one rule for every
                   row, so this column can be compared down the table; the full address and the
                   Anthropic profile name are one hover away, and the plan/tier is its own column.
                   A logged-out instance still lands here as a badge — its account.label reads
                   "(not logged in)".

                   Clicking it copies the FULL address (the cell only has room for the handle, and
                   the handle is not something you can paste at anything). Only a row with a
                   resolved email becomes a button: a signed-out row has a badge to show and
                   nothing to copy, and a button that does nothing is worse than plain text.

                   The history button beside it lists every account the profile has been signed
                   into. Always shown when the row cannot name a live account (that is when you
                   need to know where it went); on a healthy row it waits for hover or focus, so
                   seventy rows do not each carry one more icon. -->
              <div class="flex items-center gap-1">
                <InstanceAccountBadge
                  v-if="accountCellName(inst)"
                  :email="inst.account?.email"
                  :profile="inst.account?.name"
                  :fallback="inst.account?.label"
                  :variant="accountBadgeVariant(inst)"
                />
                <span v-else class="text-xs text-muted-foreground">
                  {{ $t('instances.resolving') }}
                </span>
                <span
                  class="inline-flex"
                  :class="
                    inst.account?.status === 'live'
                      ? 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100'
                      : undefined
                  "
                >
                  <LoginHistoryPopover :dir="inst.dir" :num="inst.num" />
                </span>
              </div>
            </TableCell>
            <template v-if="!usageMode">
              <TableCell><span class="mono text-muted-foreground">{{ inst.pid ?? '—' }}</span></TableCell>
              <TableCell>
                <span class="text-muted-foreground">{{ inst.isRunning ? formatUptime(inst.startTime) : '—' }}</span>
              </TableCell>
              <TableCell><span class="text-muted-foreground">{{ formatBytes(inst.memoryBytes) }}</span></TableCell>
            </template>
            <template v-else>
              <!-- A bar, not a bare number: the point of usage mode is scanning ten rows at once
                   for the ones up against a wall, and ten integers all look alike until you read
                   each one. The number stays inside the bar (91 vs 96 is the whole decision), and
                   the countdown under it says when the number stops mattering. -->
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
                :checking="isChecking(usageKeyFor(inst))"
                :usage-key="usageKeyFor(inst)"
                @check="onCheckUsage(inst)"
              />
            </TableCell>
            <TableCell>
              <UsageBadge
                :snapshot="usageFor(inst)"
                :checking="isChecking(usageKeyFor(inst))"
                :usage-key="usageKeyFor(inst)"
                @check="onCheckUsage(inst)"
              />
            </TableCell>
            <TableCell>
              <!-- Plan / account type ("Max 20×", "Pro", "Free"), pulled out of the account cell
                   so it reads at a glance and sorts on its own. `account.planLabel` is computed
                   server-side (resolvePlanLabel) so a generic rate-limit tier never leaks here. -->
              <Badge v-if="inst.account?.planLabel" variant="outline">
                {{ inst.account.planLabel }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </TableCell>
            <TableCell>
              <span
                v-if="inst.isRunning || inst.lastRunningAt"
                class="text-xs tabular-nums"
                :class="inst.isRunning ? 'text-success' : ''"
                :title="tooltipsEnabled ? lastRunningExact(inst) : undefined"
              >
                {{ lastRunningLabel(inst) }}
              </span>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </TableCell>
            <TableCell>
              <div class="flex items-center justify-end gap-1">
                <Button
                  v-if="!inst.isRunning"
                  variant="outline"
                  size="sm"
                  :disabled="isBusy(inst)"
                  @click="onOpen(inst)"
                >
                  <Play /> {{ $t('instances.open') }}
                </Button>
                <!-- running: the primary action is Focus (bring the window forward); Quit moves
                     under the kebab so the common action is one click and the destructive one is deliberate -->
                <!-- The same pulsing green dot the status glyph carries, on the button that only
                     exists while the instance is running. The Actions column is where the eye ends
                     up (it is where you click), and "Open" vs "Focus" is a quiet way to encode
                     running-ness — the dot says it the same way the left of the row already does,
                     so the two cannot be read as different states. -->
                <Button v-else variant="outline" size="sm" :disabled="isBusy(inst)" @click="onFocus(inst)">
                  <span class="relative inline-flex">
                    <AppWindow />
                    <span
                      class="absolute -right-1 -top-1 size-1.5 rounded-full bg-success ring-2 ring-background animate-pulse"
                    />
                  </span>
                  {{ $t('instances.focusShort') }}
                </Button>

                <DropdownMenu
                  :open="rowMenuOpen === inst.dir"
                  @update:open="(v) => (rowMenuOpen = v ? inst.dir : null)"
                >
                  <!-- No tooltip wrapper here: the kebab is self-explanatory, and nesting a
                       TooltipTrigger around the DropdownMenuTrigger swallowed the click so the
                       menu never opened (and the zero-delay tooltip was intrusive). aria-label
                       keeps it accessible. -->
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :aria-label="$t('instances.moreActions')"
                    >
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <!-- w-56: without it the menu inherits the tiny kebab trigger's width and
                       "Create desktop shortcut" wraps/clips; a fixed width fits it on one line -->
                  <DropdownMenuContent align="end" class="max-w-56">
                    <!-- The menu leads with WHICH instance it belongs to, by number. On a table of
                         fourteen near-identically named rows, an open kebab menu is otherwise
                         detached from the row it came from — and "Delete" is the wrong item to be
                         unsure about. Copying it here is one click from every row's menu. -->
                    <InstanceMenuHeader
                      :num="inst.num"
                      :name="inst.name"
                      :actions="menuActionsFor(inst)"
                    />
                    <!-- Quit lives here now (the row's primary button is Focus when running);
                         disabled unless running, mirroring the old Focus item's guard -->
                    <DropdownMenuItem
                      :disabled="!inst.isRunning || isBusy(inst)"
                      @click="onQuit(inst)"
                    >
                      <Square /> {{ $t('instances.quit') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onRevealFolder(inst)">
                      <FolderOpen /> {{ $t('instances.openFolder') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onCreateShortcut(inst)">
                      <MonitorDown /> {{ $t('instances.createShortcut') }}
                    </DropdownMenuItem>
                    <!-- What this account is HOLDING, before any question about moving it. Sits
                         directly above the move submenu because they are the two halves of one
                         thought and the answer here decides whether the other is wanted. -->
                    <DropdownMenuItem @click="openChats(inst)">
                      <MessagesSquare /> {{ $t('instances.chats') }}
                      <!-- Active (not archived) chats on this account; 0 means none. Absent
                           until the first count arrives rather than a guessed 0. -->
                      <span
                        v-if="activeChatsOf(inst) !== undefined"
                        class="ms-auto min-w-5 rounded-full px-1.5 text-center text-2xs font-medium tabular-nums"
                        :class="activeChatsOf(inst) ? 'bg-primary text-primary-foreground' : 'border border-muted-foreground/50 text-muted-foreground'"
                        :title="$t('instances.chatsActiveCount', { n: activeChatsOf(inst) ?? 0 })"
                        :aria-label="$t('instances.chatsActiveCount', { n: activeChatsOf(inst) ?? 0 })"
                      >
                        {{ activeChatsOf(inst) }}
                      </span>
                    </DropdownMenuItem>
                    <!-- Every active chat on this account, moved to one other account. One line
                         per destination: a green dot marks a running app, the same mark the
                         row's own icon carries. Closed accounts stay out of the list until the
                         switch at the top is on (owner, 2026-09-08: two-line rows over twenty
                         accounts were a scroll, and "not running - lands in its store" said
                         nothing the dot's absence does not). A closed destination is still not
                         started: the chat lands in its store and is there when the app opens. -->
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger :disabled="moveAllBusy">
                        <ArrowRightLeft /> {{ $t('instances.moveChats') }}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent class="max-w-64">
                        <!-- The list is DESTINATIONS, and until this heading it never said so.
                             A switch reading "Show not running" sitting directly under "Move
                             chats to account" reads as a filter on the chats (owner, 2026-09-09,
                             asked exactly that: does it only move chats that are not running?).
                             It never was: the move takes every unarchived, not-done chat and
                             stops a live one first - see moveChatsConfirmBody, which now leads
                             with that. Naming the list is what disambiguates the switch. -->
                        <DropdownMenuLabel>
                          {{ $t('instances.moveChatsTargetsLabel') }}
                        </DropdownMenuLabel>
                        <!-- @select.prevent keeps the submenu open across the flip; reka closes
                             it on select otherwise. -->
                        <DropdownMenuCheckboxItem
                          :model-value="moveShowClosed"
                          @select.prevent
                          @update:model-value="moveShowClosed = $event"
                        >
                          {{ $t('instances.moveChatsShowNotRunning') }}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem v-if="moveTargetsFor(inst).length === 0" disabled>
                          {{ moveShowClosed || instances.length <= 1 ? $t('instances.moveChatsNoTargets') : $t('instances.moveChatsNoRunningTargets') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-for="to in moveTargetsFor(inst)"
                          :key="to.dir"
                          :disabled="moveAllBusy"
                          @click="prepareMoveAll(inst, to)"
                        >
                          <span
                            class="inline-flex size-3 shrink-0 items-center justify-center"
                            :title="to.isRunning ? $t('instances.running') : $t('instances.stopped')"
                          >
                            <span
                              v-if="to.isRunning"
                              class="size-2 rounded-full bg-success animate-pulse"
                            />
                          </span>
                          <span class="truncate">{{ instLabel(to) }}</span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <!-- CLI section, on EVERY row: a desktop instance and its CLI login are the
                         same Anthropic account signed in twice. With a linked CLI instance the
                         items act on it (Launch / Sign in + Unlink); without one, "Add a CLI
                         login…" creates + links one on demand and opens the /login terminal. That
                         item is worded as a CREATE, not as a sign-in: it used to share the exact
                         label of the plain sign-in above, so clicking it silently produced a new
                         managed instance and the only visible consequence was the CLI table
                         quietly reading "0 of 1" (back when it hid linked logins). -->
                    <DropdownMenuSeparator />
                    <template v-if="linkedCliFor(inst.dir)">
                      <template v-for="cli in linkedClis(inst.dir)" :key="`cli-${cli.id}`">
                        <DropdownMenuItem v-if="cli.loggedIn" @click="onLaunchCli(cli)">
                          <Terminal /> {{ $t('instances.launchCli') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-else @click="onLoginCli(cli)">
                          <LogIn /> {{ $t('instances.loginCli') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="onUnlinkCli(cli)">
                          <Unlink /> {{ $t('instances.unlinkCli') }}
                        </DropdownMenuItem>
                      </template>
                    </template>
                    <DropdownMenuItem
                      v-else
                      :disabled="cliSignInBusy.has(inst.dir)"
                      @click="onSignInCli(inst)"
                    >
                      <LogIn /> {{ $t('instances.addCli') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <!-- Old numbers stay on a row by design (a signed-out account keeps its last
                         reading, dimmed); this blanks them on request until the next reading
                         (owner, 2026-10-02: "clear the old 5hour and usage stats in the ui"). -->
                    <DropdownMenuItem :disabled="!usageFor(inst)" @click="onClearUsage(inst)">
                      <Eraser /> {{ $t('instances.clearUsage') }}
                    </DropdownMenuItem>
                    <!-- Edit (name + icon + color) is pure UI metadata, so it stays enabled even
                         while the instance runs (unlike Delete, which touches the folder) -->
                    <!-- Drop the typed name and let the row be called after the account again.
                         Offered on every labelled row, not only the mismatched ones, because "go
                         back to the account name" is a thing you want on purpose — but it is the
                         mismatched rows the warning marker sends here. -->
                    <DropdownMenuItem
                      v-if="inst.label"
                      :disabled="isBusy(inst) || !accountDisplayName(inst.account)"
                      @click="onUseAccountName(inst)"
                    >
                      <UserRound /> {{ $t('instances.useAccountName') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      :disabled="inst.isRunning || isBusy(inst)"
                      @click="openDeleteDialog(inst)"
                    >
                      <Trash2 /> {{ $t('instances.delete') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        </TransitionGroup>
        <tbody
          v-if="codexShown"
          data-slot="table-body"
          :class="lastProvider === 'codex' ? '[&_tr:last-child]:border-0' : undefined"
        >
          <CodexInstanceRows ref="codexRows" :usage-mode="usageMode" />
        </tbody>
        <!-- Hideable in Settings → Providers like Codex (owner, 2026-09-30): someone who never
             uses DeepSeek should not have to scroll past its rows. -->
        <tbody v-if="dshShown" data-slot="table-body" class="[&_tr:last-child]:border-0">
          <DshInstanceRows ref="dshRows" :usage-mode="usageMode" />
        </tbody>
        <!-- Keyed off the rows actually drawn, across every provider, not off the instance lists:
             with "hide" on (or a provider left out), the filter can empty a table that still has
             instances behind it, and that must not land as a blank table with no explanation. -->
        <TableBody v-if="shownRows === 0 && !(claudeShown && loading)">
          <!-- Usage mode swaps three process columns for two quota ones and adds the 5-hour
               usage chip, which lands back on ten either way (Last launched shows in both). Kept as
               an expression rather than a literal so a future column change cannot silently desync
               the span from the header. -->
          <TableEmpty :colspan="usageMode ? 10 : 10">
            <div class="flex flex-col items-center gap-1 text-center">
              <component :is="allHiddenByFilter ? Funnel : Boxes" class="mb-1 size-6 opacity-40" />
              <p class="font-medium text-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.filterAllHidden')
                    : $t('instances.empty')
                }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.filterAllHiddenHint')
                    : $t('instances.emptyHint')
                }}
              </p>
            </div>
          </TableEmpty>
        </TableBody>
      </Table>
    </div>

    <!-- "Chats": this one account's chats, read-only. No action on the account itself, so it
         closes on any outside click and its only control is the archived toggle. -->
    <InstanceChatsDialog
      v-model:open="chatsOpen"
      :instance="chatsTarget"
      @open-chat="onChatsOpenRow"
    />

    <!-- "Move all chats" confirmation: the count, both accounts, the list, and a second click. -->
    <Dialog :open="moveAll !== null" @update:open="(v) => { if (!v) moveAll = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {{ $t('instances.moveChatsConfirmTitle', { n: moveAll?.plan.chats.length ?? 0, from: moveAll ? instLabel(moveAll.from) : '', to: moveAll ? instLabel(moveAll.to) : '' }) }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('instances.moveChatsConfirmBody', { from: moveAll ? instLabel(moveAll.from) : '', to: moveAll ? instLabel(moveAll.to) : '' }) }}
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">{{ $t('instances.moveChatsRowHint') }}</p>
        <!-- What the plan leaves behind, said up front: a count smaller than the account must
             never be a silent one. -->
        <p
          v-if="moveAll && moveAll.plan.skippedNoSession + moveAll.plan.skippedDone > 0"
          class="text-xs text-muted-foreground"
        >
          {{ $t('instances.moveChatsSkipped', { n: moveAll.plan.skippedNoSession + moveAll.plan.skippedDone, from: instLabel(moveAll.from) }) }}
        </p>
        <!-- Grouped by project, largest group first, so the SHAPE of the move is visible before the
             click. Each row opens that chat in Sessions (filtered to it, selected). -->
        <ul class="scroll-slim max-h-56 space-y-2 overflow-y-auto text-xs">
          <li v-for="g in groupByProject(moveAll?.plan.chats ?? [])" :key="g.project">
            <div class="mb-1 flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
              <span class="truncate">{{ g.project }}</span>
              <span class="shrink-0">{{ $t('instances.moveChatsGroupCount', { n: g.sessions.length }) }}</span>
            </div>
            <ul class="space-y-1">
              <li v-for="s in g.sessions" :key="s.sessionId">
                <button
                  type="button"
                  class="w-full truncate rounded border border-border px-2 py-1 text-start hover:bg-accent"
                  @click="openChatFromMoveDialog(s)"
                >
                  {{ s.title || $t('instances.chatsNoTitle') }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" @click="moveAll = null">{{ $t('instances.moveChatsCancel') }}</Button>
          <Button :disabled="moveAllBusy || !moveAll?.plan.chats.length" @click="runMoveAll">
            {{ $t('instances.moveChatsConfirmSubmit', { n: moveAll?.plan.chats.length ?? 0 }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <CreateInstanceDialog
      v-model:open="createOpen"
      :submitting="creating"
      :error-message="createError"
      @submit="onCreateSubmit"
    />
    <DeleteInstanceDialog
      v-model:open="deleteOpen"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="deleting"
      :error-message="deleteError"
      @confirm="onDeleteConfirm"
    />
    <QuitExternalInstanceDialog
      v-model:open="quitExternalOpen"
      :instance-name="quitExternalTarget ? displayName(quitExternalTarget) : null"
      :submitting="quittingExternal"
      @confirm="onQuitExternalConfirm"
    />
    <!-- instance-name is the placeholder for an empty name field, so it shows the ACCOUNT name
         where there is one rather than the folder: an empty field means "name it after the
         account" (displayName), and the placeholder should show what leaving it empty
         actually gets you. The folder name is the fallback, same as displayName's. -->
    <LogoutInstanceDialog
      v-model:open="logoutOpen"
      :instance-name="logoutTarget ? displayName(logoutTarget) : null"
      :account-email="accountEmail(logoutTarget?.account)"
      :submitting="loggingOut"
      @confirm="onLogoutConfirm"
    />
    <EditInstanceDialog
      v-model:open="editOpen"
      :instance-name="accountDisplayName(editTarget?.account) ?? editTarget?.name ?? null"
      :dir="editTarget?.dir ?? null"
      :current-label="editTarget?.label ?? null"
      :current-icon="editTarget?.icon ?? null"
      :current-color="editTarget?.color ?? null"
      :submitting="editing"
      :error-message="editError"
      @apply="onEditApply"
      @update:open="onEditClosed"
    />
  </div>
</template>
