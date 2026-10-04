<script setup lang="ts">
import { safeTranscriptFilename } from '@agenthydra/server/filenames'
import {
  AlignJustify,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ClipboardCopy,
  Cloud,
  Coins,
  Copy,
  Download,
  FileSymlink,
  FileText,
  FolderGit2,
  Globe,
  Hand,
  Hourglass,
  KeyRound,
  Layers,
  Link,
  ListTodo,
  Loader2,
  LoaderCircle,
  MessagesSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
  Wrench,
  X,
} from '@lucide/vue'
import { type Component, type ComponentPublicInstance, computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MultiSelectSubmenu from '@/components/MultiSelectSubmenu.vue'
import PageSettingsDialog from '@/components/PageSettingsDialog.vue'
import SessionComposer, { type ComposerTarget } from '@/components/SessionComposer.vue'
import SessionSettings from '@/components/SessionSettings.vue'
import SessionTranscriptTurns from '@/components/SessionTranscriptTurns.vue'
import SourceBadge from '@/components/SourceBadge.vue'
import SideBar from '@/components/side-list/SideBar.vue'
import SideListRow from '@/components/side-list/SideListRow.vue'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { OPEN_TRANSCRIPT } from '@/composables/openTranscript'
import { useBodySearch } from '@/composables/useBodySearch'
import { useData } from '@/composables/useData'
import { useDoneMarks } from '@/composables/useDoneMarks'
import { useMultiSelect } from '@/composables/useMultiSelect'
import { useOpenSession } from '@/composables/useOpenSession'
import { piiName } from '@/composables/usePrivacy'
import { useResumeInTerminal } from '@/composables/useResumeInTerminal'
import { useSessionAccount } from '@/composables/useSessionAccount'
import { useSessionBranch } from '@/composables/useSessionBranch'
import { useSessionFileActions } from '@/composables/useSessionFileActions'
import { useSessionFilters } from '@/composables/useSessionFilters'
import { useSessionJump } from '@/composables/useSessionJump'
import { useSessionMigration } from '@/composables/useSessionMigration'
import { useSessionRowDisplay } from '@/composables/useSessionRowDisplay'
import { useSessionSecrets } from '@/composables/useSessionSecrets'
import { useSessionUsage } from '@/composables/useSessionUsage'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTranscriptDisplay } from '@/composables/useTranscriptDisplay'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUnreadSessions } from '@/composables/useUnreadSessions'
import type * as api from '@/lib/api'
// Values, not types: the export menu builds its links with these at runtime. Importing the
// module as `import type` (2026-09-26 cleanup) left the template calling an undefined `api`.
import { sessionExportUrl, sessionFileUrl } from '@/lib/api'
import { modelName } from '@/lib/climayte-status'
import { baseName, queueStatusMeta, shortId, timeAgo } from '@/lib/format'
import { highlightRuns, rankByQuery, sessionSearchFields, type TextRun } from '@/lib/fuzzy'
import { groupByProject } from '@/lib/session-groups'
import {
  ARCHIVED_LABEL,
  DISPATCHED_LABEL,
  RATE_LIMIT_LABEL,
  SHAPE_LABEL,
  SOURCE_LABEL,
} from '@/lib/session-labels'
import {
  ARCHIVED_VALUES,
  type ArchivedValue,
  DISPATCHED_VALUES,
  type DispatchedValue,
  effectiveScopes,
  isAllSelected,
  RATE_LIMIT_VALUES,
  type RateLimitValue,
  SHAPE_VALUES,
  SOURCE_VALUES,
} from '@/lib/session-scopes'
import { type SessionShape, sessionShape } from '@/lib/session-shape'
import { sessionSourceIcon } from '@/lib/session-source-icon'
import type { SideListGroup } from '@/lib/side-list'
import { modelEffortTag } from '@/lib/side-list'
import { cn } from '@/lib/utils'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const {
  sessions,
  sessionsLoading,
  sessionsStatus,
  refreshSessions,
  queue,
  agentStatuses,
  sessionInstanceFilter,
  sessionArchivedScope,
  sessionPeriod,
  sessionSourceFilter,
  sessionDispatchedScope,
  sessionRateLimitScope,
  sessionShapeScope,
  sessionSearch: search,
  searchOnlyThisView,
  viewScopes,
  activeScopes,
} = useData()

// Verbose mode, the sidebar width and the body-search case flag are persisted AND mirrored through
// the daemon, so they live in composables/useUiPrefs.ts: this view unmounts whenever you switch
// tabs, and a mirrored ref owned by a component that unmounts stops being the mirrored one.
const {
  showTools,
  showThinking,
  humanOnly,
  compactTranscript,
  advancedCaseSensitive,
  copyPathIncludeName,
  copyPathIncludePrompt,
  copyPathPrompt,
} = useUiPrefs()

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
}

// --- the open session: which one, its live tail, and the layout that follows having one open -----
const {
  selectedId,
  selectedSource,
  selectedLocator,
  tail,
  tailLoading,
  chatEl,
  selected,
  loadTail,
  select,
  runningRunId,
  isExpanded,
  toggleExpand,
  loadOlder,
  anchorNextOpen,
  canLoadOlder,
  olderLoading,
  scroller,
} = useOpenSession({ sessions, queue, showTools, showThinking, humanOnly })
// A session that moved since you last opened it has a bold title (owner, 2026-10-04).
const { unread } = useUnreadSessions(selected)
const { branchFrom } = useSessionBranch({ open: selected, refresh: refreshSessions, select })
// An Agent step opens into the run it started, read from this same session's folder
// (SubagentTranscript.vue), so the open session is handed down rather than threaded through props.
provide(
  OPEN_TRANSCRIPT,
  computed(() =>
    selectedId.value && selectedSource.value
      ? {
          id: selectedId.value,
          source: selectedSource.value,
          locator: selectedLocator.value ?? undefined,
          thinking: showThinking.value,
        }
      : null,
  ),
)
// Top-level refs so the template unwraps them (a ref inside a returned object would not be).
const { pending: scrollPending, atBottom: chatAtBottom, unseen: unseenTurns } = scroller

const { loadUsage, usageSummary, usageDetail } = useSessionUsage({
  selectedId,
  selectedSource,
  selectedLocator,
})
// Cost moves only when the CLI writes turns, so refresh on the run's edges rather than on the
// 4-second tail poll (useOpenSession's own concern) — re-streaming a large transcript every tick to
// watch a number tick up is not worth it.
watch(runningRunId, (id, oldId) => {
  if (!!id !== !!oldId && selectedId.value) loadUsage()
})

const { secrets, secretsOpen, secretsDetail } = useSessionSecrets({
  selectedId,
  selectedSource,
  selectedLocator,
})

const {
  events,
  items,
  findTotal,
  findOpen,
  findQuery,
  findIndex,
  findInput,
  goToMatch,
  openFind,
  closeFind,
  copiedIdx,
  copyMessage,
} = useTranscriptDisplay({ tail, chatEl })

/** Whether the transcript is showing anything other than its default (tool calls and reasoning on,
 *  folded into work rows). Drives the pressed state on the controls button, so "why am I not
 *  seeing tool calls" is answerable at a glance. */
const displayFiltered = computed(
  () => !showTools.value || !showThinking.value || humanOnly.value || compactTranscript.value,
)

// Closing the session closes the find bar and the secrets dialog with it; a match count or a
// credential list against a transcript you can no longer see is just a wrong number on screen.
watch(selectedId, () => {
  closeFind()
  secretsOpen.value = false
})

/** The sidebar's own filter box, so Ctrl/Cmd+K can put the caret in it. */
/** The ⋯ menu's Session settings dialog (SessionSettings.vue). It opens once the menu has closed
 *  and handed focus back: opened in the same tick, it came up while the menu's layer was still the
 *  top one, and Escape never reached it. */
const sessionSettingsOpen = ref(false)
let settingsAfterMenu = false
function openSettingsAfterMenu() {
  settingsAfterMenu = true
}
function onListMenuClosed(event: Event) {
  if (!settingsAfterMenu) return
  settingsAfterMenu = false
  event.preventDefault()
  sessionSettingsOpen.value = true
}
const searchInput = ref<ComponentPublicInstance | null>(null)

// This view's own bindings, registered through the shared layer (composables/useShortcuts.ts) so
// they appear in the `?` sheet and disappear from it when the view unmounts.
//
// Ctrl/Cmd+F takes over the browser's own find, which is the right trade: the browser can only
// search the turns currently in the DOM anyway, and cannot show a count that means anything here.
useShortcuts([
  {
    keys: 'mod+f',
    labelKey: 'sessions.shortcutFind',
    groupKey: 'sessions.shortcutGroup',
    run: () => {
      if (selectedId.value) openFind()
    },
  },
  {
    keys: 'mod+k',
    labelKey: 'sessions.shortcutFilter',
    groupKey: 'sessions.shortcutGroup',
    run: () => searchInput.value?.$el?.focus?.(),
  },
  {
    keys: 'escape',
    labelKey: 'sessions.shortcutEscape',
    groupKey: 'sessions.shortcutGroup',
    run: () => {
      if (findOpen.value) closeFind()
      else if (selectedId.value) selectedId.value = null
    },
  },
])

