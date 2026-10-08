<script setup lang="ts">
import {
  AppWindow,
  ArrowRightLeft,
  Boxes,
  Cloud,
  Coins,
  CreditCard,
  Eraser,
  FileDown,
  FolderOpen,
  Funnel,
  Gauge,
  LoaderCircle,
  LogIn,
  LogOut,
  MessagesSquare,
  MonitorDown,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Unlink,
  UserRound,
} from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceRows from '@/components/CliInstanceRows.vue'
import CliQuickAdd from '@/components/CliQuickAdd.vue'
import CodexInstanceRows from '@/components/CodexInstanceRows.vue'
import CreateInstanceDialog from '@/components/CreateInstanceDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import DshInstanceRows from '@/components/DshInstanceRows.vue'
import EditInstanceDialog from '@/components/EditInstanceDialog.vue'
import FreeInstanceRows from '@/components/FreeInstanceRows.vue'
import InstanceCard from '@/components/InstanceCard.vue'
import InstanceChatsDialog from '@/components/InstanceChatsDialog.vue'
import InstanceFilterMenu from '@/components/InstanceFilterMenu.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import InstanceSectionHeader from '@/components/InstanceSectionHeader.vue'
import InstanceTable from '@/components/InstanceTable.vue'
import InstancesSummary from '@/components/InstancesSummary.vue'
import LoginHistoryPopover from '@/components/LoginHistoryPopover.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import type { Provider } from '@/components/ProviderLogo.vue'
import QuitExternalInstanceDialog from '@/components/QuitExternalInstanceDialog.vue'
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppSettings } from '@/composables/useAppSettings'
import { useClaudeAppHints } from '@/composables/useClaudeAppHints'
import { useCliInstances } from '@/composables/useCliInstances'
import { useCodexInstances } from '@/composables/useCodexInstances'
import { useDshInstances } from '@/composables/useDshInstances'
import { KIND_VIEWS, type KindView, useInstanceFilter } from '@/composables/useInstanceFilter'
import { quotaSortColumns, useInstanceSource } from '@/composables/useInstanceSource'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { useInstances } from '@/composables/useInstances'
import { useMoveAllChats } from '@/composables/useMoveAllChats'
import { piiDisplayName, piiName } from '@/composables/usePrivacy'
import type { SortableColumn } from '@/composables/useSortable'
import { useDesktopAccountTokens, useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { privacyMode, useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { ChatListRow, CliInstance, CMDesktopInstall, CMInstance } from '@/lib/api'
import { openSettingsInDesk } from '@/lib/desk-embed'
import {
  CLASSIC_DESKTOP_INSTALLER_URL,
  DESKTOP_DOWNLOAD_PAGE_URL,
  getChatCounts,
  getDesktopInstall,
} from '@/lib/api'
import { freeLogo } from '@/lib/free-instances'
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
import {
  type InstanceColumnKey,
  type InstanceRowModel,
  instanceColumns,
  nameTooltipFor,
} from '@/lib/instance-table'
import { groupByProject } from '@/lib/session-groups'
import { requestSessionJump } from '@/lib/session-jump'
import { tokenPartsFor } from '@/lib/token-window'
import { FREE_PROVIDERS } from '@desk/shared/free-instances'
import { billsPastLimit, usageReasonMessageKey } from '@/lib/usage'
import { runUsageCatchup, selectUsageCatchup } from '@/lib/usage-catchup'
import { planSize } from '@/lib/usage-pool'
import { visibleInterval } from '@/lib/visible-poll'
import IconTooltip from '@/shell/IconTooltip.vue'

const {
  instances,
  loading,
  resolvingAccounts,
  busyDirs,
  openingDirs,
  startPolling,
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
const {
  snapshotFor,
  clearUsage,
  isChecking,
  checkDesktop,
  checkCodex,
  reasonFor,
  hydrated: usageHydrated,
  hydrate: hydrateUsage,
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
const { usageMode, now } = useUsageMode(true)

// The sort survives a reload: persisted through useUiPrefs. It orders the Claude rows; the Codex
// and DeepSeek rows below them keep their own order.
const { desktopSortKey, desktopSortDirection } = useUiPrefs()

// The sort compares time left, which is the reset instant minus one shared "now", so a frozen "now" gives
// the same order as the ticking one. Sorting on the tick would redraw every row every 15 s for nothing.
const sortNow = ref(new Date())

/** "Now" while it runs, else "3h ago" since it was last seen running on this PC (owner,
 *  2026-09-30: last running, not last launched). Reads the shared clock, and the row model calls it
 *  from a getter, so only the cell that draws the label ticks, not the whole table. */
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
  providerShown,
  showProvider,
  visible: filterVisible,
  kindView,
  kinds: shownKinds,
  kindShown,
  setKindView,
  showKind,
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

const tokenWindow = useDesktopTokenWindow()
const accountTokens = useDesktopAccountTokens()

// --- rows keep their place while the stats load --------------------------------------------------
// Owner, 2026-10-04: the table "still does this whole, like, mass rearranging things as it loads
// the stats ... widths change and everything, and kind of just snap their way through it". The
// facts a row's cells and its sort read do not arrive together: the list, the usage cache, each
// account's cached identity, the tokens, then the live account checks (four at a time) and the
// catch-up usage probes, each landing on its own. useSortable waits for a quiet moment before it
// moves rows (its SETTLED ORDER note), but a load is a string of arrivals further apart than that
// wait, so the rows moved once per arrival. Three things stop it:
//   1. The Claude rows are drawn once the quick facts are in (see "first draw" below), so the first
//      order is sorted on real numbers. Until then the skeleton stands in, as many rows tall as the
//      table, so the Codex and DeepSeek rows drawn under it do not jump when it goes.
//   2. While the slow facts stream in, the sort reads each row's value as it was when the row was
//      first sorted (`holdable`), so nothing moves; once they are in, the rows settle once.
//   3. Memory and tokens move on every poll, so their order is taken when you sort by one or press
//      Refresh, never by the poll; the other columns go on following useSortable's settled order.
// A sort you click applies at once, with the numbers on screen, in every phase.

type SortValue = string | number | boolean | null | undefined

/** The longest the first draw waits for its quick facts once the list is in. */
const FIRST_DRAW_MAX_MS = 1200
/** The longest the order is held for the slow facts (and the account warning held back). */
const LOAD_HOLD_MAX_MS = 15_000
/** Figures that change on every poll: re-sorted on a sort click or a Refresh only. */
const RESORT_ON_ASK = new Set(['memory', 'tokens'])

/** The Claude rows are handed to the sort once this is set; it never unsets. */
const rowsReady = ref(false)
/** Set while the load's slow facts are still arriving. */
const holding = ref(true)
/** Bumped to take the held values afresh: a Refresh, and the end of the load. */
const holdEpoch = ref(0)
/** The active sort column's values, one per row, as first read. Plain, not reactive: it is a
 *  memo the sort reads through, and only the active column's accessor ever runs. */
let held: { key: string; asked: string; values: Map<string, SortValue> } | null = null

/**
 * A sort column that reads each row's value once and keeps it while the order is held. Anything
 * you ask for starts a fresh memo, so it sorts by what is on screen now: another column or
 * direction, another tokens span in the Tokens header, a Refresh (holdEpoch). A row that arrives
 * later is read when it is first sorted.
 */
function holdable(column: SortableColumn<CMInstance>): SortableColumn<CMInstance> {
  const live = column.accessor
  const always = RESORT_ON_ASK.has(column.key)
  return {
    ...column,
    accessor: (inst) => {
      if (!always && !holding.value) {
        // A live column is sorting now, so the memo is dropped: going back to Memory or Tokens
        // afterwards must read them afresh, not reuse the figures from the last time they sorted.
        // Only when this column IS the sort: any other read of a live accessor leaves the memo be.
        if (desktopSortKey.value === column.key) held = null
        return live(inst)
      }
      const asked = `${desktopSortDirection.value}|${tokenWindow.value}|${holdEpoch.value}`
      if (!held || held.key !== column.key || held.asked !== asked)
        held = { key: column.key, asked, values: new Map() }
      if (!held.values.has(inst.dir)) held.values.set(inst.dir, live(inst))
      return held.values.get(inst.dir)
    },
  }
}

const sortColumns: SortableColumn<CMInstance>[] = [
  { key: 'status', accessor: (i: CMInstance) => i.isRunning },
  // sort by what the cell actually shows (the display label, falling back to folder name)
  { key: 'name', accessor: (i: CMInstance) => displayName(i) },
  // Sort by what the cell actually shows (see accountCellName).
  { key: 'pid', accessor: (i: CMInstance) => i.pid ?? undefined },
  { key: 'uptime', accessor: (i: CMInstance) => (i.isRunning ? i.startTime : null) },
  { key: 'memory', accessor: (i: CMInstance) => i.memoryBytes ?? undefined },
  // By plan size (Pro 1, Max 5x 5, Max 20x 20), not the label's spelling; no plan sorts last.
  ...quotaSortColumns(usageFor, (i: CMInstance) => planSize(i.account?.planLabel), sortNow),
  // By the instant, not the "3h ago" text, so the order is true across units.
  {
    key: 'lastActive',
    accessor: (i: CMInstance) =>
      i.isRunning
        ? Number.MAX_SAFE_INTEGER
        : i.lastRunningAt
          ? Date.parse(i.lastRunningAt)
          : undefined,
  },
  {
    key: 'tokens',
    accessor: (i: CMInstance) =>
      tokenPartsFor(accountTokens.value[i.dir], tokenWindow.value)?.total,
    first: 'desc',
  },
]

const {
  toggleSort,
  indicatorFor,
  visibleRows,
  isDimmed,
  hiddenByFilter: claudeFiltered,
} = useInstanceSource({
  // Empty until the first draw's facts are in, so the first order the sort commits is a real one.
  rows: () => (rowsReady.value ? instances.value : []),
  rowKey: (i: CMInstance) => i.dir,
  facts: filterFacts,
  persisted: { key: desktopSortKey, direction: desktopSortDirection },
  columns: sortColumns.map(holdable),
})

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
const { instances: codexInstances, refresh: refreshCodex, listed: codexListed } = useCodexInstances()
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
  return shortDisplayName(piiDisplayName(inst))
}

// The account cell identifies the LOGIN, so it shows the email handle and nothing else — see
// accountHandle for why it is no longer accountName. The account's own label is the last resort so
// a logged-out row still reads "(not logged in)" instead of collapsing to "Resolving…".
function accountCellName(inst: CMInstance): string | null {
  return accountHandle(inst.account) ?? inst.account?.label ?? null
}

// 'warning' turns the row's account yellow with a mark (InstanceRow loginStale): the live login
// check failed and the account shown is the last known one. Not before that check has answered:
// the first draw shows each account from the identity cache ('cache'), and the live checks land
// four at a time over the next second or two, so every row went yellow with a mark on each load and
// then cleared one by one. Until this tab's first resolve pass is over (accountsSettled), a cached
// account is drawn plain; one the live check could not confirm turns yellow when the pass ends.
function accountBadgeVariant(inst: CMInstance) {
  switch (inst.account?.status) {
    case 'live':
      return 'success' as const
    case 'cache':
    case 'offline':
      return accountsSettled.value ? ('warning' as const) : ('ghost' as const)
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
  // The Codex, DeepSeek, CLI and Free rows share this table, so the one Refresh reloads the shown ones too.
  await Promise.all([
    refreshInstances({ force: true, resolve: 'full' }),
    refreshDesktopInstall(true),
    ...(codexEnabled.value ? [refreshRows(codexRows.value, () => refreshCodex())] : []),
    ...(dshEnabled.value ? [refreshRows(dshRows.value, () => refreshDsh())] : []),
    ...(cliShown.value ? [refreshRows(cliRows.value, () => refreshCliInstances())] : []),
    ...(freeShown.value ? [refreshRows(freeRows.value, () => refreshFree())] : []),
  ])
  // A Refresh you pressed is a moment to re-sort: memory and tokens take their order afresh.
  holdEpoch.value++
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
  loading: cliLoading,
  startPolling: startCliPolling,
  checkUsage: checkCliUsage,
  checkUsageQuiet: checkCliUsageQuiet,
  refreshCliInstances,
  create: createCli,
  launch: launchCli,
  login: loginCli,
  linkDesktop: linkCliDesktop,
  remove: removeCli,
} = useCliInstances()
const { instances: freeInstances, loading: freeLoading, refreshFree } = useFreeInstances()
onMounted(loadAppSettings)

// --- which kinds and providers the table draws --------------------------------------------------
// One table, three kinds (owner, 2026-10-07): Desktop (the Claude rows, then the Codex and DeepSeek
// rows, which are their own components), CLI and Free. The header's choice (All, Desktop, CLI, Free)
// decides which kinds' rows are drawn; Desktop's provider rows also need Settings → Providers and the
// filter's provider choice, and CLI needs its Settings switch.
const { instances: dshInstances, refresh: refreshDsh } = useDshInstances()
const codexEnabled = computed(() => codexDesktopEnabled.value || codexCliEnabled.value)
const claudeShown = computed(
  () => kindShown('desktop') && showDesktopInstances.value && providerShown('claude'),
)
const codexShown = computed(
  () => kindShown('desktop') && codexEnabled.value && providerShown('codex'),
)
const dshShown = computed(
  () => kindShown('desktop') && dshEnabled.value && providerShown('deepseek'),
)
const cliShown = computed(() => kindShown('cli') && showCliInstances.value)
const freeShown = computed(() => kindShown('free'))
/** The Codex rows are drawn, or will not be: their list answered and the usage cache is read. The
 *  DeepSeek rows under them wait for this (at most CODEX_WAIT_MAX_MS), since Codex rows landing
 *  later pushed the DeepSeek row down by their height (measured 2026-10-04: 119 px at 0.5 s). */
const CODEX_WAIT_MAX_MS = 3000
const codexWaitOver = ref(false)
const codexWaitTimer = setTimeout(() => (codexWaitOver.value = true), CODEX_WAIT_MAX_MS)
onUnmounted(() => clearTimeout(codexWaitTimer))
const codexSettled = computed(
  () => !codexShown.value || codexWaitOver.value || (usageHydrated.value && codexListed.value),
)

// --- first draw: the Claude rows wait for the quick facts ----------------------------------------
// See "rows keep their place while the stats load" above. The quick facts are the list, the usage
// cache (one local read), every account's cached identity (about 25ms for the lot), the CLI list
// (the linked-CLI mark on the name's line) and, while the table is sorted by tokens, the tokens.
// FIRST_DRAW_MAX_MS after the list is in, the rows draw with whatever has arrived, and what is
// still missing lands in place under the held order. A tab opened again already holds the lists,
// so it draws at once (the CLI list is only waited for on a cold open, where it loads alongside).
const listLoaded = ref(instances.value.length > 0)
const coldOpen = !listLoaded.value
const cliListLoaded = ref(cliInstances.value.length > 0)
const tokensLoaded = ref(false)
/** The account warning waits for this tab's first resolve pass (see accountBadgeVariant). A tab
 *  opened again finds identities this table has already checked live (a row says 'live'): those
 *  are the checks' answers, so they show at once instead of going plain and then yellow. */
const accountsSettled = ref(
  !resolvingAccounts.value && instances.value.some((i) => i.account?.status === 'live'),
)
// refreshInstances starts its resolve pass (setting resolvingAccounts) before it returns, so a list
// that lands with no pass running needed none: every identity on screen is a live check's answer.
watch(loading, (now, was) => {
  if (!was || now) return
  listLoaded.value = true
  if (!resolvingAccounts.value) accountsSettled.value = true
})
watch(resolvingAccounts, (now, was) => {
  if (was && !now) accountsSettled.value = true
})
watch(cliLoading, (now, was) => {
  if (was && !now) cliListLoaded.value = true
})
watch(
  accountTokens,
  () => {
    tokensLoaded.value = true
  },
  { once: true },
)
const firstDrawFactsIn = computed(
  () =>
    instances.value.length === 0 ||
    (usageHydrated.value &&
      (cliListLoaded.value || !coldOpen) &&
      instances.value.every((i) => i.account != null) &&
      (desktopSortKey.value !== 'tokens' || tokensLoaded.value)),
)
const firstDrawTimedOut = ref(false)
let firstDrawTimer: number | undefined
watch(
  [listLoaded, firstDrawFactsIn, firstDrawTimedOut],
  ([listIn, factsIn, timedOut]) => {
    if (rowsReady.value || !listIn) return
    if (factsIn || timedOut) {
      rowsReady.value = true
      window.clearTimeout(firstDrawTimer)
    } else if (firstDrawTimer === undefined) {
      firstDrawTimer = window.setTimeout(() => {
        firstDrawTimedOut.value = true
      }, FIRST_DRAW_MAX_MS)
    }
  },
  { immediate: true },
)

/** The skeleton stands in until the first draw, as many rows tall as the list will draw (the rows
 *  a hiding filter leaves, or, before the list is in, as many as the table drew last time), so the
 *  Codex and DeepSeek rows under it stay where they are when the Claude rows replace it. */
const lastRowCount = useStorage('agenthydra.instances.desktopRowCount', 0)
const claudeSkeleton = computed(() => claudeShown.value && !rowsReady.value)
const skeletonRows = computed(() =>
  Math.min(
    instances.value.length
      ? filterVisible(instances.value, filterFacts).length
      : lastRowCount.value || 4,
    30,
  ),
)
watch(
  () => visibleRows.value.length,
  (n) => {
    if (n > 0) lastRowCount.value = n
  },
)

/**
 * What CodexInstanceRows and DshInstanceRows hand this table through defineExpose. `refresh` and
 * `visibleCount` are optional: a component that filters its own rows can say how many it drew, and
 * one that does not draws its whole list.
 */
interface ProviderRowsHandle {
  openCreate: () => void
  refresh?: () => unknown
  visibleCount?: number
  /** Rows the filter took out of this provider (Codex says so; DeepSeek filters none). */
  hiddenByFilter?: number
}
const codexRows = ref<ProviderRowsHandle | null>(null)
const dshRows = ref<ProviderRowsHandle | null>(null)
const cliRows = ref<InstanceType<typeof CliInstanceRows> | null>(null)
const freeRows = ref<InstanceType<typeof FreeInstanceRows> | null>(null)
const quickAdd = ref<InstanceType<typeof CliQuickAdd> | null>(null)
const KIND_VIEW_LABEL_KEY: Record<KindView, string> = {
  all: 'instances.kindAll',
  desktop: 'app.tabDesktop',
  cli: 'app.tabCli',
  free: 'app.tabFree',
}
const KIND_VIEW_STEP: Record<string, number | undefined> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}
/** Arrow keys move the choice along the group, as in a radio group; Enter and Space click it. */
function onKindViewKey(event: KeyboardEvent, view: KindView) {
  const step = KIND_VIEW_STEP[event.key]
  if (!step) return
  event.preventDefault()
  const next = KIND_VIEWS[(KIND_VIEWS.indexOf(view) + step + KIND_VIEWS.length) % KIND_VIEWS.length]
  setKindView(next)
  const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]')
  group?.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus()
}

/** A row component's own refresh while it is mounted, else the bare list, so a provider the filter
 *  is leaving out still has a current count. */
function refreshRows(
  rows: { refresh?: () => unknown } | null | undefined,
  list: () => unknown,
): unknown {
  return rows?.refresh ? rows.refresh() : list()
}

// Rows per kind: every row Settings lets this tab list, and the rows the filter (its provider choice
// included) takes out. Counted from the lists, not from the rows on screen: the Claude rows wait for
// their first draw and the Codex rows for the usage cache (see "first draw"), and counting what is
// drawn read "0 of 15, 15 hidden by filter" for that moment, a heading that came and went. A kind
// whose toggle is off counts nothing here, so its rows are neither in the heading nor hidden by it.
const claudeTotal = computed(() => (showDesktopInstances.value ? instances.value.length : 0))
const codexTotal = computed(() => (codexEnabled.value ? codexInstances.value.length : 0))
const dshTotal = computed(() => (dshEnabled.value ? dshInstances.value.length : 0))
const desktopTotal = computed(() => claudeTotal.value + codexTotal.value + dshTotal.value)
const cliTotal = computed(() => (showCliInstances.value ? cliInstances.value.length : 0))
const freeTotal = computed(() => freeInstances.value.length)
const claudeHidden = computed(() =>
  !kindShown('desktop')
    ? 0
    : claudeShown.value
      ? claudeFiltered.value
      : claudeTotal.value,
)
const codexHidden = computed(() =>
  !kindShown('desktop') ? 0 : codexShown.value ? (codexRows.value?.hiddenByFilter ?? 0) : codexTotal.value,
)
const dshHidden = computed(() =>
  !kindShown('desktop') ? 0 : dshShown.value ? (dshRows.value?.hiddenByFilter ?? 0) : dshTotal.value,
)
const cliHidden = computed(() =>
  !kindShown('cli') ? 0 : cliShown.value ? (cliRows.value?.hiddenByFilter ?? 0) : cliTotal.value,
)
const freeHidden = computed(() =>
  !kindShown('free') ? 0 : freeShown.value ? (freeRows.value?.hiddenByFilter ?? 0) : freeTotal.value,
)
const totalRows = computed(
  () =>
    (kindShown('desktop') ? desktopTotal.value : 0) +
    (kindShown('cli') ? cliTotal.value : 0) +
    (kindShown('free') ? freeTotal.value : 0),
)
/** The choice's counts: every row each choice has, whether it is the one shown or not. */
const kindCounts = computed<Record<KindView, number>>(() => {
  const desktop = desktopTotal.value
  const cli = cliInstances.value.length
  const free = freeTotal.value
  return { all: desktop + cli + free, desktop, cli, free }
})
/** How many rows the filter (its provider choice included) took out of the table — the heading has
 *  to say so, or an instance that quietly stopped being listed reads as a bug rather than as the
 *  filter working. */
const hiddenByFilter = computed(
  () =>
    claudeHidden.value + codexHidden.value + dshHidden.value + cliHidden.value + freeHidden.value,
)
const shownRows = computed(() => totalRows.value - hiddenByFilter.value)
/** Every row filtered away. The table is not empty (there ARE instances), so the empty state has to
 *  explain the filter rather than tell the user to create their first instance. */
const allHiddenByFilter = computed(() => totalRows.value > 0 && shownRows.value === 0)

/** The provider whose rows close the table: its last row drops the bottom border, the others keep
 *  theirs so one provider's rows do not run straight into the next one's. */
const lastProvider = computed<Provider>(() =>
  dshShown.value ? 'deepseek' : codexShown.value ? 'codex' : 'claude',
)

// --- the table: one column list, one row model ---------------------------------------------------
// One InstanceTable for every shown kind (components/InstanceTable.vue). The Codex, DeepSeek, CLI and
// Free row components get this column list and hand the shared row their own models.
const columns = computed(() => instanceColumns(shownKinds.value, { usageMode: usageMode.value }))

/**
 * Each column's width, padding included, sized for its FINAL content in this compact table, its
 * header (sort arrow and hint included) and its first-load skeleton, whichever is widest. The
 * table lays out by content, so without these every column widened as its cells filled in (a "—"
 * turning into a chip and a bar, a plan badge, "9.5 GB" becoming "1023 MB") and the rest snapped
 * sideways (owner, 2026-10-04). They are floors at the content's own size, not padding: columns
 * still size to their content and Name keeps the rest (owner, 2026-10-03: "the tables are not
 * properly columning"). Status keeps its w-10 from the column list; Name takes what is left.
 *   pid: six mono digits; uptime: "23h 59m" under "Uptime" and its sort arrow
 *   memory: "1023 MB" under "Memory" and its sort arrow
 *   5h / Week: the 2.75rem usage chip, a 0.375rem gap and the 5rem reset bar
 *   usage: its 3.5rem skeleton (the chip is 2.75rem); plan: a "Max 20x" badge
 *   last active: "Last active" with its hint ("10/12/2025" fits under it)
 *   tokens: "Tokens" and its sort arrow, the window note gone (owner, 2026-10-06)
 *   actions: one 24px icon button, a 4px gap, the 24px menu button and the cell's 12px padding
 *   (owner, 2026-10-06: icons instead of words)
 * Measured in the running table (2026-10-04): Last active came out 104 px once the Codex rows were
 * in, so its width is that, rounded up.
 */
const COLUMN_WIDTHS: Partial<Record<InstanceColumnKey, string>> = {
  pid: '3.5rem',
  uptime: '4.25rem',
  memory: '4.5rem',
  session: '9rem',
  weekly: '9rem',
  usage: '4.25rem',
  plan: '4.75rem',
  lastActive: '6.5rem',
  tokens: '4.5rem',
  actions: '4rem',
}

/** What the shared row draws for one Claude desktop instance. */
function rowModel(inst: CMInstance): InstanceRowModel {
  const accountName = accountCellName(inst)
  const status = inst.isRunning ? t('instances.running') : t('instances.stopped')
  const shown = nameCellText(inst)
  return {
    id: inst.dir,
    num: inst.num,
    dimmed: isDimmed(inst),
    provider: 'claude',
    status: { on: inst.isRunning, pulse: true, title: status },
    glyph: { dir: inst.dir, icon: inst.icon, color: inst.color, running: inst.isRunning },
    name: {
      shown,
      tooltip: (clipped) =>
        nameTooltipFor(
          {
            full: piiDisplayName(inst),
            shown,
            email: accountEmail(inst.account),
            folder: inst.dir,
            copyHint: t('instances.nameCopyHint'),
          },
          clipped,
        ),
      copy: accountEmail(inst.account),
    },
    badge: inst.isExternal ? { label: t('instances.external') } : undefined,
    // No "Resolve" button: every instance resolves itself (useInstances.autoResolveAccounts), so a
    // missing account is a moment, not a state you act on.
    account: accountName
      ? { stale: accountBadgeVariant(inst) === 'warning' }
      : { note: t('instances.resolving') },
    pid: inst.pid,
    // A getter for the same reason as lastRunning's label: the cell that draws it ticks with the clock.
    get uptime() {
      void now.value
      return inst.isRunning ? formatUptime(inst.startTime) : null
    },
    memory: formatBytes(inst.memoryBytes),
    usage: {
      snapshot: usageFor(inst),
      checking: isChecking(usageKeyFor(inst)),
      key: usageKeyFor(inst),
      onCheck: () => void onCheckUsage(inst),
    },
    plan: inst.account?.planLabel ? { label: inst.account.planLabel } : null,
    lastRunning:
      inst.isRunning || inst.lastRunningAt
        ? {
            get label() {
              return lastRunningLabel(inst)
            },
            running: inst.isRunning,
            title: lastRunningExact(inst),
          }
        : null,
    tokens: tokenPartsFor(accountTokens.value[inst.dir], tokenWindow.value),
    menu: { name: inst.name, actions: menuActionsFor(inst) },
  }
}

/** Keyed off the rows the filter leaves, across every provider, not off the instance lists: with
 *  the filter on, it can empty a table that still has instances behind it, and that must not land
 *  as a blank table with no explanation. Not while the skeleton stands in, and no longer while a
 *  Refresh re-reads the list: an empty table's message vanished and came back on every Refresh. */
const emptyState = computed(() =>
  shownRows.value > 0 || claudeSkeleton.value
    ? null
    : allHiddenByFilter.value
      ? {
          icon: Funnel,
          title: t('instances.filterAllHidden'),
          hint: t('instances.filterAllHiddenHint'),
        }
      : { icon: Boxes, title: t('instances.empty'), hint: t('instances.emptyHint') },
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
/** The header's + menu (InstanceSectionHeader): what the chosen kind can create. The Free view offers
 *  only Free accounts, Desktop and CLI only the providers switched on, and All both under their own
 *  headings (owner, 2026-10-08: the Free view's menu listed "New Claude instance" and a bare "Claude",
 *  two Claudes nobody could tell apart). Free's ids carry a prefix because its 'claude' would
 *  otherwise be Claude's id. */
const FREE_CREATE_PREFIX = 'free:'
const createOptions = computed(() => {
  const desktop = createProviders.value.map((provider) => ({
    id: provider,
    provider,
    label: t(CREATE_LABEL[provider]),
  }))
  const free = FREE_PROVIDERS.map((p) => ({
    id: `${FREE_CREATE_PREFIX}${p}`,
    provider: freeLogo(p),
    label: t(p === 'claude' ? 'instances.createFreeClaude' : 'instances.createFreeChatgpt'),
  }))
  if (kindView.value === 'free') return free
  if (kindView.value !== 'all' && desktop.length) return desktop
  if (!desktop.length) return free
  return [
    ...desktop.map((o) => ({ ...o, section: t('instances.createSectionApps') })),
    ...free.map((o) => ({ ...o, section: t('instances.createSectionFree') })),
  ]
})

/**
 * "New … instance". A kind or provider the table is leaving out is listed again first, so the row
 * being created is one you will see, and so its row component, which owns that kind's create
 * dialog, is mounted to open it.
 */
async function onCreateFor(id: string) {
  if (id.startsWith(FREE_CREATE_PREFIX)) {
    showKind('free')
    await nextTick()
    freeRows.value?.openCreate(id.slice(FREE_CREATE_PREFIX.length))
    return
  }
  const provider = id as Provider
  showKind('desktop')
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
const linkedClisByDir = computed(() => {
  const byDir = new Map<string, CliInstance[]>()
  for (const c of cliInstances.value) {
    if (c.associatedDesktopDir == null) continue
    const list = byDir.get(c.associatedDesktopDir)
    if (list) list.push(c)
    else byDir.set(c.associatedDesktopDir, [c])
  }
  return byDir
})
const NO_CLIS: CliInstance[] = []
function linkedClis(dir: string): CliInstance[] {
  return linkedClisByDir.value.get(dir) ?? NO_CLIS
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
    holdEpoch.value++
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
/** The desktop catch-up's probes are still landing: the held order waits for them. */
const desktopCatchupRunning = ref(false)
// Aborts both catch-ups if the tab is left while they are still trickling through the queue.
const catchupSignal = { aborted: false }
watch(
  [instances, showDesktopInstances, usageHydrated],
  ([list, show, ready]) => {
    if (didInitialDesktopUsage.value || !show || !ready || list.length === 0) return
    didInitialDesktopUsage.value = true
    const due = selectUsageCatchup(list as CMInstance[], usageFor)
    if (due.length) {
      desktopCatchupRunning.value = true
      void runUsageCatchup(due, (i) => checkDesktop(i.dir), { signal: catchupSignal }).finally(
        () => {
          desktopCatchupRunning.value = false
        },
      )
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
      // Each probe lands in the usage cache the rows read; the list is refetched once at the end.
      void runUsageCatchup(due, (i) => checkCliUsageQuiet(i.id), { signal: catchupSignal }).then(
        (done) => {
          if (done && !catchupSignal.aborted) void refreshCliInstances({ silent: true })
        },
      )
    }
  },
  { immediate: true },
)

// --- the end of the load: the held order is let go ----------------------------------------------
// The slow facts are in once this tab's first resolve pass is over, the desktop catch-up's probes
// have landed and the tokens have answered. The held order is let go then (or LOAD_HOLD_MAX_MS
// after the tab opened, whichever comes first) and the rows settle once, on all of it.
let loadHoldTimer: number | undefined
function releaseHold(): void {
  window.clearTimeout(loadHoldTimer)
  accountsSettled.value = true
  if (!holding.value) return
  holding.value = false
  holdEpoch.value++
}
watch(
  () =>
    rowsReady.value &&
    accountsSettled.value &&
    tokensLoaded.value &&
    didInitialDesktopUsage.value &&
    !desktopCatchupRunning.value,
  (done) => {
    if (done) releaseHold()
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
  moveTargetsFor: moveTargetsForUncached,
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

// Each row's move targets, worked out once per list, toggle or privacy change (the targets are sorted by
// the names as shown) and only for rows whose menu asks.
const moveTargetsOf = computed(() => {
  void instances.value
  void moveShowClosed.value
  void privacyMode.value
  const cache = new Map<string, ReturnType<typeof moveTargetsForUncached>>()
  return (from: CMInstance) => {
    let targets = cache.get(from.dir)
    if (!targets) {
      targets = moveTargetsForUncached(from)
      cache.set(from.dir, targets)
    }
    return targets
  }
})
// The move dialog's chats by project, grouped once per plan rather than on every render.
const moveAllGroups = computed(() => groupByProject(moveAll.value?.plan.chats ?? []))
// One model per drawn row, rebuilt only when the rows or the facts they read change, so a row whose data
// did not change gets the same prop and does not redraw.
const rowModels = computed(() => new Map(visibleRows.value.map((inst) => [inst.dir, rowModel(inst)])))

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
let stopDesktopInstallPoll: (() => void) | null = null

onMounted(() => {
  // The first look at this tab: later refreshes are lib/warm-data.ts's (the desktop, cli and free kinds).
  startPolling()
  void hydrateUsage()
  // The Claude rows here read the CLI list too (the linked-CLI badge and the ⋯ menu's CLI items).
  startCliPolling()
  refreshDesktopInstall()
  stopDesktopInstallPoll = visibleInterval(() => {
    if (desktopWarning.value) void refreshDesktopInstall(true)
  }, 60_000)
  // A probe or a resolve that never answers must not hold the order (or the warning) for good.
  if (holding.value) loadHoldTimer = window.setTimeout(releaseHold, LOAD_HOLD_MAX_MS)
})
onUnmounted(() => {
  // Leaving the tab cancels whatever is still trickling through the catch-up queue: those probes
  // exist to fill in THIS table, and a tab you have navigated away from has no business holding a
  // slow queue of network requests open behind you.
  catchupSignal.aborted = true
  stopDesktopInstallPoll?.()
  window.clearTimeout(firstDrawTimer)
  window.clearTimeout(loadHoldTimer)
})
</script>

<template>
  <!-- pb-16: the last section sat flush against the bottom edge of the scroll area, its last row
       half-hidden behind the window chrome (owner, 2026-09-20). -->
  <div class="flex min-h-full flex-col pb-16">
    <InstanceCard>
      <!-- The card's header bar (InstanceCard): the table's column headings right below draw the
           line under it. One card for every kind of instance, so it has no title of its own: the nav
           tab already says Instances, and the kind choice (All, Desktop, CLI, Free, each with its row
           count) takes the title's place in its summary slot (owner, 2026-10-07). -->
      <InstanceSectionHeader
        title=""
        :refresh-label="$t('instances.refresh')"
        :refresh-hint="$t('instances.refreshHint')"
        :refreshing="loading || cliLoading || freeLoading"
        :create-label="$t('instances.createInstance')"
        :create-options="createOptions"
        :collapsible="false"
        @refresh="handleRefresh"
        @create="(id) => onCreateFor(id as string)"
      >
        <template #summary>
          <!-- One choice of four, as a segmented control (owner, 2026-10-07: Desktop, CLI and Free as
               toggles read as switches to turn on and off, not as a choice of what to show). The chosen
               one is filled and ringed, the others muted; arrow keys move between them. -->
          <div
            class="inline-flex items-center gap-0.5 rounded-md border bg-background/40 p-0.5"
            role="radiogroup"
            :aria-label="$t('instances.title')"
          >
            <Button
              v-for="view in KIND_VIEWS"
              :key="view"
              size="segment"
              variant="segment"
              role="radio"
              :aria-checked="kindView === view"
              :tabindex="kindView === view ? 0 : -1"
              :data-kind="view"
              @click="setKindView(view)"
              @keydown="onKindViewKey($event, view)"
            >
              {{ $t(KIND_VIEW_LABEL_KEY[view]) }}
              <span class="tabular-nums text-muted-foreground">{{ kindCounts[view] }}</span>
            </Button>
          </div>
        </template>
        <template #meta>
          <span
            v-if="hiddenByFilter > 0 && !claudeSkeleton"
            class="text-xs font-normal text-muted-foreground"
          >
            {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
          </span>
        </template>
        <template #tools>
          <!-- Always here, in both column modes: status and plan are true whichever columns are on
               screen, and only the QUOTA facet stands down with them (see
               composables/useInstanceFilter.ts). A dimmed or short table must always have the
               control that explains it visible in the same toolbar. -->
          <InstanceFilterMenu :present-plans="presentPlans" />
          <template v-if="cliShown">
            <IconTooltip :label="$t('cliInstances.sync')" :description="$t('cliInstances.syncHint')">
              <Button
                variant="outline"
                size="icon"
                :aria-label="$t('cliInstances.sync')"
                @click="cliRows?.openSync()"
              >
                <Cloud />
              </Button>
            </IconTooltip>
            <IconTooltip :label="$t('cliInstances.moveIn')">
              <Button
                variant="outline"
                size="icon"
                :aria-label="$t('cliInstances.moveIn')"
                @click="cliRows?.openMoveIn()"
              >
                <FileDown />
              </Button>
            </IconTooltip>
          </template>
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
          <!-- One gear: the kind on screen when only one is shown, else Desktop. Each page holds that
               kind's settings in Desk's Settings (owner, 2026-10-06). -->
          <IconTooltip :label="$t('instances.settingsTitle')">
            <Button
              variant="outline"
              size="icon"
              :aria-label="$t('instances.settingsTitle')"
              @click="openSettingsInDesk(shownKinds.length === 1 ? shownKinds[0] : 'desktop')"
            >
              <Settings2 />
            </Button>
          </IconTooltip>
        </template>
      </InstanceSectionHeader>
      <CliQuickAdd
        v-if="cliShown"
        ref="quickAdd"
        class="px-3 pb-3"
        @signed-in="refreshCliInstances({ silent: true })"
      />
      <InstancesSummary />

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

      <!-- ONE table for every shown kind: the same InstanceTable and InstanceRow for all of them,
           fed the shown kinds' columns (lib/instance-table.ts). The Claude rows are the bodies below;
           the Codex and DeepSeek rows, and the CLI and Free rows, are their own components handing
           the same InstanceRow their own models. -->
      <InstanceTable
        :columns="columns"
        :indicator-for="indicatorFor"
        density="compact"
        :skeleton="claudeSkeleton"
        :skeleton-rows="skeletonRows"
        :widths="COLUMN_WIDTHS"
        :empty="emptyState"
        @sort="toggleSort"
      >
        <TransitionGroup
          v-if="claudeShown"
          tag="tbody"
          name="row-fade"
          data-slot="table-body"
          class="[&>tr]:transition-colors [&>tr]:duration-200"
          :class="lastProvider === 'claude' ? '[&_tr:last-child]:border-0' : undefined"
        >
          <InstanceRow
            v-for="inst in visibleRows"
            :key="inst.dir"
            :columns="columns"
            :row="rowModels.get(inst.dir)!"
            :menu-open="rowMenuOpen === inst.dir"
            @update:menu-open="(v: boolean) => (rowMenuOpen = v ? inst.dir : null)"
          >
            <template #name-extra>

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
                    account: piiName(accountDisplayName(inst.account)),
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
            </template>
            <!-- The history button beside the account badge lists every account the profile has
                 been signed into. Always shown when the row cannot name a live account (that is
                 when you need to know where it went); on a healthy row it waits for hover or
                 focus, so seventy rows do not each carry one more icon. -->
            <template #account-extra>
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
            </template>
            <template #primary>
              <!-- Icon-only actions (owner, 2026-10-06): the word is the tooltip and the aria-label. -->
              <IconTooltip v-if="!inst.isRunning" :label="$t('instances.open')">
                <Button
                  variant="outline"
                  size="icon-sm"
                  :aria-label="$t('instances.open')"
                  :disabled="isBusy(inst)"
                  @click="onOpen(inst)"
                >
                  <LoaderCircle v-if="openingDirs.has(inst.dir)" class="animate-spin" />
                  <Play v-else />
                </Button>
              </IconTooltip>
              <!-- running: the primary action is Focus (bring the window forward); Quit moves
                   under the kebab so the common action is one click and the destructive one is
                   deliberate. The pulsing green dot is the one the status dot carries. -->
              <IconTooltip
                v-else
                :label="$t('instances.focusShort')"
                :description="$t('instances.focusHint')"
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  :aria-label="$t('instances.focusShort')"
                  :disabled="isBusy(inst)"
                  @click="onFocus(inst)"
                >
                  <span class="relative inline-flex">
                    <AppWindow />
                    <span
                      class="absolute -right-1 -top-1 size-1.5 rounded-full bg-success ring-2 ring-background animate-pulse"
                    />
                  </span>
                </Button>
              </IconTooltip>
            </template>
            <template #menu>

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
                <DropdownMenuSubContent width="lg">
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
                  <DropdownMenuItem v-if="moveTargetsOf(inst).length === 0" disabled>
                    {{ moveShowClosed || instances.length <= 1 ? $t('instances.moveChatsNoTargets') : $t('instances.moveChatsNoRunningTargets') }}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    v-for="to in moveTargetsOf(inst)"
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
            </template>
          </InstanceRow>
        </TransitionGroup>
        <tbody
          v-if="codexShown"
          data-slot="table-body"
          :class="lastProvider === 'codex' ? '[&_tr:last-child]:border-0' : undefined"
        >
          <!-- Mounted once the usage cache is read, so the Codex rows' first order is sorted on
               their numbers rather than reshuffled a moment later when the numbers land. -->
          <CodexInstanceRows v-if="usageHydrated" ref="codexRows" :columns="columns" />
        </tbody>
        <!-- Hideable in Settings → Providers like Codex (owner, 2026-09-30): someone who never
             uses DeepSeek should not have to scroll past its rows. -->
        <tbody v-if="dshShown && codexSettled" data-slot="table-body" class="[&_tr:last-child]:border-0">
          <DshInstanceRows ref="dshRows" :columns="columns" />
        </tbody>
        <CliInstanceRows
          v-if="cliShown"
          ref="cliRows"
          :columns="columns"
          @quick-add="quickAdd?.focusEmail()"
        />
        <FreeInstanceRows v-if="freeShown" ref="freeRows" :columns="columns" />
      </InstanceTable>
    </InstanceCard>

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
          <li v-for="g in moveAllGroups" :key="g.project">
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
      :instance-name="quitExternalTarget ? piiDisplayName(quitExternalTarget) : null"
      :submitting="quittingExternal"
      @confirm="onQuitExternalConfirm"
    />
    <!-- instance-name is the placeholder for an empty name field, so it shows the ACCOUNT name
         where there is one rather than the folder: an empty field means "name it after the
         account" (displayName), and the placeholder should show what leaving it empty
         actually gets you. The folder name is the fallback, same as displayName's. -->
    <LogoutInstanceDialog
      v-model:open="logoutOpen"
      :instance-name="logoutTarget ? piiDisplayName(logoutTarget) : null"
      :account-email="accountEmail(logoutTarget?.account)"
      :submitting="loggingOut"
      @confirm="onLogoutConfirm"
    />
    <EditInstanceDialog
      v-model:open="editOpen"
      :instance-name="editTarget ? piiName(accountDisplayName(editTarget.account)) || editTarget.name : null"
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