// --- the sidebar's filter menu: named instances, scope labels, refetch-on-change wiring ----------
const {
  namedInstances,
  instanceLabelFor,
  instanceTicked,
  claudeTicked,
  filtersActive,
  filtersHideEverything,
  resetFilters,
  toggleInstance,
  instanceAll,
  instanceNone,
  sourceToggle,
  sourceAll,
  sourceNone,
  dispatchedToggle,
  dispatchedAll,
  dispatchedNone,
  rateLimitToggle,
  rateLimitAll,
  rateLimitNone,
  shapeToggle,
  shapeAll,
  shapeNone,
  archivedToggle,
  archivedAll,
  archivedNone,
  sourceFilterLabel,
  rateLimitScopeLabel,
  instanceFilterLabel,
  archivedScopeLabel,
  periodLabel,
  dispatchedScopeLabel,
  shapeScopeLabel,
} = useSessionFilters({
  sessionInstanceFilter,
  sessionArchivedScope,
  sessionPeriod,
  sessionSourceFilter,
  sessionDispatchedScope,
  sessionRateLimitScope,
  sessionShapeScope,
  activeScopes,
  search,
  refreshSessions,
})

// The entries of each multi-select submenu, labelled in the active language.
const menuItems = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  computed(() => values.map((value) => ({ value, label: t(labels[value]) })))
const sourceItems = menuItems(SOURCE_VALUES, SOURCE_LABEL)
const dispatchedItems = menuItems(DISPATCHED_VALUES, DISPATCHED_LABEL)
const rateLimitItems = menuItems(RATE_LIMIT_VALUES, RATE_LIMIT_LABEL)
const shapeItems = menuItems(SHAPE_VALUES, SHAPE_LABEL)
const archivedItems = menuItems(ARCHIVED_VALUES, ARCHIVED_LABEL)

// --- per-row labels, badges and tooltips -----------------------------------------------------
const {
  titleOriginOf,
  titleIsUnattributed,
  limitTooltipOf,
  sourceLabel,
  rowSourceLabel,
  sourceHasFile: SOURCE_HAS_FILE,
  sourceFileIsText: SOURCE_FILE_IS_TEXT,
  shapeTitleOf,
  copyWhyOf,
  activityOf,
  ACTIVITY_CLASS,
  ACTIVITY_LABEL,
} = useSessionRowDisplay()

// --- live agent status (server/src/agent-status.ts) -------------------------------------------
// Shown exactly as the daemon wrote it; nothing here re-decides it. A row read back after a daemon
// restart is not live, so it gets no badge rather than a confident one that may be hours stale.
const liveStatusBySession = computed(() => {
  const m = new Map<string, api.AgentStatus>()
  for (const st of agentStatuses.value) if (!st.restoredUnconfirmed) m.set(st.sessionId, st)
  return m
})
/** The row's live marks are bare icons, as CliMayte's list shows its status (icon-only): a row is
 *  one line, and full-text chips left the title no room at the sidebar's width. The label is the
 *  icon's hover and its screen-reader text. */
type StatusIcon = { icon: Component; tone: string; spin?: boolean }
const AGENT_STATUS_ICON: Record<api.AgentStatus['state'], StatusIcon> = {
  working: { icon: LoaderCircle, tone: 'text-primary', spin: true },
  blocked: { icon: Hand, tone: 'text-warning' },
  done: { icon: Check, tone: 'text-success' },
}
/** A queue status's colour, for the bare icon (the chip's variant, as CliMayteStatusBadge does). */
const QUEUE_ICON_TONE: Record<string, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
}
const queueIconTone = (status: api.QueueStatus) =>
  QUEUE_ICON_TONE[queueStatusMeta(status).variant ?? ''] ?? 'text-muted-foreground'
const AGENT_STATUS_LABEL: Record<api.AgentStatus['state'], string> = {
  working: 'sessions.agentStatusWorking',
  blocked: 'sessions.agentStatusBlocked',
  done: 'sessions.agentStatusDone',
}
const agentStatusOf = (s: api.SessionSummary) => liveStatusBySession.value.get(s.session_id) ?? null
/** Working right now: the hook says the agent is working, or its queue entry is a spinning status.
 *  The row shows it as a spinner; blocked, done and the other queue states stay marks. */
const isLive = (s: api.SessionSummary) =>
  agentStatusOf(s)?.state === 'working' ||
  (!!s.queue_status && !!queueStatusMeta(s.queue_status).spin)
/** The model and effort of the session's newest assistant turn, as CliMayte's rows say them
 *  (`Sonnet 5.5`); a row drops the tag when its summary has neither. */
const modelOf = (s: api.SessionSummary) => (s.model ? modelName(s.model) : null)
const effortOf = (s: api.SessionSummary) => s.effort ?? null

const { t } = useI18n()
/** The row's hover. A row is one line, as dense as a CliMayte task row (owner, 2026-10-03), so what
 *  its second line used to carry rides here, one fact per line, the way CliMayte's rowHint does. */
function rowHintOf(s: api.SessionSummary): string {
  // Always said for a Claude session, even when the answer is "we don't know": Claude Desktop
  // wrote no record of which account ran it, and only saying so tells that apart from a gap.
  let account: string | null = null
  if (s.source === 'claude')
    account = s.instance
      ? s.instance === 'default'
        ? t('sessions.instanceDefault')
        : instanceLabelFor(s.instance)
      : t('sessions.instanceUnknown')
  else if (s.instance) account = s.instance_num ? `${s.instance} (#${s.instance_num})` : s.instance
  const lines = [
    s.title,
    titleOriginOf(s),
    s.git_branch
      ? t('sessions.rowHintFolderBranch', { folder: baseName(s.cwd), branch: s.git_branch })
      : t('sessions.rowHintFolder', { folder: baseName(s.cwd) }),
    t('sessions.rowHintActivity', { n: s.message_count, ago: timeAgo(s.last_activity_at) }),
    shapeTitleOf(s),
    t('sessions.rowHintSource', { source: rowSourceLabel(s) }),
  ]
  // the row's icons, said in words
  if (s.limit_stop?.pending) lines.push(t('sessions.rateLimitedBadgePending'))
  const live = agentStatusOf(s)
  if (live) lines.push(t(AGENT_STATUS_LABEL[live.state]))
  if (s.queue_status) lines.push(queueStatusMeta(s.queue_status).label)
  if (s.dispatched) lines.push(t('sessions.dispatched'))
  if (account) lines.push(t('sessions.rowHintAccount', { account }))
  if (s.source === 'claude' && !s.instance) lines.push(t('sessions.instanceUnknownHint'))
  if (s.copy_count > 1) lines.push(copyWhyOf(s))
  if (s.subagent_count > 0) lines.push(t('sessions.subagentsHint', { count: s.subagent_count }))
  if (s.offloads?.hswarm) lines.push(t('sessions.offloadsHswarm', s.offloads.hswarm))
  if (s.from_pc) lines.push(t('sessions.fromPc', { pc: s.from_pc }))
  if (s.offloads?.climayte) lines.push(t('sessions.offloadsClimayte', s.offloads.climayte))
  if (s.archived) lines.push(t('sessions.archived'))
  return lines.join('\n')
}

const { doneCount, toggleDone, clearDoneMarks } = useDoneMarks({ sessions })
const { openFile, copyingFile, copyFile, copyFileLocation } = useSessionFileActions({
  copyPathIncludeName,
  copyPathIncludePrompt,
  copyPathPrompt,
})
const { resuming, resumeInTerminal } = useResumeInTerminal()

// The search box is an fzf-style fuzzy filter (lib/fuzzy.ts): 'cdxsess' finds 'Codex session', and
// the best match sorts first instead of wherever recency put it. Matched title characters are kept
// per row so the list can bold them.
const searchRanked = computed(() => {
  const q = search.value.trim()
  // Shape is a view filter like the rest: a search over everything ignores it.
  const shapes = activeScopes.value.shape
  let rows = sessions.value
  // Applied in the browser, unlike the scopes the daemon owns, so it narrows the window that was
  // fetched rather than reaching further back. Said plainly in the menu, because "no marathons in
  // the last 24 hours" and "no marathons" are different answers.
  if (!isAllSelected(shapes, SHAPE_VALUES))
    rows = rows.filter((s) => shapes.includes(sessionShape(s)))
  if (!q) return { rows, hits: new Map<api.SessionSummary, number[]>() }
  const ranked = rankByQuery(rows, q, sessionSearchFields)
  return {
    rows: ranked.map((r) => r.row),
    hits: new Map<api.SessionSummary, number[]>(ranked.map((r) => [r.row, r.match.positions])),
  }
})
const filtered = computed(() => searchRanked.value.rows)

/** The title split into plain and matched runs for the current search; one plain run without one. */
function titleRunsOf(s: api.SessionSummary): TextRun[] {
  return highlightRuns(s.title, searchRanked.value.hits.get(s) ?? [])
}

/** An empty list under a bounded window is ambiguous: "nothing here" or "nothing here LATELY"?
 *  Say which, so a quiet day doesn't read as a broken list. */
const emptyBecauseOfPeriod = computed(
  () => sessionPeriod.value !== 'all' && !search.value.trim() && sessions.value.length === 0,
)

// --- the rows, grouped by project as CliMayte groups by hand-off -----------------------------------
// Grouping is always on: the sidebar (components/side-list/SideBar.vue) is the one CliMayte runs,
// and its header line is the project folder with a count. Body-search results and the first-load
// skeletons are not session rows, so they leave the groups empty and ride the default slot.
const rowKey = (s: api.SessionSummary) => `${s.source}:${s.session_id}`
const sideGroups = computed<SideListGroup<api.SessionSummary>[]>(() =>
  bodySearchActive.value || (sessionsLoading.value && sessions.value.length === 0)
    ? []
    : groupByProject(filtered.value).map((g) => ({
        key: g.project,
        label: g.project,
        items: g.sessions,
        keyOf: rowKey,
      })),
)

// --- multi-select: pick several sessions, message them all at once - or move them ---------------
const {
  selectMode,
  checkedIds,
  sessionKey,
  isChecked,
  toggleSelectMode,
  checkAllFiltered,
  clearChecked,
  rowClick,
  listKeydown,
  box,
  boxPointerDown,
  boxClickGuard,
  checkedSessions,
  bulkCount,
  copyCheckedIds,
} = useMultiSelect({ filtered, selectedId, selectedSource, select, copy })

// --- migrate to another account, one session or the checked ones in bulk -------------------------
const {
  migrateTargets,
  runningTargets,
  closedTargets,
  migrating,
  loadMigrateTargets,
  migrateTo,
  bulkConfirm,
  askBulkMigrate,
  runBulkMigrate,
} = useSessionMigration({
  checkedSessions,
  clearChecked: () => {
    checkedIds.value = new Set()
  },
})

// --- which ACCOUNT the open chat is talking to ---------------------------------------------------
const { sessionAccount, openingInstance, openSessionInstance, copySessionAccountEmail } =
  useSessionAccount({ selected, instanceLabelFor })
/** The account's name as shown: the handle (the address's local part) is masked in privacy mode;
 *  an instance label, the fallback when no address is known, is not PII and stays. */
const accountShown = (a: { name: string; email: string | null }) =>
  a.email ? piiName(a.name) : a.name

// --- advanced (body) search: server-side, streams every transcript's raw content ------------------
const {
  advancedOpen,
  advancedQuery,
  advancedRegex,
  bodySearching,
  bodySearchActive,
  bodySearchQueryUsed,
  bodyResults,
  runBodySearch,
  bodySearchNotice,
  canSearchEverything,
  exitBodySearch,
  selectFromBodyResult,
} = useBodySearch({
  sessions,
  scopesFor: (text: string) => effectiveScopes(viewScopes.value, text, searchOnlyThisView.value),
  advancedCaseSensitive,
  selectedId,
  selectedSource,
  selected,
  select,
  loadTail,
  anchorNextOpen,
})

// --- jump to ONE session, asked from a dialog here or from another view ---------------------------
const { openFromBulkDialog } = useSessionJump({
  sessions,
  sessionPeriod,
  selectMode,
  toggleSelectMode,
  search,
  select,
  clearBulkConfirm: () => {
    bulkConfirm.value = null
  },
})

const composerTargets = computed<ComposerTarget[]>(() => {
  if (selectMode.value)
    return sessions.value
      .filter((s) => s.source === 'claude' && checkedIds.value.has(sessionKey(s)))
      .map((s) => ({
        session_id: s.session_id,
        title: s.title,
        cwd: s.cwd,
        instance: s.instance,
      }))
  const s = selected.value
  return s?.source === 'claude'
    ? [{ session_id: s.session_id, title: s.title, cwd: s.cwd, instance: s.instance }]
    : []
})

// Only the `claude` CLI can be handed a prompt, so Codex and OpenCode transcripts get no
// composer. Left at that the reply box simply is not there, which reads as a bug rather
// than a boundary, so name the source that owns the conversation instead.
// Deliberately not `!composerTargets.length`: in select mode an empty selection also
// empties that list, and the open session there may well be a Claude one.
const readOnlySource = computed(() => {
  if (selectMode.value) return null
  const s = selected.value
  return s && s.source !== 'claude' ? s.source : null
})

function onComposerSent(mode: 'now' | 'queued') {
  // the queue watcher above catches the status flip; this covers the first tokens
  if (mode === 'now' && selectedId.value) window.setTimeout(() => loadTail({ silent: true }), 1200)
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- The sidebar CliMayte runs too (SideBar.vue): rail, resize, grouped rows. -->
    <SideBar
      storage-key="agenthydra.sessions"
      :groups="sideGroups"
      :empty="
        !(sessionsLoading && sessions.length === 0 && !bodySearchActive) &&
        !bodySearchActive &&
        filtered.length === 0
      "
      :class="{ 'select-none': box }"
      @pointerdown="boxPointerDown"
      @click.capture="boxClickGuard"
      @keydown="listKeydown"
    >
        <template #header>
        <div class="flex shrink-0 items-center gap-2 px-3 py-1.5 pe-11">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="searchInput"
              v-model="search"
              :placeholder="$t('sessions.searchPlaceholder')"
              leading="icon"
              trailing="icon"
            />
            <!-- Same popper-anchor rule as the instance filter below: the Popover root lives
                 INSIDE IconTooltip, so PopoverTrigger's PopperAnchor finds the popover's own
                 PopperRoot instead of the tooltip's. Wrapped around the tooltip, this popover was
                 unanchored too. It just failed quietly, because Popover isn't modal and so never
                 froze the page the way the filter menu did. -->
            <IconTooltip :label="$t('sessions.advancedSearch')" :description="$t('sessions.advancedSearchHint')">
              <span class="absolute right-2 top-1/2 inline-flex -translate-y-1/2">
                <Popover v-model:open="advancedOpen">
                  <PopoverTrigger as-child>
                    <button
                      type="button"
                      class="rounded text-muted-foreground transition-colors hover:text-foreground"
                      :aria-label="$t('sessions.advancedSearch')"
                      @click="advancedQuery = advancedQuery || search"
                    >
                      <SlidersHorizontal class="size-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-80">
                    <div class="space-y-3">
                      <p class="text-xs font-semibold">{{ $t('sessions.advancedSearchTitle') }}</p>
                      <div class="space-y-1.5">
                        <label class="text-xs font-medium text-muted-foreground">
                          {{ $t('sessions.advancedSearchQueryLabel') }}
                        </label>
                        <Input
                          v-model="advancedQuery"
                          :placeholder="$t('sessions.advancedSearchQueryPlaceholder')"
                          variant="mono"
                          @keydown.enter="runBodySearch"
                        />
                      </div>
                      <div class="flex items-center justify-between">
                        <IconTooltip :label="$t('sessions.regexMode')" :description="$t('sessions.regexModeHint')">
                          <span class="text-xs" tabindex="0">{{ $t('sessions.regexMode') }}</span>
                        </IconTooltip>
                        <Switch v-model="advancedRegex" size="sm" />
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-xs">{{ $t('sessions.caseSensitive') }}</span>
                        <Switch v-model="advancedCaseSensitive" size="sm" />
                      </div>
                      <Button
                        size="sm"
                        class="w-full"
                        :disabled="!advancedQuery.trim() || bodySearching"
                        @click="runBodySearch"
                      >
                        {{ bodySearching ? $t('sessions.searching') : $t('sessions.searchButton') }}
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </span>
            </IconTooltip>
          </div>
          <!-- Every list control lives in this one ⋯ menu: the toolbar had grown a row of icon
               buttons and each new toggle pushed the search field narrower.
               The DropdownMenu root MUST live INSIDE IconTooltip's slot, never around it.
               reka anchors a popper by walking the COMPONENT tree for the nearest PopperRoot:
               DropdownMenuTrigger renders a MenuAnchor, which injects that nearest root. With the
               menu wrapped AROUND the tooltip, the nearest root was the TOOLTIP's, so the tooltip
               ate the anchor and the menu's own popper got none. floating-ui then left the content
               at its unpositioned `translate(0,-200%)`, i.e. off-screen above the viewport, while
               the modal menu still set `body { pointer-events: none }`. That is the "nothing opens
               and the whole app locks up" bug. Nesting the root here puts PopperRoot(menu) BETWEEN
               the tooltip's anchor and MenuAnchor, so each popper anchors to its own element.
               The <span> is the tooltip's own anchor element (as-child needs one real element). -->
          <IconTooltip
            :label="$t('sessions.listOptions')"
            :description="filtersActive ? $t('sessions.listOptionsActive') : $t('sessions.listOptionsHint')"
          >
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button
                    type="button"
                    :class="cn(buttonVariants({ variant: filtersActive ? 'secondary' : 'outline', size: 'icon' }))"
                    :aria-label="$t('sessions.listOptions')"
                  >
                    <MoreHorizontal />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-56" @close-auto-focus="onListMenuClosed">
                  <DropdownMenuItem @select="refreshSessions">
                    <RefreshCw :class="sessionsLoading ? 'animate-spin' : ''" />
                    {{ $t('sessions.refresh') }}
                  </DropdownMenuItem>

                  <!-- search scope: while the box has text it reads every session; this keeps the
                       sidebar's filters on it instead -->
                  <DropdownMenuCheckboxItem
                    v-model="searchOnlyThisView"
                    :title="$t('sessions.searchOnlyViewHint')"
                    @select.prevent
                  >
                    <Search />
                    {{ $t('sessions.searchOnlyView') }}
                  </DropdownMenuCheckboxItem>

                  <DropdownMenuSeparator />

                  <!-- @select.prevent keeps the menu open so several toggles can be flipped in one
                       visit; reka closes the menu on select otherwise. -->
                  <DropdownMenuCheckboxItem
                    :model-value="selectMode"
                    @select.prevent
                    @update:model-value="toggleSelectMode"
                  >
                    <ListTodo />
                    {{ $t('sessions.multiSelect') }}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />

                  <MultiSelectSubmenu
                    :icon="MessagesSquare"
                    :label="$t('sessions.filterSource')"
                    :summary="sourceFilterLabel"
                    :items="sourceItems"
                    :selected="sessionSourceFilter"
                    @toggle="(v) => sourceToggle(v as api.SessionSource)"
                    @all="sourceAll"
                    @none="sourceNone"
                  />

                  <DropdownMenuSub :disabled="!claudeTicked">
                    <DropdownMenuSubTrigger>
                      <Boxes />
                      {{ $t('sessions.filterInstance') }}
                      <span class="ms-auto max-w-24 truncate ps-2 text-2xs text-muted-foreground">
                        {{ instanceFilterLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-80">
                      <DropdownMenuItem @select.prevent="instanceAll">{{ $t('sessions.selectionAll') }}</DropdownMenuItem>
                      <DropdownMenuItem @select.prevent="instanceNone">{{ $t('sessions.selectionNone') }}</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        :model-value="instanceTicked.includes('default')"
                        @select.prevent
                        @update:model-value="toggleInstance('default')"
                      >
                        {{ $t('sessions.instanceDefault') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem v-for="i in namedInstances" :key="i.name"
                        :model-value="instanceTicked.includes(i.name)"
                        @select.prevent
                        @update:model-value="toggleInstance(i.name)"
                      >
                        {{ i.label }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="instanceTicked.includes('other')"
                        @select.prevent
                        @update:model-value="toggleInstance('other')"
                      >
                        {{ $t('sessions.instanceOther') }}
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- work we queued vs work you drove by hand. Known exactly rather than inferred:
                       every dispatch names the session id on the command line, so a queue row for
                       that id IS the fact. Never applied on our own initiative — 'all' is the
                       default and stays it. -->
                  <!-- Disabled off CLAUDE-ONLY rather than off a list of other sources: both of
                       these facts exist only for Claude (a dispatch names a session id on the
                       command line; a usage wall is judged from a Claude transcript), and the
                       hand-written "codex or opencode" list silently went stale twice as sources
                       were added. -->
                  <MultiSelectSubmenu
                    :icon="ListTodo"
                    :label="$t('sessions.dispatched')"
                    :summary="dispatchedScopeLabel"
                    :items="dispatchedItems"
                    :selected="sessionDispatchedScope"
                    :disabled="!claudeTicked"
                    @toggle="(v) => dispatchedToggle(v as DispatchedValue)"
                    @all="dispatchedAll"
                    @none="dispatchedNone"
                  />

                  <!-- sessions a usage wall cut off. Server-side like the scopes above it, but
                       the verdict comes from the transcript parse rather than the mtime index, so
                       the first use after an upgrade is slow while the scan cache refills. -->
                  <MultiSelectSubmenu
                    :icon="CircleAlert"
                    :label="$t('sessions.rateLimited')"
                    :summary="rateLimitScopeLabel"
                    :items="rateLimitItems"
                    :selected="sessionRateLimitScope"
                    :disabled="!claudeTicked"
                    content-class="max-w-64"
                    @toggle="(v) => rateLimitToggle(v as RateLimitValue)"
                    @all="rateLimitAll"
                    @none="rateLimitNone"
                  >
                    <p class="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">
                      {{ $t('sessions.rateLimitedNote') }}
                    </p>
                  </MultiSelectSubmenu>

                  <!-- shape: derived in the browser from the two numbers already on every row, so
                       unlike the scopes around it this one narrows what was FETCHED rather than
                       reaching further back. The note in the submenu says so. -->
                  <MultiSelectSubmenu
                    :icon="Hourglass"
                    :label="$t('sessions.shape')"
                    :summary="shapeScopeLabel"
                    :items="shapeItems"
                    :selected="sessionShapeScope"
                    content-class="max-w-60"
                    @toggle="(v) => shapeToggle(v as SessionShape)"
                    @all="shapeAll"
                    @none="shapeNone"
                  >
                    <p class="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">
                      {{ $t('sessions.shapeNote') }}
                    </p>
                  </MultiSelectSubmenu>

                  <!-- two boxes: ticking only "Archived" is the way to go back and find one, since archived
                       is the large majority of the store. -->
                  <MultiSelectSubmenu
                    :icon="Archive"
                    :label="$t('sessions.archived')"
                    :summary="archivedScopeLabel"
                    :items="archivedItems"
                    :selected="sessionArchivedScope"
                    @toggle="(v) => archivedToggle(v as ArchivedValue)"
                    @all="archivedAll"
                    @none="archivedNone"
                  />

                  <!-- how far back the list reaches. Applied server-side before the newest-N cap,
                       so widening the window genuinely reaches further back rather than
                       reshuffling the same rows. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <CalendarRange />
                      {{ $t('sessions.period') }}
                      <span class="ms-auto max-w-24 truncate ps-2 text-2xs text-muted-foreground">
                        {{ periodLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionPeriod">
                        <DropdownMenuRadioItem value="24h">{{ $t('sessions.period24h') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="7d">{{ $t('sessions.period7d') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="30d">{{ $t('sessions.period30d') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.periodAll') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <template v-if="doneCount > 0">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem @select="clearDoneMarks">
                      <CircleSlash />
                      {{ $t('sessions.clearDoneMarks') }}
                      <span class="ms-auto ps-2 text-2xs text-muted-foreground">
                        {{ $t('sessions.doneMarkCount', { n: doneCount }) }}
                      </span>
                    </DropdownMenuItem>
                  </template>
                  <!-- This list's own settings (SessionSettings.vue): an item here rather than a gear
                       beside the menu, which would take the search field's width again. -->
                  <DropdownMenuSeparator />
                  <DropdownMenuItem @select="openSettingsAfterMenu">
                    <Settings2 />
                    {{ $t('sessions.settingsTitle') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>
          <PageSettingsDialog v-model:open="sessionSettingsOpen" :title="$t('sessions.settingsTitle')">
            <SessionSettings />
          </PageSettingsDialog>
        </div>

        <div
          v-if="selectMode"
          class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs"
        >
          <span class="text-muted-foreground">{{ $t('sessions.selectedCount', { n: checkedIds.size }) }}</span>
          <Button variant="ghost" size="xs" @click="checkAllFiltered">{{ $t('sessions.selectAll') }}</Button>
          <Button
            variant="ghost"
            size="xs"
            :disabled="checkedIds.size === 0"
            @click="clearChecked"
          >
            {{ $t('sessions.clearSelection') }}
          </Button>
        </div>

        <!-- body-search results header: appears in place of the normal list once a content
             search has been run; "back" restores the plain metadata-filtered list -->
        <div
          v-if="bodySearchActive"
          class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs"
        >
          <Button variant="ghost" size="xs" @click="exitBodySearch">
            <ArrowLeft class="size-3" /> {{ $t('sessions.backToSessionList') }}
          </Button>
          <span class="truncate text-muted-foreground">
            {{ $t('sessions.bodySearchResultsFor', { query: bodySearchQueryUsed }) }}
          </span>
        </div>
        <!-- say what was actually searched. An empty result means nothing until you know whether
             the search covered everything, gave up early, or only read the conversation -->
        <div
          v-if="bodySearchActive && bodySearchNotice"
          class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-warning/10 px-3 py-1.5 text-2xs text-muted-foreground"
        >
          <span>{{ bodySearchNotice }}</span>
          <button
            v-if="canSearchEverything"
            class="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
            :disabled="bodySearching"
            @click="runBodySearch({ everything: true })"
          >
            {{ bodySearching ? $t('sessions.searching') : $t('sessions.searchEverything') }}
          </button>
        </div>

        </template>

        <!-- The pointer/keydown handlers on the list (box select, Ctrl+A and Escape over the rows,
             composables/useMultiSelect.ts) are SideList's attrs, which land on its scrolling body;
             the band is drawn in the list's content coordinates, and select-none keeps a drag from
             the padding off the page text -->
        <template #before>
          <div
            v-if="box"
            class="pointer-events-none absolute inset-x-1 top-(--box-top) z-10 h-(--box-h) rounded-md border border-primary/60 bg-primary/10"
            :style="{ '--box-top': `${box.top}px`, '--box-h': `${box.height}px` }"
            aria-hidden="true"
          />
          <!-- a LATER poll failing must not blank a list that already has good (if aging) data —
               it stays on screen, just labelled stale. Non-modal: a state of the list, not a toast. -->
          <p
            v-if="sessionsStatus.stale.value"
            class="m-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning"
          >
            {{ $t('sessions.staleHint', { reason: sessionsStatus.error.value }) }}
          </p>
        </template>

        <template #empty>
          <!-- AH-20: the FIRST session fetch failing is not the same fact as a genuinely empty
               list — show why, with a Retry, rather than the plain "no sessions" copy that would
               read as an empty account instead of an outage. -->
          <div
            v-if="sessionsStatus.unavailable.value"
            class="p-4 text-center text-xs text-muted-foreground"
          >
            <CircleAlert class="mx-auto mb-1.5 size-5 text-warning" />
            <p>{{ $t('sessions.unavailable', { reason: sessionsStatus.error.value }) }}</p>
            <button
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="refreshSessions"
            >
              {{ $t('sessions.retry') }}
            </button>
          </div>

          <div v-else class="p-4 text-center text-xs text-muted-foreground">
            <p v-if="filtersHideEverything">{{ $t('sessions.filtersHideEverything') }}</p>
            <p v-else>{{ $t('sessions.noSessionsFound') }}</p>
            <button
              v-if="filtersHideEverything"
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="resetFilters"
            >
              {{ $t('sessions.filtersReset') }}
            </button>
            <!-- the window is the most likely reason, and it is invisible until you open the ⋯
                 menu; offer the widening instead of making the user go find it -->
            <button
              v-if="emptyBecauseOfPeriod && !filtersHideEverything"
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="sessionPeriod = 'all'"
            >
              {{ $t('sessions.periodEmptyHint', { period: periodLabel }) }}
            </button>
          </div>
        </template>

          <!-- first-load skeletons so the list never looks blank -->
          <template v-if="sessionsLoading && sessions.length === 0 && !bodySearchActive">
            <div v-for="i in 12" :key="i" class="flex h-8 items-center gap-2 border-b border-border px-3">
              <Skeleton class="h-4 w-(--skeleton-w)" :style="{ '--skeleton-w': `${72 - (i % 3) * 16}%` }" />
              <Skeleton class="ms-auto h-3 w-10" />
            </div>
          </template>

          <!-- content (body) search results -->
          <template v-else-if="bodySearchActive">
            <p v-if="bodyResults.length === 0" class="p-4 text-center text-xs text-muted-foreground">
              {{ $t('sessions.noBodyMatches') }}
            </p>
            <button
              v-for="r in bodyResults"
              :key="`${r.source}:${r.session_id}`"
              class="w-full border-b border-border px-3 py-1.5 text-start transition-colors hover:bg-accent/50"
              @click="selectFromBodyResult(r)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="line-clamp-1 min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                  {{ baseName(r.cwd) }} · {{ shortId(r.session_id) }}
                </span>
                <SourceBadge :source="r.source">
                  {{ rowSourceLabel(r) }}
                </SourceBadge>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                  {{ $t('sessions.matchCount', { n: r.match_count }) }}
                </span>
              </div>
              <p
                v-for="(snippet, i) in r.snippets"
                :key="i"
                class="mt-0.5 truncate text-xs text-muted-foreground"
                :title="snippet"
              >
                {{ snippet }}
              </p>
              <p v-if="r.truncated" class="mt-0.5 text-2xs text-muted-foreground/70">
                {{ r.match_count - r.snippets.length }} {{ $t('sessions.truncatedMatches') }}
              </p>
            </button>
          </template>

          <template #row="{ item: s }">
            <!-- Each row owns a ContextMenu so right-click acts on the row under the pointer without
                 first selecting it (selecting would load a transcript the user never asked for).
                 The menu content only mounts while open, so the per-row cost is a reka root, not a
                 rendered menu. -->
            <ContextMenu>
              <ContextMenuTrigger as-child>
                <!-- One line per session, laid out as a CliMayte task row (owner, 2026-10-03): a
                     status icon, the tool as a small icon, the title, the few marks, "model ·
                     effort" and when it last moved. Where it
                     ran, the branch, the size, the account, its parts and subagents ride on the
                     row's hover (rowHintOf); the open transcript has all of it. -->
                <SideListRow
                  :data-select-key="s.source === 'claude' ? sessionKey(s) : undefined"
                  :label="s.title"
                  :selected="
                    selectMode ? isChecked(s) : s.session_id === selectedId && s.source === selectedSource
                  "
                  :hint="rowHintOf(s)"
                  :dim="s.done && s.session_id !== selectedId"
                  :struck="s.done"
                  :chip="s.instance_num ? `#${s.instance_num}` : undefined"
                  :chip-hint="s.instance ?? undefined"
                  :tag="modelEffortTag(modelOf(s), effortOf(s))"
                  :time="timeAgo(s.last_activity_at)"
                  @click="rowClick(s, $event)"
                >
                  <template #badge>
                    <span
                      v-if="selectMode"
                      class="grid size-4 shrink-0 place-items-center rounded border transition-colors"
                      :class="[
                        isChecked(s)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                        s.source !== 'claude' ? 'opacity-25' : '',
                      ]"
                    >
                      <Check v-if="isChecked(s)" class="size-3" />
                    </span>
                    <!-- One leading icon (owner, 2026-10-04): the tool's icon, with a green or
                         yellow dot on its corner while the last turn is fresh (none once it is
                         stale, the same fact as the time on the right). The spinner takes its
                         place while it works, the done mark once it is done. -->
                    <span class="relative grid size-3.5 shrink-0 place-items-center">
                      <Loader2
                        v-if="isLive(s)"
                        class="size-3.5 animate-spin text-primary"
                        :aria-label="$t('sessions.agentStatusWorking')"
                      />
                      <CircleCheck
                        v-else-if="s.done"
                        class="size-3.5 text-success"
                        :aria-label="$t('sessions.done')"
                      />
                      <template v-else>
                        <!-- a chat that came from another PC through the chat sync: a cloud, as
                             CliMayte marks another PC's task (owner, 2026-10-04) -->
                        <component
                          :is="s.from_pc ? Cloud : sessionSourceIcon(s.source, rowSourceLabel(s))"
                          class="size-3.5 text-muted-foreground"
                          :aria-label="s.from_pc ? $t('sessions.fromPc', { pc: s.from_pc }) : rowSourceLabel(s)"
                          :title="s.from_pc ? $t('sessions.fromPc', { pc: s.from_pc }) : rowSourceLabel(s)"
                        />
                        <span
                          v-if="activityOf(s) !== 'stale'"
                          class="absolute -end-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background"
                          :class="ACTIVITY_CLASS[activityOf(s)]"
                          :title="$t(ACTIVITY_LABEL[activityOf(s)])"
                        ></span>
                      </template>
                    </span>
                  </template>
                  <template #title>
                    <!-- the search's matched characters, bolded; one plain run when not searching.
                         A session that moved since you last opened it is bold all through. -->
                    <span :class="unread(s) ? 'font-bold' : undefined"><span
                      v-if="unread(s)"
                      class="sr-only"
                    >{{ $t('sessions.unread') }}: </span><template v-for="(run, ri) in titleRunsOf(s)" :key="ri"><span
                      v-if="run.hit"
                      class="font-semibold text-primary"
                    >{{ run.text }}</span><template v-else>{{ run.text }}</template></template></span><!--
                    A title nobody chose gets a mark, and only that case: the string came out of a
                    wrapper around the first message, so it may match nothing the user has named.
                    --><span
                      v-if="titleIsUnattributed(s)"
                      class="ms-1 align-middle text-3xs font-normal text-muted-foreground/70"
                    >&lt;{{ s.title_tag }}&gt;</span>
                  </template>
                  <template #mark>
                    <!-- what this chat handed off (owner, 2026-10-04), each with its tab's icon -->
                    <span
                      v-if="s.offloads?.hswarm"
                      class="inline-flex shrink-0 items-center gap-0.5 text-2xs font-normal tabular-nums text-muted-foreground"
                      :title="$t('sessions.offloadsHswarm', s.offloads.hswarm)"
                    >
                      <Layers class="size-3" aria-hidden="true" />{{ s.offloads.hswarm }}
                      <span class="sr-only">{{ $t('sessions.offloadsHswarm', s.offloads.hswarm) }}</span>
                    </span>
                    <span
                      v-if="s.offloads?.climayte"
                      class="inline-flex shrink-0 items-center gap-0.5 text-2xs font-normal tabular-nums text-muted-foreground"
                      :title="$t('sessions.offloadsClimayte', s.offloads.climayte)"
                    >
                      <Bot class="size-3" aria-hidden="true" />{{ s.offloads.climayte }}
                      <span class="sr-only">{{ $t('sessions.offloadsClimayte', s.offloads.climayte) }}</span>
                    </span>
                    <!-- with "show archived" on, the one mark that tells an archived row from a live one -->
                    <span
                      v-if="s.archived"
                      class="relative inline-flex shrink-0 items-center text-muted-foreground"
                      :title="$t('sessions.archived')"
                    >
                      <Archive class="size-3.5" aria-hidden="true" />
                      <span class="sr-only">{{ $t('sessions.archived') }}</span>
                    </span>
                    <!-- ONLY while the wall is still the bottom of the transcript: `pending` is
                         nothing followed the notice, so it is still sitting there. -->
                    <span
                      v-if="s.limit_stop?.pending"
                      class="relative inline-flex shrink-0 items-center text-warning"
                      :title="`${$t('sessions.rateLimitedBadgePending')}: ${limitTooltipOf(s)}`"
                    >
                      <CircleAlert class="size-3.5" aria-hidden="true" />
                      <span class="sr-only">{{ $t('sessions.rateLimitedBadgePending') }}</span>
                    </span>
                    <!-- live status as the daemon wrote it (agent-status.ts); "working" is the
                         row's spinner, so only blocked and done are marks here. The tooltip carries
                         the provenance, so a mark can be traced to the hook event that set it. -->
                    <span
                      v-if="agentStatusOf(s) && agentStatusOf(s)?.state !== 'working'"
                      class="relative inline-flex shrink-0 items-center"
                      :class="AGENT_STATUS_ICON[agentStatusOf(s)?.state ?? 'done'].tone"
                      :title="`${$t(AGENT_STATUS_LABEL[agentStatusOf(s)?.state ?? 'done'])}: ${$t('sessions.agentStatusTooltip', {
                        event: agentStatusOf(s)?.event,
                        waiting: agentStatusOf(s)?.waiting ?? '-',
                        subagents: agentStatusOf(s)?.subagents,
                      })}`"
                    >
                      <component
                        :is="AGENT_STATUS_ICON[agentStatusOf(s)?.state ?? 'done'].icon"
                        class="size-3.5"
                        aria-hidden="true"
                      />
                      <span class="sr-only">{{ $t(AGENT_STATUS_LABEL[agentStatusOf(s)?.state ?? 'done']) }}</span>
                    </span>
                    <span
                      v-if="s.queue_status && !queueStatusMeta(s.queue_status).spin"
                      class="relative inline-flex shrink-0 items-center"
                      :class="queueIconTone(s.queue_status)"
                      :title="queueStatusMeta(s.queue_status).label"
                    >
                      <component :is="queueStatusMeta(s.queue_status).icon" class="size-3.5" aria-hidden="true" />
                      <span class="sr-only">{{ queueStatusMeta(s.queue_status).label }}</span>
                    </span>
                    <ListTodo
                      v-else-if="s.dispatched && !s.queue_status"
                      class="size-3.5 shrink-0 text-muted-foreground"
                      :aria-label="$t('sessions.dispatched')"
                    />
                    <!-- one conversation, several transcripts. Deliberately a label and not a
                         fold: every older copy measured held turns the newer one did not. Why this
                         part ended is its hover. -->
                    <span
                      v-if="s.copy_count > 1"
                      class="shrink-0 text-2xs text-muted-foreground tabular-nums"
                      :title="copyWhyOf(s)"
                    >{{ $t('sessions.copyOf', { i: s.copy_index, n: s.copy_count }) }}</span>
                  </template>
                </SideListRow>
              </ContextMenuTrigger>
              <ContextMenuContent class="max-w-60">
                <!-- Bulk section: only when THIS row is one of several checked rows, so a
                     right-click on an unchecked row still acts on that row alone. -->
                <template v-if="selectMode && bulkCount > 1 && isChecked(s)">
                  <ContextMenuLabel>
                    {{ $t('sessions.selectedCount', { n: bulkCount }) }}
                  </ContextMenuLabel>
                  <ContextMenuItem @select="copyCheckedIds">
                    <Copy />
                    {{ $t('sessions.copyNIds', { n: bulkCount }) }}
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger @pointerenter="loadMigrateTargets(null)">
                      <ArrowRightLeft class="size-3.5" />
                      {{ $t('sessions.migrateBulkLabel', { n: bulkCount }) }}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem v-if="migrateTargets.length === 0" disabled>
                        {{ $t('sessions.migrateNoTargets') }}
                      </ContextMenuItem>
                      <template v-if="runningTargets.length">
                        <ContextMenuLabel>
                          {{ $t('sessions.migrateRunningGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in runningTargets"
                          :key="target.ref"
                          :disabled="migrating"
                          @select="askBulkMigrate(target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ target.name }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                      <template v-if="closedTargets.length">
                        <ContextMenuSeparator v-if="runningTargets.length" />
                        <ContextMenuLabel>
                          {{ $t('sessions.migrateClosedGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in closedTargets"
                          :key="target.ref"
                          :disabled="migrating"
                          @select="askBulkMigrate(target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                </template>
                <ContextMenuItem @select="toggleDone(s)">
                  <CircleCheck v-if="!s.done" />
                  <CircleSlash v-else />
                  {{ s.done ? $t('sessions.markNotDone') : $t('sessions.markDone') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @select="select(s)">
                  <MessagesSquare />
                  {{ $t('sessions.openTranscript') }}
                </ContextMenuItem>
                <template v-if="SOURCE_HAS_FILE[s.source]">
                  <!-- Not offered for a source whose file is not prose (see SOURCE_FILE_IS_TEXT):
                       an editor pointed at a compressed log shows binary, which reads as a corrupt
                       session. The readable exports below are the way in for those. -->
                  <ContextMenuItem v-if="SOURCE_FILE_IS_TEXT[s.source]" @select="openFile(s)">
                    <FileSymlink />
                    {{ $t('sessions.openFile') }}
                  </ContextMenuItem>
                  <ContextMenuItem :disabled="copyingFile" @select="copyFile(s)">
                    <ClipboardCopy />
                    {{ $t('sessions.copyFile') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="copyFileLocation(s)">
                    <Copy />
                    {{ $t('sessions.copyFileLocation') }}
                  </ContextMenuItem>
                </template>
                <!-- Same migrate flyout the open chat's ⋯ menu has, reachable without first opening
                     the transcript. Claude only: it is the one provider with desktop instances. -->
                <template v-if="s.source === 'claude'">
                  <ContextMenuSeparator />
                  <ContextMenuSub>
                    <ContextMenuSubTrigger @pointerenter="loadMigrateTargets(s)">
                      <ArrowRightLeft class="size-3.5" />
                      {{ $t('sessions.migrateAccount') }}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem v-if="migrateTargets.length === 0" disabled>
                        {{ $t('sessions.migrateNoTargets') }}
                      </ContextMenuItem>
                      <template v-if="runningTargets.length">
                        <ContextMenuLabel>
                          {{ $t('sessions.migrateRunningGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in runningTargets"
                          :key="target.ref"
                          :disabled="migrating || target.isCurrent"
                          @select="migrateTo(s, target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ target.name }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                      <template v-if="closedTargets.length">
                        <ContextMenuSeparator v-if="runningTargets.length" />
                        <ContextMenuLabel>
                          {{ $t('sessions.migrateClosedGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in closedTargets"
                          :key="target.ref"
                          :disabled="migrating || target.isCurrent"
                          @select="migrateTo(s, target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </template>
                <ContextMenuSeparator />
                <ContextMenuItem @select="copy(s.title)">
                  <Copy />
                  {{ $t('sessions.copyTitle') }}
                </ContextMenuItem>
                <ContextMenuItem @select="copy(s.cwd)">
                  <FolderGit2 />
                  {{ $t('sessions.copyCwd') }}
                </ContextMenuItem>
                <ContextMenuItem @select="copy(s.session_id)">
                  <Copy />
                  {{ $t('sessions.copySessionId') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </template>
    </SideBar>

    <!-- detail: its own scroll column, composer pinned at the bottom -->
    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div v-if="!selected" class="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        <div class="text-center">
          <MessagesSquare class="mx-auto mb-2 size-8 opacity-40" />
          {{
            selectMode
              ? composerTargets.length
                ? $t('sessions.composeToSelected', { n: composerTargets.length })
                : $t('sessions.selectSessionsHint')
              : $t('sessions.selectSessionPrompt')
          }}
        </div>
      </div>

      <template v-else>
        <!-- borderless header: title + meta on the left, tool toggle + actions on the right -->
        <div class="shrink-0 p-4 pb-3">
          <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div class="min-w-0">
              <h2 class="truncate text-base font-semibold">{{ selected.title }}</h2>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span class="font-mono">{{ shortId(selected.session_id) }}</span>
                <SourceBadge :source="selected.source">
                  {{ rowSourceLabel(selected) }}
                </SourceBadge>
                <!-- Which account is having this conversation. Read-only here on purpose: the
                     acts (open it, copy its address) live in the ⋯ menu, so a metadata line stays
                     a metadata line. The hover carries the full address, because the chip shows
                     the handle and two accounts on different domains share a handle. -->
                <!-- Two different reasons there is no address, and they are not interchangeable:
                     the instance is not in the list at all, or it IS and has no resolved identity
                     (signed out, or still resolving). Saying the first when it is the second sends
                     you looking for a missing instance that is sitting right there. -->
                <IconTooltip
                  v-if="sessionAccount"
                  :label="$t('sessions.accountLabel')"
                  :description="
                    (sessionAccount.email ? $pii(sessionAccount.email) : null) ??
                    (sessionAccount.instance
                      ? $t('sessions.accountAddressUnknown')
                      : $t('sessions.accountUnresolved'))
                  "
                >
                  <span class="inline-flex items-center gap-1">
                    <UserRound class="size-3" />{{ accountShown(sessionAccount) }}
                  </span>
                </IconTooltip>
                <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ selected.cwd }}</span>
                <span class="inline-flex items-center gap-1">
                  <MessagesSquare class="size-3" />{{ tail?.events.length ?? 0 }} {{ $t('sessions.turnsShown') }}
                </span>
                <IconTooltip
                  v-if="usageSummary"
                  :label="$t('sessions.usageLabel')"
                  :description="usageDetail"
                >
                  <span class="inline-flex items-center gap-1">
                    <Coins class="size-3" />{{ usageSummary }}
                  </span>
                </IconTooltip>
                <!-- only ever shown when there is something to say. A permanent "0 secrets" badge
                     would read as a clean bill of health, which this scan cannot give. -->
                <IconTooltip
                  v-if="secrets && secrets.count > 0"
                  :label="$t('sessions.secretsLabel')"
                  :description="secretsDetail"
                >
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-warning"
                    @click="secretsOpen = true"
                  >
                    <KeyRound class="size-3" />{{ $t('sessions.secretsCount', { n: secrets.count }) }}
                  </button>
                </IconTooltip>
              </div>
            </div>
            <!-- Four standalone controls, everything else behind ⋯ — the same treatment the list
                 toolbar got, for the same reason: this row had grown to nine icon buttons and, being
                 in a wrapping flex beside the title, it stole a line from the metadata on any narrow
                 window. What stays out is what you reach for mid-read (find), plus the two copies
                 you hand to another tool (path, session id), plus close. The rest are
                 once-per-session acts and cost one extra click. -->
            <div class="flex shrink-0 items-center gap-1.5">
              <IconTooltip
                :label="$t('sessions.findInSession')"
                :description="$t('sessions.findInSessionHint')"
              >
                <Button
                  :variant="findOpen ? 'secondary' : 'outline'"
                  size="sm"
                  :aria-label="$t('sessions.findInSession')"
                  @click="findOpen ? closeFind() : openFind()"
                >
                  <Search />
                </Button>
              </IconTooltip>
              <!-- Link, not Copy: it sits next to the copy-session-id button, and two identical
                   clipboard glyphs side by side are indistinguishable at icon size. -->
              <IconTooltip
                v-if="SOURCE_HAS_FILE[selected.source]"
                :label="$t('sessions.copyFileLocation')"
                :description="$t('sessions.copyFileLocationHint')"
              >
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="$t('sessions.copyFileLocation')"
                  @click="copyFileLocation(selected)"
                >
                  <Link />
                </Button>
              </IconTooltip>
              <IconTooltip
                :label="$t('sessions.copySessionId')"
                :description="$t('sessions.copySessionIdHint')"
              >
                <Button variant="outline" size="sm" @click="copy(selected.session_id)">
                  <Copy /> {{ $t('sessions.id') }}
                </Button>
              </IconTooltip>
              <!-- Display toggles + every file action. The DropdownMenu root MUST live INSIDE
                   IconTooltip's slot, wrapped in an element the tooltip can anchor to — see
                   scripts/checks/reka-popper-root-inside-tooltip.mjs for what happens otherwise.
                   The trigger goes `secondary` while a display filter is on, so a transcript that
                   is hiding turns still says so from the collapsed toolbar. -->
              <IconTooltip
                :label="$t('sessions.chatOptions')"
                :description="displayFiltered ? $t('sessions.displayControlsActive') : $t('sessions.chatOptionsHint')"
              >
                <span class="inline-flex">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        :variant="displayFiltered ? 'secondary' : 'outline'"
                        size="sm"
                        :aria-label="$t('sessions.chatOptions')"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="max-w-72">
                      <!-- The menu leads with WHICH ACCOUNT this chat is talking to, and the two
                           things you want from that answer: its app, or its address. Every instance
                           runs a different Anthropic login, and until now the open transcript named
                           none of them — you had to go to the Instances tab and match by folder.
                           Same reason the instance tables' kebabs lead with the instance number:
                           an open menu detached from the thing it acts on is a menu you hesitate
                           over. -->
                      <template v-if="sessionAccount">
                        <DropdownMenuLabel>
                          <span class="flex items-center gap-2">
                            <UserRound class="size-3.5 shrink-0" />
                            <span class="truncate">{{ accountShown(sessionAccount) }}</span>
                          </span>
                        </DropdownMenuLabel>
                        <!-- Unresolvable is a real state, not a blank: the instance folder may be
                             gone, or the regular non-isolated install may simply not be running (it
                             only appears in the list while a process for it does). Say so rather
                             than offering two controls that cannot work. -->
                        <DropdownMenuItem v-if="!sessionAccount.instance" disabled>
                          <Boxes class="size-3.5" />{{ $t('sessions.accountUnresolved') }}
                        </DropdownMenuItem>
                        <template v-else>
                          <DropdownMenuItem
                            :disabled="openingInstance"
                            @select="openSessionInstance()"
                          >
                            <Boxes class="size-3.5" />
                            {{
                              sessionAccount.instance.isRunning
                                ? $t('sessions.focusAccountInstance')
                                : $t('sessions.openAccountInstance')
                            }}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            :disabled="!sessionAccount.email"
                            @select="copySessionAccountEmail()"
                          >
                            <Copy class="size-3.5" />{{ $t('sessions.copyAccountEmail') }}
                          </DropdownMenuItem>
                        </template>
                        <DropdownMenuSeparator />
                      </template>
                      <DropdownMenuLabel>
                        <span class="flex items-center gap-2">
                          <SlidersHorizontal class="size-3.5" />{{ $t('sessions.displayControls') }}
                        </span>
                      </DropdownMenuLabel>
                      <DropdownMenuCheckboxItem
                        :model-value="humanOnly"
                        @select.prevent
                        @update:model-value="humanOnly = $event"
                      >
                        <UserRound class="size-3.5" />{{ $t('sessions.humanOnly') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="showTools"
                        :disabled="humanOnly"
                        @select.prevent
                        @update:model-value="showTools = $event"
                      >
                        <Wrench class="size-3.5" />{{ $t('sessions.showToolActivity') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="showThinking"
                        :disabled="humanOnly"
                        @select.prevent
                        @update:model-value="showThinking = $event"
                      >
                        <Brain class="size-3.5" />{{ $t('sessions.showThinking') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="compactTranscript"
                        @select.prevent
                        @update:model-value="compactTranscript = $event"
                      >
                        <AlignJustify class="size-3.5" />{{ $t('sessions.compactLayout') }}
                      </DropdownMenuCheckboxItem>

                      <template v-if="SOURCE_HAS_FILE[selected.source]">
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>
                          <span class="flex items-center gap-2">
                            <FileSymlink class="size-3.5" />{{ $t('sessions.fileActions') }}
                          </span>
                        </DropdownMenuLabel>
                        <DropdownMenuItem
                          v-if="SOURCE_FILE_IS_TEXT[selected.source]"
                          @select="openFile(selected)"
                        >
                          <FileSymlink />{{ $t('sessions.openFile') }}
                        </DropdownMenuItem>
                        <!-- one entry, three formats. The raw .jsonl is still here because it is
                             the only lossless one; the two readable exports are what you hand to a
                             person. -->
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Download class="size-3.5" />{{ $t('sessions.saveCopy') }}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem as-child>
                              <a
                                :href="
                                  sessionExportUrl(
                                    selected.session_id,
                                    selected.source,
                                    'markdown',
                                    false,
                                    selected.locator,
                                  )
                                "
                                download
                              >
                                <FileText />{{ $t('sessions.exportMarkdown') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem as-child>
                              <a
                                :href="
                                  sessionExportUrl(
                                    selected.session_id,
                                    selected.source,
                                    'html',
                                    false,
                                    selected.locator,
                                  )
                                "
                                download
                              >
                                <Globe />{{ $t('sessions.exportHtml') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem as-child>
                              <a
                                :href="sessionFileUrl(selected.session_id, selected.source)"
                                :download="safeTranscriptFilename(selected.title, selected.session_id)"
                              >
                                <FileSymlink />{{ $t('sessions.exportRaw') }}
                              </a>
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem :disabled="copyingFile" @select="copyFile(selected)">
                          <ClipboardCopy />{{ $t('sessions.copyFile') }}
                        </DropdownMenuItem>
                      </template>

                      <template v-if="selected.source === 'claude'">
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :disabled="resuming" @select="resumeInTerminal(selected)">
                          <SquareTerminal />{{ $t('sessions.resumeTerminal') }}
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger @pointerenter="loadMigrateTargets(selected)">
                            <ArrowRightLeft class="size-3.5" />{{ $t('sessions.migrateAccount') }}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem v-if="migrateTargets.length === 0" disabled>
                              {{ $t('sessions.migrateNoTargets') }}
                            </DropdownMenuItem>
                            <!-- Two groups. Running instances take the chat as they stand; a closed
                                 one is started first (a deliberate click, so the "nothing opens an
                                 account on its own" rule holds), then the chat moves. -->
                            <template v-if="runningTargets.length">
                              <DropdownMenuLabel>
                                {{ $t('sessions.migrateRunningGroup') }}
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                v-for="target in runningTargets"
                                :key="target.ref"
                                :disabled="migrating || target.isCurrent"
                                @select="migrateTo(selected, target)"
                              >
                                <ArrowRightLeft class="size-3.5" />
                                <span class="flex flex-col">
                                  <span>{{ target.name }}</span>
                                  <span v-if="target.account" class="text-xs text-muted-foreground">
                                    {{ target.account }}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            </template>
                            <template v-if="closedTargets.length">
                              <DropdownMenuSeparator v-if="runningTargets.length" />
                              <DropdownMenuLabel>
                                {{ $t('sessions.migrateClosedGroup') }}
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                v-for="target in closedTargets"
                                :key="target.ref"
                                :disabled="migrating || target.isCurrent"
                                @select="migrateTo(selected, target)"
                              >
                                <ArrowRightLeft class="size-3.5" />
                                <span class="flex flex-col">
                                  <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                                  <span v-if="target.account" class="text-xs text-muted-foreground">
                                    {{ target.account }}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            </template>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </template>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </IconTooltip>
              <!-- close the open transcript (back to the pick-a-session state); the queue
                   drawer moved to the single purple button in the app header -->
              <IconTooltip :label="$t('sessions.closeChat')">
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="$t('sessions.closeChat')"
                  @click="selectedId = null"
                >
                  <X />
                </Button>
              </IconTooltip>
            </div>
          </div>
        </div>

        <!-- find within the loaded transcript: client-side, so the count is exact for what is on
             screen and there is no request behind a keystroke -->
        <div
          v-if="findOpen"
          class="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-2"
        >
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref="findInput"
            v-model="findQuery"
            class="max-w-xs"
            :placeholder="$t('sessions.findPlaceholder')"
            :aria-label="$t('sessions.findInSession')"
            @keydown.enter.exact.prevent="goToMatch(findIndex + 1)"
            @keydown.enter.shift.prevent="goToMatch(findIndex - 1)"
            @keydown.esc.prevent="closeFind"
          />
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
            {{
              findQuery
                ? findTotal
                  ? $t('sessions.findPosition', { i: findIndex + 1, n: findTotal })
                  : $t('sessions.findNone')
                : ''
            }}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!findTotal"
            :aria-label="$t('sessions.findPrevious')"
            @click="goToMatch(findIndex - 1)"
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!findTotal"
            :aria-label="$t('sessions.findNext')"
            @click="goToMatch(findIndex + 1)"
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="ms-auto"
            :aria-label="$t('sessions.findClose')"
            @click="closeFind"
          >
            <X />
          </Button>
        </div>

        <!-- transcript, styled as a chat: user bubbles right, replies as prose, tool calls and
             reasoning folded into one work row per run (SessionTranscriptTurns).
             role=log + aria-relevant=additions: a screen reader hears turns as they arrive, not
             the whole pane again. data-pending-scroll holds until the opening position is set. -->
        <div
          ref="chatEl"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          :aria-busy="tailLoading || olderLoading"
          :data-pending-scroll="scrollPending || undefined"
          class="scroll-slim min-h-0 flex-1 overflow-y-auto"
          :class="compactTranscript && 'transcript-compact'"
        >
          <div class="mx-auto w-full max-w-3xl p-4">
            <template v-if="tailLoading">
              <div class="space-y-4">
                <div class="flex justify-end"><Skeleton shape="bubble" class="h-9 w-2/5" /></div>
                <div class="flex"><Skeleton shape="bubble" class="h-20 w-4/5" /></div>
                <div class="flex justify-end"><Skeleton shape="bubble" class="h-9 w-1/3" /></div>
                <div class="flex"><Skeleton shape="bubble" class="h-14 w-3/5" /></div>
              </div>
            </template>

            <p v-else-if="tail?.error" class="text-xs text-destructive">{{ tail.error }}</p>
            <p v-else-if="events.length === 0" class="text-xs text-muted-foreground">
              {{ $t('sessions.noDisplayableTurns') }}
            </p>

            <template v-else>
              <!-- history paging: the window grows a page upward and the reader's turn stays put
                   (useChatScroller.prepend), up to the daemon's own cap -->
              <div v-if="canLoadOlder" class="flex justify-center">
                <Button variant="ghost" size="sm" :disabled="olderLoading" @click="loadOlder">
                  <ChevronUp />
                  {{ olderLoading ? $t('sessions.loadingOlder') : $t('sessions.loadOlder') }}
                </Button>
              </div>
              <SessionTranscriptTurns
                :items="items"
                :copied-idx="copiedIdx"
                :is-expanded="isExpanded"
                :find-active="findOpen && !!findQuery"
                @copy="copyMessage"
                @toggle-expand="toggleExpand"
                @branch="branchFrom"
              />
            </template>
          </div>
          <!-- jump to latest: only while scrolled up. A zero-height sticky rail, so showing it never
               changes the content height the follow check measures. -->
          <div v-if="!chatAtBottom && !tailLoading" class="sticky bottom-0 h-0">
            <div class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <!-- the lift lives on a wrapper: the Button owns its own surface -->
              <span class="pointer-events-auto flex rounded-md shadow-md">
                <Button
                  variant="secondary"
                  size="sm"
                  @click="scroller.scrollToLatest()"
                >
                  <ArrowDown />
                  {{ unseenTurns ? $t('sessions.newTurns') : $t('sessions.jumpToLatest') }}
                </Button>
              </span>
            </div>
          </div>
        </div>
      </template>

      <!-- chat-style input: messages the open session, or every checked one -->
      <SessionComposer
        v-if="composerTargets.length"
        class="shrink-0"
        :targets="composerTargets"
        @sent="onComposerSent"
      />
      <!-- ...and, where there can be no input, why -->
      <div v-else-if="readOnlySource" class="shrink-0 bg-background">
        <div
          class="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-3 text-xs text-muted-foreground"
        >
          <BookOpen class="size-3.5 shrink-0" />
          <span>{{ $t('sessions.readOnlySource', { source: sourceLabel(readOnlySource) }) }}</span>
        </div>
      </div>
    </section>

    <!-- the findings, redacted. There is no reveal control, and the daemon has no endpoint that
         could serve one: the transcript is already open one panel away, so revealing here would only
         add a second place credentials live. -->
    <!-- Bulk migrate confirmation: names the count and the destination, lists the chats, and makes
         the move a second deliberate click. -->
    <Dialog :open="bulkConfirm !== null" @update:open="(v) => { if (!v) bulkConfirm = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {{ $t('sessions.migrateConfirmTitle', { n: bulkConfirm?.sessions.length ?? 0, name: bulkConfirm?.target.name ?? '' }) }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('sessions.migrateConfirmBody', { name: bulkConfirm?.target.name ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">{{ $t('sessions.dialogRowHint') }}</p>
        <!-- Grouped by project, largest group first, so the SHAPE of the move is visible before the
             click: three Connections chats and ten AgentHydra ones read differently from "13". -->
        <ul class="scroll-slim max-h-56 space-y-2 overflow-y-auto text-xs">
          <li v-for="g in groupByProject(bulkConfirm?.sessions ?? [])" :key="g.project">
            <div class="mb-1 flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
              <span class="truncate">{{ g.project }}</span>
              <span class="shrink-0">{{ $t('sessions.groupCount', { n: g.sessions.length }) }}</span>
            </div>
            <ul class="space-y-1">
              <li v-for="s in g.sessions" :key="s.session_id">
                <button
                  type="button"
                  class="w-full truncate rounded border border-border px-2 py-1 text-start hover:bg-accent"
                  @click="openFromBulkDialog(s)"
                >
                  {{ s.title }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" @click="bulkConfirm = null">{{ $t('sessions.migrateConfirmCancel') }}</Button>
          <Button :disabled="migrating || !bulkConfirm?.sessions.length" @click="runBulkMigrate">
            {{ $t('sessions.migrateConfirmSubmit', { n: bulkConfirm?.sessions.length ?? 0 }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="secretsOpen">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <span class="flex items-center gap-1.5">
              {{ $t('sessions.secretsTitle') }}
              <InfoHint :text="$t('sessions.secretsCaveat')" />
            </span>
          </DialogTitle>
          <DialogDescription class="sr-only">{{ $t('sessions.secretsCaveat') }}</DialogDescription>
        </DialogHeader>
        <ul class="scroll-slim max-h-80 space-y-1 overflow-y-auto text-xs">
          <li
            v-for="(f, i) in secrets?.findings ?? []"
            :key="i"
            class="flex items-center gap-2 rounded border border-border px-2 py-1.5"
          >
            <Badge variant="outline" class="shrink-0">{{ f.kind }}</Badge>
            <span class="min-w-0 flex-1 truncate font-mono">{{ f.redacted }}</span>
            <span class="shrink-0 text-muted-foreground">
              {{ $t('sessions.secretsTurn', { n: f.turn + 1 }) }}
            </span>
          </li>
        </ul>
        <p v-if="secrets?.truncated" class="text-xs text-muted-foreground">
          {{ $t('sessions.secretsTruncated', { n: secrets.count }) }}
        </p>
      </DialogContent>
    </Dialog>
  </div>
</template>
