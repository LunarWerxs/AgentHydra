<script setup lang="ts">
import { safeTranscriptFilename } from '@agenthydra/server/filenames'
import {
  AlignJustify,
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
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
  Clock,
  Coins,
  Copy,
  Download,
  FileSymlink,
  FileText,
  FolderGit2,
  GitBranch,
  GitFork,
  Globe,
  Hourglass,
  KeyRound,
  Layers,
  Link,
  ListTodo,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
  Wrench,
  X,
} from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import {
  type ComponentPublicInstance,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import SessionComposer, { type ComposerTarget } from '@/components/SessionComposer.vue'
import StatusBadge from '@/components/StatusBadge.vue'
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
import { useData } from '@/composables/useData'
import { useInstances } from '@/composables/useInstances'
import { useShellWidth } from '@/composables/useShellWidth'
import { useShortcuts } from '@/composables/useShortcuts'
import { clampWidth, SIDEBAR_DEFAULT, useUiPrefs } from '@/composables/useUiPrefs'
import type {
  ArchivedScope,
  DispatchedScope,
  RateLimitScope,
  SessionEnding,
  SessionPeriod,
  SessionSearchResponse,
  SessionSearchResult,
  SessionSecretScan,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  SessionUsage,
  TailResult,
  TitleSource,
} from '@/lib/api'
import * as api from '@/lib/api'
import { highlightHtml } from '@/lib/find'
import {
  baseName,
  formatCompact,
  formatUsd,
  type SessionActivity,
  sessionActivity,
  shortId,
  timeAgo,
} from '@/lib/format'
import { displayName } from '@/lib/instance-appearance'
import { escapeHtml, looksLikeMarkdown, renderMarkdown } from '@/lib/markdown'
import { composeSessionPathClipboard } from '@/lib/session-clipboard'
import { groupByProject } from '@/lib/session-groups'
import { pendingSessionJump, takeSessionJump } from '@/lib/session-jump'
import { rangeBetween } from '@/lib/session-multiselect'
import { type SessionShape, type ShapeScope, sessionShape } from '@/lib/session-shape'
import { cn } from '@/lib/utils'
import IconTooltip from '@/shell/IconTooltip.vue'

const {
  sessions,
  sessionsLoading,
  refreshSessions,
  queue,
  sessionInstanceFilter,
  sessionArchivedScope,
  sessionPeriod,
  sessionSourceFilter,
  sessionDispatchedScope,
  sessionRateLimitScope,
  sessionShapeScope,
} = useData()
const { t } = useI18n()

// Named instances for the filter dropdown; "default"/"other" are fixed options. The folder
// name stays the stable filter key (sessions are tagged by it); displayName() is what we SHOW —
// in the dropdown and in each row's instance chip.
//
// Reads the shared useInstances singleton rather than fetching the list itself, because
// displayName() now prefers the ACCOUNT an instance is signed into, and only that composable
// resolves accounts. A private fetch would show the folder name here while the Instances tab
// showed the account name for the very same instance. `computed`, so the chips fill in on their
// own as each account resolves. A failed load just leaves the named entries out.
const { instances: desktopInstances, refreshInstances, open: openDesktopInstance } = useInstances()
const namedInstances = computed(() =>
  desktopInstances.value.map((i) => ({ name: i.name, label: displayName(i) })),
)
const instanceLabelFor = (folder: string) =>
  namedInstances.value.find((i) => i.name === folder)?.label ?? folder
// silent: this view has no instance-list spinner to drive, and the toolbar Refresh icon it would
// toggle belongs to a different view entirely.
onMounted(() => void refreshInstances({ silent: true }))
// Every scope is applied server-side, so any of them changing needs a refetch, not a re-filter.
watch(
  [
    sessionInstanceFilter,
    sessionArchivedScope,
    sessionPeriod,
    sessionDispatchedScope,
    sessionRateLimitScope,
  ],
  () => refreshSessions(),
)
watch(sessionSourceFilter, (source) => {
  // Desktop-instance metadata belongs to Claude sessions only. Clear a stale instance scope when
  // switching providers so "Codex" or "OpenCode" cannot appear empty for an invisible old filter.
  if (source !== 'all' && source !== 'claude' && sessionInstanceFilter.value) {
    sessionInstanceFilter.value = ''
    return
  }
  refreshSessions()
})

/** The ⋯ trigger reports "something is narrowing this list". Otherwise a filter set once and
 *  forgotten reads as an empty/short list with no visible cause, now that the controls are a
 *  menu rather than a row of lit-up buttons. */
const filtersActive = computed(
  () =>
    !!sessionInstanceFilter.value ||
    sessionArchivedScope.value !== 'include' ||
    sessionSourceFilter.value !== 'all' ||
    sessionDispatchedScope.value !== 'all' ||
    sessionRateLimitScope.value !== 'all' ||
    sessionShapeScope.value !== 'all' ||
    // Only a WIDENED window counts. 24h is the default, so flagging it would light the trigger up
    // permanently and the signal would stop meaning anything.
    sessionPeriod.value !== '24h',
)
const SOURCE_LABEL: Record<SessionSourceScope, string> = {
  all: 'sessions.sourceAll',
  claude: 'sessions.sourceClaude',
  codex: 'sessions.sourceCodex',
  opencode: 'sessions.sourceOpenCode',
  foreign: 'sessions.sourceOther',
}
const sourceFilterLabel = computed(() => t(SOURCE_LABEL[sessionSourceFilter.value]))
const RATE_LIMIT_LABEL: Record<RateLimitScope, string> = {
  all: 'sessions.rateLimitedAll',
  only: 'sessions.rateLimitedOnly',
  pending: 'sessions.rateLimitedPending',
}
const rateLimitScopeLabel = computed(() => t(RATE_LIMIT_LABEL[sessionRateLimitScope.value]))

/**
 * Why this row is called what it is called.
 *
 * A title has four possible origins and only one of them is a name a person chose, so a title
 * nobody recognises is otherwise a dead end — which is exactly what happened when threads started
 * showing up named "Watcher" and no account, instance or project was called that. The awkward case
 * is 'envelope': the first message arrived wrapped in a pseudo-tag carrying a name attribute, and
 * that name became the title, so the string was chosen by whatever wrote the wrapper (a scheduler,
 * a hook, a harness) and may match nothing the user has ever named.
 */
const TITLE_SOURCE_LABEL: Record<TitleSource, string> = {
  custom: 'sessions.titleFromCustom',
  ai: 'sessions.titleFromAi',
  store: 'sessions.titleFromStore',
  envelope: 'sessions.titleFromEnvelope',
  message: 'sessions.titleFromMessage',
  id: 'sessions.titleFromId',
}
const titleOriginOf = (s: SessionSummary) =>
  `${t('sessions.titleFrom')}: ${t(TITLE_SOURCE_LABEL[s.title_source], { tag: s.title_tag ?? '?' })}`
/** Only the surprising origin earns a marker on the row. Everything else is explicable on sight and
 *  a badge on every row would be noise that hides the one case worth noticing. */
const titleIsUnattributed = (s: SessionSummary) => s.title_source === 'envelope'
/** Only ever rendered on a still-stopped session, so there is one wording rather than two. */
const limitTooltipOf = (s: SessionSummary) =>
  s.limit_stop ? t('sessions.rateLimitedHint', { notice: s.limit_stop.notice }) : ''
const sourceLabel = (source: SessionSource) => t(SOURCE_LABEL[source])

/**
 * The badge text for one row.
 *
 * `source` names the READER, and the fourth one covers five different products, so a row from Grok
 * and a row from Zed would both read "Other". The tool name is what the user recognises, so it wins
 * wherever the session carries one.
 */
const TOOL_NAME: Record<string, string> = {
  'claude-code': 'Claude',
  openclaude: 'OpenClaude',
  cowork: 'Cowork',
  codex: 'Codex',
  traex: 'TraeX',
  opencode: 'OpenCode',
  kilo: 'Kilo',
  mimocode: 'MiMo',
  icodemate: 'IcodeMate',
  grok: 'Grok',
  kimi: 'Kimi',
  zed: 'Zed',
  copilot: 'Copilot CLI',
  'vscode-copilot': 'VS Code Copilot',
}
const rowSourceLabel = (s: { source: SessionSource; tool?: string }) =>
  (s.tool && TOOL_NAME[s.tool]) || sourceLabel(s.source)
const SOURCE_BADGE_CLASS: Record<SessionSource, string> = {
  claude: 'border-[#D97757]/40 bg-[#D97757]/10 text-[#B85D3D] dark:text-[#E9A287]',
  codex: 'border-[#10A37F]/40 bg-[#10A37F]/10 text-[#087D62] dark:text-[#65D4B3]',
  opencode: 'border-[#5B6EF5]/40 bg-[#5B6EF5]/10 text-[#4053D6] dark:text-[#9AA6FF]',
  // Neutral on purpose: five products share this reader, so a single hue would imply one identity.
  foreign: 'border-border bg-muted text-muted-foreground',
}
const sourceBadgeClass = (source: SessionSource) => SOURCE_BADGE_CLASS[source]
const instanceFilterLabel = computed(() => {
  const v = sessionInstanceFilter.value
  if (!v) return t('sessions.instanceAll')
  if (v === 'default') return t('sessions.instanceDefault')
  if (v === 'other') return t('sessions.instanceOther')
  return instanceLabelFor(v)
})
const ARCHIVED_LABEL: Record<ArchivedScope, string> = {
  hide: 'sessions.archivedHide',
  include: 'sessions.archivedInclude',
  only: 'sessions.archivedOnly',
}
const archivedScopeLabel = computed(() => t(ARCHIVED_LABEL[sessionArchivedScope.value]))
const PERIOD_LABEL: Record<SessionPeriod, string> = {
  '24h': 'sessions.period24h',
  '7d': 'sessions.period7d',
  '30d': 'sessions.period30d',
  all: 'sessions.periodAll',
}
const periodLabel = computed(() => t(PERIOD_LABEL[sessionPeriod.value]))
const DISPATCHED_LABEL: Record<DispatchedScope, string> = {
  all: 'sessions.dispatchedAll',
  queued: 'sessions.dispatchedQueued',
  manual: 'sessions.dispatchedManual',
}
const dispatchedScopeLabel = computed(() => t(DISPATCHED_LABEL[sessionDispatchedScope.value]))
const SHAPE_LABEL: Record<ShapeScope, string> = {
  all: 'sessions.shapeAll',
  quick: 'sessions.shapeQuick',
  standard: 'sessions.shapeStandard',
  deep: 'sessions.shapeDeep',
  marathon: 'sessions.shapeMarathon',
  automation: 'sessions.shapeAutomation',
}
const shapeScopeLabel = computed(() => t(SHAPE_LABEL[sessionShapeScope.value]))
const shapeLabel = (shape: SessionShape) => t(SHAPE_LABEL[shape])
/** "Marathon" is a size, and nothing on the row said so. Spell it out on hover. */
/**
 * The "part 1 of 2" chip, carrying WHY there is more than one.
 *
 * The reason is on the row rather than only in the tooltip because the question this answers —
 * "why is this conversation here twice?" — is asked by looking, not by hovering. A part that was
 * superseded names what ended it; the newest part has nothing to explain, so it stays short.
 */
const ENDING_LABEL: Record<SessionEnding, string> = {
  interrupted: 'sessions.endedInterrupted',
  'usage-limit': 'sessions.endedUsageLimit',
  overload: 'sessions.endedOverload',
  refused: 'sessions.endedRefused',
  error: 'sessions.endedError',
  complete: 'sessions.endedComplete',
}
const isLatestCopy = (s: SessionSummary) => s.copy_index >= s.copy_count
const copyChipOf = (s: SessionSummary) => {
  const label = t('sessions.copyOf', { i: s.copy_index, n: s.copy_count })
  if (isLatestCopy(s) || !s.ended_because) return label
  return `${label} · ${t(ENDING_LABEL[s.ended_because])}`
}
const copyWhyOf = (s: SessionSummary) =>
  isLatestCopy(s) || !s.ended_because
    ? t('sessions.copyLatest', { i: s.copy_index, n: s.copy_count })
    : t('sessions.copyWhy', {
        i: s.copy_index,
        n: s.copy_count,
        why: t(ENDING_LABEL[s.ended_because]),
      })

const shapeTitleOf = (s: SessionSummary) =>
  `${t('sessions.shape')}: ${shapeLabel(sessionShape(s))} — ${t('sessions.shapeHint')}`

/** Working / idle / stale, from the same timestamp the list is already sorted by. A session we are
 *  actively running is 'working' regardless of the clock: the queue knows, so it does not have to
 *  be inferred from a file write that may be seconds away. */
// Reads the clock at render time, exactly as timeAgo() beside it does: the list refetches every 12
// seconds, so the dot and the "3m ago" it sits next to always move together.
const activityOf = (s: SessionSummary): SessionActivity =>
  s.queue_status === 'running' ? 'working' : sessionActivity(s.last_activity_at)
const ACTIVITY_CLASS: Record<SessionActivity, string> = {
  working: 'bg-success',
  idle: 'bg-warning',
  stale: 'bg-muted-foreground/40',
}
const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  working: 'sessions.activityWorking',
  idle: 'sessions.activityIdle',
  stale: 'sessions.activityStale',
}

// --- "done" marks: seen it / handled it, without hiding it ---------------------
// Persisted server-side (sqlite) rather than in localStorage: these are the user's own judgements
// about real work, so they outlive a cleared browser store or a different webview profile.
// Deliberately NOT a filter: a done row stays exactly where it was, just quieter.
const doneCount = computed(() => sessions.value.filter((s) => s.done).length)

async function setDone(s: SessionSummary, done: boolean) {
  const prev = s.done
  s.done = done // optimistic: the row marks instantly, the write is a formality
  try {
    await api.setSessionDone(s.session_id, s.source, done)
  } catch {
    s.done = prev
    toast.error(t('sessions.markDoneFailed'))
  }
}
const toggleDone = (s: SessionSummary) => setDone(s, !s.done)

async function clearDoneMarks() {
  await Promise.all(sessions.value.filter((s) => s.done).map((s) => setDone(s, false)))
}

async function openFile(session: SessionSummary) {
  try {
    const r = await api.openSessionFile(session.session_id, session.source)
    if (!r.ok) toast.error(t('sessions.openFileFailed'))
  } catch {
    toast.error(t('sessions.openFileFailed'))
  }
}

// Puts the FILE on the clipboard, not its text — which only the daemon can do (see api.copySessionFile).
// It reports the name it staged, because that name (the session title, not the uuid) is the whole
// point and is worth confirming before the user pastes somewhere.
const copyingFile = ref(false)
async function copyFile(session: SessionSummary) {
  copyingFile.value = true
  try {
    const r = await api.copySessionFile(session.session_id, session.source)
    if (r.ok) toast.success(t('sessions.copyFileDone', { name: r.filename ?? '' }))
    else if (r.reason === 'unsupported') toast.error(t('sessions.copyFileUnsupported'))
    else toast.error(t('sessions.copyFileFailed'))
  } catch {
    toast.error(t('sessions.copyFileFailed'))
  } finally {
    copyingFile.value = false
  }
}

async function copyFileLocation(session: SessionSummary) {
  try {
    const { path } = await api.getSessionFileLocation(session.session_id, session.source)
    const text = composeSessionPathClipboard({
      path,
      title: session.title,
      includeName: copyPathIncludeName.value,
      includePrompt: copyPathIncludePrompt.value,
      prompt: copyPathPrompt.value,
    })
    await navigator.clipboard.writeText(text)
    // Says WHAT was copied rather than that something was: the clipboard can now hold three lines
    // where it used to hold one, and a paste into a terminal is a surprise worth pre-empting.
    toast.success(
      text === path ? t('sessions.copyFileLocationDone') : t('sessions.copyFileLocationDoneRich'),
    )
  } catch {
    toast.error(t('sessions.copyFileLocationFailed'))
  }
}

const search = ref('')
const selectedId = ref<string | null>(null)
const selectedSource = ref<SessionSource | null>(null)
const tail = ref<TailResult | null>(null)
const tailLoading = ref(false)
// Verbose mode, the sidebar width and the body-search case flag are persisted AND mirrored through
// the daemon, so they live in composables/useUiPrefs.ts: this view unmounts whenever you switch
// tabs, and a mirrored ref owned by a component that unmounts stops being the mirrored one.
const {
  showTools,
  showThinking,
  humanOnly,
  compactTranscript,
  sidebarWidth,
  advancedCaseSensitive,
  copyPathIncludeName,
  copyPathIncludePrompt,
  copyPathPrompt,
} = useUiPrefs()

// --- sidebar: persisted drag-resize + animated collapse, auto-collapsing when narrow ---
const RAIL_WIDTH = 44

const isWide = useMediaQuery('(min-width: 1024px)')
const collapsed = ref(!isWide.value)
watch(isWide, (wide) => {
  collapsed.value = !wide
})

const resizing = ref(false)
function startResize(e: PointerEvent) {
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  resizing.value = true
  const onMove = (ev: PointerEvent) => {
    sidebarWidth.value = clampWidth(startWidth + ev.clientX - startX)
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// Never wider than the viewport allows (a 340px sidebar on a 390px phone would
// crush the transcript); the width transition animates the collapse toggle but is
// suspended during a drag so resizing tracks the pointer 1:1.
const asideStyle = computed(() => ({
  width: collapsed.value ? `${RAIL_WIDTH}px` : `min(${sidebarWidth.value}px, calc(100vw - 56px))`,
}))

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const shape = sessionShapeScope.value
  let rows = sessions.value
  // Applied in the browser, unlike the scopes the daemon owns, so it narrows the window that was
  // fetched rather than reaching further back. Said plainly in the menu, because "no marathons in
  // the last 24 hours" and "no marathons" are different answers.
  if (shape !== 'all') rows = rows.filter((s) => sessionShape(s) === shape)
  if (!q) return rows
  return rows.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.session_id.includes(q),
  )
})

/** An empty list under a bounded window is ambiguous: "nothing here" or "nothing here LATELY"?
 *  Say which, so a quiet day doesn't read as a broken list. */
const emptyBecauseOfPeriod = computed(
  () => sessionPeriod.value !== 'all' && !search.value.trim() && sessions.value.length === 0,
)

// --- advanced (body) search: server-side, streams every transcript's raw content ---------
// Deliberately independent of `filtered` above (client-side, metadata-only, always fast);
// this is a slower opt-in path that only runs when the user explicitly submits it.
const advancedOpen = ref(false)
const advancedQuery = ref('')
const advancedRegex = ref(false)
const bodySearching = ref(false)
const bodySearchActive = ref(false)
const bodySearchQueryUsed = ref('')
const bodyResults = ref<SessionSearchResult[]>([])
// Kept beside the results, because "nothing matched" and "the server gave up after 7 seconds" look
// identical in a list of zero rows, and only one of them means the text isn't there.
const bodySearchResponse = ref<SessionSearchResponse | null>(null)

async function runBodySearch(opts: { everything?: boolean } = {}) {
  const q = advancedQuery.value.trim() || bodySearchQueryUsed.value
  if (!q) return
  bodySearching.value = true
  try {
    const r = await api.searchSessionBodies(q, {
      regex: advancedRegex.value,
      caseSensitive: advancedCaseSensitive.value,
      instance: sessionInstanceFilter.value || undefined,
      source: sessionSourceFilter.value === 'all' ? undefined : sessionSourceFilter.value,
      everything: opts.everything,
    })
    bodyResults.value = r.results
    bodySearchResponse.value = r
    bodySearchQueryUsed.value = q
    bodySearchActive.value = true
    advancedOpen.value = false
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    toast.error(msg || t('sessions.searchFailed'))
  } finally {
    bodySearching.value = false
  }
}

/**
 * The one line that says what was actually searched.
 *
 * There are three honest answers and they are not interchangeable: the index answered completely
 * but only over conversation; the scan ran out of time; or the hit list was capped. Saying nothing
 * would let any of the three read as "that text is nowhere on this machine".
 */
const bodySearchNotice = computed(() => {
  const r = bodySearchResponse.value
  if (!r) return null
  if (r.searched === 'index') return t('sessions.searchedConversation')
  if (r.budgetExhausted)
    return t('sessions.searchBudgetExhausted', {
      seconds: Math.round(r.budgetMs / 1000),
      searched: r.filesSearched,
      total: r.filesTotal,
    })
  if (r.limitReached) return t('sessions.searchLimitReached', { n: r.results.length })
  return null
})

/** Offer the exhaustive path exactly when the answer we gave did not cover everything. */
const canSearchEverything = computed(() => {
  const r = bodySearchResponse.value
  return !!r && (r.conversationOnly || r.budgetExhausted)
})

function exitBodySearch() {
  bodySearchActive.value = false
  bodyResults.value = []
  bodySearchResponse.value = null
}

/** Jump from a body-search hit to the full transcript, same as clicking it in the plain list. */
async function selectFromBodyResult(r: SessionSearchResult) {
  const s = sessions.value.find((x) => x.session_id === r.session_id && x.source === r.source)
  if (s) {
    exitBodySearch()
    select(s)
    return
  }
  // Not in the currently-loaded metadata window (e.g. older than the 200-session cap); still
  // open the transcript directly by id so the hit isn't a dead end.
  exitBodySearch()
  selectedId.value = r.session_id
  selectedSource.value = r.source
  selected.value = null
  void loadTail()
  try {
    const summary = await api.getSession(r.session_id, r.source)
    if (selectedId.value === r.session_id && selectedSource.value === r.source)
      selected.value = summary
  } catch {
    toast.error(t('sessions.searchFailed'))
  }
}

// Last-known summary, not a bare find(): an actively-written session can drop out of
// one 12s scan cycle (partial JSONL mid-write), and a null flash would blank the
// transcript and yank the shell width. Keep showing what we knew until it reappears.
const selected = ref<SessionSummary | null>(null)
watch(
  [sessions, selectedId, selectedSource],
  () => {
    if (!selectedId.value) {
      selected.value = null
      return
    }
    const s = sessions.value.find(
      (x) =>
        x.session_id === selectedId.value &&
        (!selectedSource.value || x.source === selectedSource.value),
    )
    if (s) selected.value = s
  },
  { immediate: true },
)

// an open transcript benefits from room; widen the whole shell while one is selected
const { wide: shellWide } = useShellWidth()
watch(
  () => !!selected.value,
  (hasSelection) => {
    shellWide.value = hasSelection
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  shellWide.value = false
})

// --- transcript: long-output capping + per-message copy ---
const LONG_CHARS = 1000
const LONG_LINES = 16
const isLong = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES

/**
 * Every turn as HTML, ONCE per tail load.
 *
 * Both branches escape the text before anything else looks at it, so nothing below can carry a tag
 * the transcript wrote. `pre` records which branch ran, because the two want different whitespace
 * handling: markdown owns its own layout, plain prose must keep its line breaks.
 *
 * Split from the find pass below so that typing in the find bar re-highlights without re-parsing
 * every message's markdown on each keystroke.
 */
const rendered = computed(() =>
  (tail.value?.events ?? []).map((ev) => {
    const md = ev.kind === 'text' && looksLikeMarkdown(ev.text) ? renderMarkdown(ev.text) : null
    return { ...ev, long: isLong(ev.text), html: md ?? escapeHtml(ev.text), pre: md === null }
  }),
)

// --- find within the open session (client-side; the loaded window, no server round-trip) --------
const findOpen = ref(false)
const findQuery = ref('')
const findIndex = ref(0)
// A template ref on <Input> yields the COMPONENT, not the element — the kit's Input is a
// single-root wrapper, so the <input> is reached through $el.
const findInput = ref<ComponentPublicInstance | null>(null)
/** The sidebar's own filter box, so Ctrl/Cmd+K can put the caret in it. */
const searchInput = ref<ComponentPublicInstance | null>(null)
function focusFindInput() {
  const el = findInput.value?.$el
  if (el instanceof HTMLInputElement) el.focus()
}

/** The turns as rendered, with matches wrapped. `hits` is per message; `findTotal` sums them. */
const events = computed(() => {
  const q = findOpen.value ? findQuery.value : ''
  if (!q) return rendered.value.map((ev) => ({ ...ev, hits: 0 }))
  let seen = 0
  return rendered.value.map((ev) => {
    const r = highlightHtml(ev.html, q, seen, findIndex.value)
    seen += r.count
    return { ...ev, html: r.html, hits: r.count }
  })
})

const findTotal = computed(() => events.value.reduce((n, ev) => n + ev.hits, 0))

/** Clamp into range and scroll the current hit into view. Wraps at both ends, like every find bar. */
async function goToMatch(next: number) {
  const total = findTotal.value
  if (total === 0) return
  findIndex.value = ((next % total) + total) % total
  await nextTick()
  chatEl.value
    ?.querySelector(`[data-find="${findIndex.value}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function openFind() {
  findOpen.value = true
  void nextTick(focusFindInput)
}

function closeFind() {
  findOpen.value = false
  findQuery.value = ''
  findIndex.value = 0
}

// A new query starts from the first hit rather than wherever the last one left off.
watch(findQuery, () => {
  findIndex.value = 0
  void nextTick(() => void goToMatch(0))
})
// Closing the session closes the bar with it; a match count against a transcript you can no longer
// see is just a wrong number on screen.
watch(selectedId, () => {
  closeFind()
  secretsOpen.value = false
})

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

const expandedMsgs = ref<Set<number>>(new Set())
const isExpanded = (i: number) => expandedMsgs.value.has(i)
function toggleExpand(i: number) {
  const next = new Set(expandedMsgs.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  expandedMsgs.value = next
}

const copiedIdx = ref<number | null>(null)
let copiedTimer: number | undefined
function copyMessage(i: number, text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
  copiedIdx.value = i
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedIdx.value = null
  }, 1200)
}

const chatEl = ref<HTMLElement | null>(null)

// How many /tail reads are outstanding. The poll below fires every 4 s whether or not the last one
// came back, and on a big store a read can take longer than that — so without this the polls stack
// into a queue of identical requests, each one delaying the next, and the reader watches a spinner
// that is waiting on answers nobody will look at. A skipped silent tick loses nothing: another is 4 s
// behind it asking the same question. Only the SILENT path yields; a click is intent and always runs.
let tailInFlight = 0

async function loadTail(opts: { silent?: boolean } = {}) {
  const id = selectedId.value
  const source = selectedSource.value
  if (!id || !source) return
  if (opts.silent && tailInFlight > 0) return
  // measured BEFORE the fetch: whether the reader was already at the conversation's end
  const el = chatEl.value
  const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
  if (!opts.silent) tailLoading.value = true
  tailInFlight++
  try {
    const r = await api.getTail(id, source, {
      limit: 40,
      textOnly: !showTools.value,
      thinking: showThinking.value,
      humanOnly: humanOnly.value,
    })
    if (selectedId.value !== id || selectedSource.value !== source) return
    tail.value = r
  } catch {
    // Same staleness test the success path makes. A read that fails AFTER the reader moved on
    // belongs to a conversation nobody is looking at any more, and blanking on its behalf would
    // clear the chat they ARE looking at.
    if (!opts.silent && selectedId.value === id && selectedSource.value === source)
      tail.value = null
  } finally {
    tailInFlight--
    if (!opts.silent) tailLoading.value = false
  }
  if (selectedId.value !== id || selectedSource.value !== source) return
  if (!opts.silent) expandedMsgs.value = new Set()
  // chat convention: land at the bottom; silent refreshes only stick if already there
  await nextTick()
  if (!opts.silent || nearBottom) chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight })
}

function select(s: SessionSummary) {
  selectedId.value = s.session_id
  selectedSource.value = s.source
  loadTail()
}

// --- what this session spent ------------------------------------------------
// A separate, cheap request rather than a field on the tail: the tail is a bounded byte-window on
// the END of the transcript, and a session's cost is the whole file. The daemon streams it and
// caches on (mtime, size), so re-opening a finished session costs nothing.
const usage = ref<SessionUsage | null>(null)

async function loadUsage() {
  const id = selectedId.value
  const source = selectedSource.value
  if (!id || !source) {
    usage.value = null
    return
  }
  try {
    const u = await api.getSessionUsage(id, source)
    if (selectedId.value !== id || selectedSource.value !== source) return // selection moved on
    usage.value = u
  } catch {
    usage.value = null // a missing figure is silent; a wrong one would not be
  }
}
// Watching the selection rather than calling from select() catches every way a session gets
// opened — the list, a body-search hit, and the restored selection on mount.
watch(
  [selectedId, selectedSource],
  () => {
    usage.value = null
    void loadUsage()
  },
  { immediate: true },
)

/** The header chip: "1.2M tokens · $4.21". A trailing "+" means some model in the session has no
 *  published price, so the figure is a floor. */
const usageSummary = computed(() => {
  const u = usage.value
  if (u?.status !== 'ok' || u.tokens.turns === 0) return null
  const tokens = t('sessions.usageTokens', { n: formatCompact(u.tokens.total) })
  if (u.costUsd === null) return tokens
  const cost = formatUsd(u.costUsd)
  return `${tokens} · ${u.unpricedModels.length ? `${cost}+` : cost}`
})

const usageDetail = computed(() => {
  const u = usage.value
  if (u?.status !== 'ok') return undefined
  const parts = [
    t('sessions.usageBreakdown', {
      input: formatCompact(u.tokens.input),
      output: formatCompact(u.tokens.output),
      cacheRead: formatCompact(u.tokens.cacheRead),
      cacheWrite: formatCompact(u.tokens.cacheCreation),
      turns: u.tokens.turns,
    }),
  ]
  if (u.unpricedModels.length) {
    const models = u.unpricedModels.join(', ')
    parts.push(
      u.costUsd === null
        ? t('sessions.usageNoPrice', { models })
        : t('sessions.usageLowerBound', { models }),
    )
  }
  parts.push(t('sessions.usageListPrice', { date: u.pricesAsOf }))
  return parts.join(' ')
})

// --- migrate to another account ----------------------------------------------
// The flyout lists EVERY desktop instance, in two groups. A running one is a legal landing spot as
// it stands. A closed one is shown too - hiding them made "why isn't mine here" a daily question -
// but the server refuses to import into a closed instance, because the import spawn would BOOT it
// and the rule is that nothing opens an account on its own. So a closed target reads "start it and
// move there": a deliberate click opens the instance the ordinary way, we wait for it to come up,
// and only then migrate. Loaded lazily when a menu opens; the session's own instance is disabled
// rather than hidden.
interface MigrateTarget {
  ref: string
  dir: string
  name: string
  account: string | null
  isCurrent: boolean
  isRunning: boolean
}
const migrateTargets = ref<MigrateTarget[]>([])
const runningTargets = computed(() => migrateTargets.value.filter((x) => x.isRunning))
const closedTargets = computed(() => migrateTargets.value.filter((x) => !x.isRunning))
const migrating = ref(false)

/** `s` is the session the menu is FOR, so its own instance can be marked; null for a bulk menu,
 *  where the checked sessions may span several instances and none is "current". */
async function loadMigrateTargets(s: SessionSummary | null) {
  try {
    const [instances, cache] = await Promise.all([api.listInstances(), api.getUsageCache()])
    migrateTargets.value = instances.map((i) => {
      const ref = `desktop:${i.dir}`
      const snap = cache.cache[ref.toLowerCase()] ?? cache.cache[ref]
      return {
        ref,
        dir: i.dir,
        // The name the Instances table shows (label, else account name, else folder), not the
        // folder name a row's label happened to fall through to.
        name: displayName(i),
        account: snap?.account ?? null,
        isCurrent: s?.instance != null && s.instance === i.name,
        isRunning: i.isRunning,
      }
    })
  } catch {
    migrateTargets.value = []
  }
}

/** A closed target is opened first and waited for. The wait polls the instance list rather than
 *  trusting the open call's ok: that only says the spawn happened. The extra beat after the
 *  process appears is for Electron to take its single-instance lock, which is what the import
 *  spawn aims at; too early and the import boots a SECOND copy instead of landing in this one. */
async function ensureRunning(target: MigrateTarget): Promise<boolean> {
  if (target.isRunning) return true
  const id = `start-${target.ref}`
  toast.loading(t('sessions.migrateStarting', { name: target.name }), { id })
  const opened = await openDesktopInstance(target.dir)
  if (!opened?.ok) {
    toast.error(t('sessions.migrateStartFailed', { name: target.name }), { id })
    return false
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const list = await api.listInstances().catch(() => [] as api.CMInstance[])
    if (list.find((i) => i.dir === target.dir)?.isRunning) {
      await new Promise((r) => setTimeout(r, 3000))
      toast.dismiss(id)
      return true
    }
  }
  toast.error(t('sessions.migrateStartFailed', { name: target.name }), { id })
  return false
}

async function migrateTo(s: SessionSummary, target: MigrateTarget) {
  if (!(await ensureRunning(target))) return
  migrating.value = true
  try {
    // The row's title IS the current title (same listing the server reads), restated as required.
    const r = await api.migrateSession(s.session_id, target.ref, { confirmTitle: s.title })
    if (r.ok) toast.success(t('sessions.migrateStarted', { name: target.name }))
    else toast.error(r.error ?? t('sessions.migrateFailed'))
  } catch {
    toast.error(t('sessions.migrateFailed'))
  } finally {
    migrating.value = false
  }
}

// --- reopen in a terminal ----------------------------------------------------
// The command comes back whether or not the terminal opened, so a machine we cannot open a window
// on still gets something usable rather than a failure toast and nothing else.
const resuming = ref(false)

async function resumeInTerminal(s: SessionSummary) {
  resuming.value = true
  try {
    const r = await api.resumeSessionInTerminal(s.session_id, s.source)
    if (r.ok) {
      toast.success(t('sessions.resumeOpened'))
      return
    }
    await navigator.clipboard?.writeText(r.command).catch(() => {})
    toast.info(
      r.reason === 'source-unsupported'
        ? t('sessions.resumeUnsupported')
        : t('sessions.resumeCopied'),
      { description: r.command },
    )
  } catch {
    toast.error(t('sessions.resumeFailed'))
  } finally {
    resuming.value = false
  }
}

// --- credentials this session printed ----------------------------------------
// Same shape as the cost readout above: one cheap request per opened session, streamed server-side,
// never stored. The result is ALWAYS redacted — the daemon has no unredacted form of it, on purpose
// (server/src/session-export.ts).
const secrets = ref<SessionSecretScan | null>(null)
const secretsOpen = ref(false)

/** Deliberately the same wording the export and the context pack use: a guardrail, not a
 *  guarantee. Overstating it is how a scan like this does harm. */
const secretsDetail = computed(() =>
  secrets.value ? t('sessions.secretsHint', { n: secrets.value.count }) : undefined,
)

async function loadSecrets() {
  const id = selectedId.value
  const source = selectedSource.value
  if (!id || !source) {
    secrets.value = null
    return
  }
  try {
    const r = await api.getSessionSecrets(id, source)
    if (selectedId.value !== id || selectedSource.value !== source) return
    secrets.value = r
  } catch {
    secrets.value = null
  }
}
watch(
  [selectedId, selectedSource],
  () => {
    secrets.value = null
    void loadSecrets()
  },
  { immediate: true },
)

// The three display controls the daemon applies (compact is purely visual, so it is not here).
watch([showTools, showThinking, humanOnly], () => loadTail())

/** Whether the transcript is showing anything other than its default. Drives the pressed state on
 *  the controls button, so "why am I not seeing tool calls" is answerable at a glance. */
const displayFiltered = computed(
  () => showTools.value || showThinking.value || humanOnly.value || compactTranscript.value,
)

// --- live transcript: follow the selected session's queue run -----------------
// A run starting or finishing means the CLI just appended to the transcript on
// disk; while one is active, poll so the reply streams into view.
const runningRunId = computed(
  () =>
    (selectedSource.value === 'claude'
      ? queue.value.find((q) => q.session_id === selectedId.value && q.status === 'running')?.id
      : null) ?? null,
)
let tailPollTimer: number | undefined
watch(runningRunId, (id, oldId) => {
  window.clearInterval(tailPollTimer)
  if (id) tailPollTimer = window.setInterval(() => loadTail({ silent: true }), 4000)
  if (!!id !== !!oldId && selectedId.value) {
    loadTail({ silent: true })
    // Cost moves only when the CLI writes turns, so refresh on the run's edges rather than on the
    // 4-second tail poll — re-streaming a large transcript every tick to watch a number tick up is
    // not worth it.
    void loadUsage()
  }
})
onBeforeUnmount(() => window.clearInterval(tailPollTimer))

// --- multi-select: pick several sessions, message them all at once - or move them ---------------
// Two ways in: the Select switch in the toolbar, or a Ctrl/Cmd-click or Shift-click straight on a
// row, which flips select mode on by itself so the modifier means what it means everywhere else.
// Right-click one of the checked rows and the menu leads with the bulk actions.
const selectMode = ref(false)
const checkedIds = ref<Set<string>>(new Set())
const sessionKey = (s: Pick<SessionSummary, 'source' | 'session_id'>) =>
  `${s.source}:${s.session_id}`
const isChecked = (s: SessionSummary) => checkedIds.value.has(sessionKey(s))
// The row a Shift-range extends FROM: the last row deliberately clicked, or the open transcript's
// row when the very first modifier click is a Shift-click, which is what a keyboard user expects.
let rangeAnchor: string | null = null
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) {
    checkedIds.value = new Set()
    rangeAnchor = null
  }
}
function toggleChecked(s: SessionSummary) {
  if (s.source !== 'claude') return
  const next = new Set(checkedIds.value)
  const key = sessionKey(s)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  checkedIds.value = next
  rangeAnchor = key
}
function checkAllFiltered() {
  checkedIds.value = new Set(filtered.value.filter((s) => s.source === 'claude').map(sessionKey))
}
function rowClick(s: SessionSummary, ev?: MouseEvent) {
  const modifier = !!ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)
  if (modifier && s.source === 'claude') {
    if (!selectMode.value) {
      selectMode.value = true
      if (ev.shiftKey && selectedId.value && selectedSource.value)
        rangeAnchor = `${selectedSource.value}:${selectedId.value}`
    }
    if (ev.shiftKey && rangeAnchor) {
      const keys = filtered.value.filter((x) => x.source === 'claude').map(sessionKey)
      const next = new Set(checkedIds.value)
      for (const k of rangeBetween(keys, rangeAnchor, sessionKey(s))) next.add(k)
      checkedIds.value = next
      return // the anchor stays put, so a second Shift-click re-ranges from the same row
    }
    toggleChecked(s)
    return
  }
  if (selectMode.value) toggleChecked(s)
  else select(s)
}
const checkedSessions = computed(() => filtered.value.filter((s) => isChecked(s)))
const bulkCount = computed(() => checkedIds.value.size)

// --- jump to ONE session, asked from a dialog here or from another view ---------------------------
// "Filter to exactly that chat and open it" (owner ask, 2026-09-03): the search box takes the
// session id, which the list filter matches on, so the list shows that one row; select mode is
// left, because in select mode the pane shows the composer rather than the transcript. A chat not
// in the fetched window (the move dialogs list everything, the list defaults to 24 hours) widens
// the period to everything and selects the row the moment the refetch carries it.
function jumpToSession(s: Pick<SessionSummary, 'session_id' | 'source'>) {
  if (selectMode.value) toggleSelectMode()
  search.value = s.session_id
  const hit = sessions.value.find((x) => x.session_id === s.session_id && x.source === s.source)
  if (hit) {
    select(hit)
    return
  }
  if (sessionPeriod.value !== 'all') sessionPeriod.value = 'all'
  const stop = watch(sessions, (list) => {
    const found = list.find((x) => x.session_id === s.session_id && x.source === s.source)
    if (!found) return
    select(found)
    stop()
  })
  // A chat that never arrives (deleted since, or filtered by a scope the search cannot override)
  // must not leave a watcher running for the life of the view.
  window.setTimeout(stop, 20_000)
}
function consumeSessionJump() {
  const j = takeSessionJump()
  if (j) jumpToSession(j)
}
onMounted(consumeSessionJump)
watch(pendingSessionJump, (j) => {
  if (j) consumeSessionJump()
})
function openFromBulkDialog(s: SessionSummary) {
  bulkConfirm.value = null
  jumpToSession(s)
}

// --- bulk actions on the checked rows ----------------------------------------------------------
function copyCheckedIds() {
  copy(checkedSessions.value.map((s) => s.session_id).join('\n'))
}
// Confirm before a bulk move: it stops live runs and archives rows across several accounts, and
// "I right-clicked the wrong one" is not a mistake this should let through in one click.
const bulkConfirm = ref<{ target: MigrateTarget; sessions: SessionSummary[] } | null>(null)
function askBulkMigrate(target: MigrateTarget) {
  // Done-marked rows are already handed off or migrated; the server refuses them as superseded,
  // so leaving them in would only turn one confirmation into a column of error toasts.
  const sessions = checkedSessions.value.filter((s) => s.source === 'claude' && !s.done)
  bulkConfirm.value = { target, sessions }
}
async function runBulkMigrate() {
  const job = bulkConfirm.value
  if (!job) return
  bulkConfirm.value = null
  if (!(await ensureRunning(job.target))) return
  migrating.value = true
  const id = `bulk-migrate-${job.target.ref}`
  let ok = 0
  const failed: string[] = []
  try {
    // One at a time on purpose: each migrate may stop a live process and wait for it, and the
    // desktop app takes imports serially anyway. Parallel calls would only race its import lock.
    for (const [i, s] of job.sessions.entries()) {
      toast.loading(t('sessions.migrateBulkProgress', { done: i + 1, n: job.sessions.length }), {
        id,
      })
      try {
        const r = await api.migrateSession(s.session_id, job.target.ref, { confirmTitle: s.title })
        if (r.ok) ok++
        else failed.push(`${s.title}: ${r.error ?? 'failed'}`)
      } catch (e) {
        failed.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    migrating.value = false
  }
  if (failed.length)
    console.warn('[agenthydra] bulk migrate: some chats could not be moved', failed)
  const summary = t('sessions.migrateBulkDone', {
    ok,
    n: job.sessions.length,
    name: job.target.name,
  })
  // Say WHY, not "see the console": the first refusal's own words, and an error rather than a
  // warning when nothing moved at all (sixteen 400s once read as a warning with a zero in it).
  if (failed.length)
    (ok === 0 ? toast.error : toast.warning)(
      `${summary} ${t('sessions.migrateBulkSomeFailed', { failed: failed.length })} ${failed[0] ?? ''}`,
      {
        id,
      },
    )
  else toast.success(summary, { id })
  checkedIds.value = new Set()
}

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

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- sidebar: session list in its own scroll column; collapses to a slim rail with an
         animated width morph (the toggle button rides the sliding right edge) -->
    <!-- bg-sidebar, not transparent: the list is the recessed ground of the two-pane split. Without
         its own surface every region painted --background and the whole app read as one flat sheet,
         separated only by the hairline border. -->
    <aside
      class="relative min-h-0 shrink-0 overflow-hidden border-r border-border bg-sidebar"
      :class="resizing ? '' : 'transition-[width] duration-300 ease-in-out'"
      :style="asideStyle"
    >
      <IconTooltip :label="collapsed ? $t('sessions.expandSidebar') : $t('sessions.collapseSidebar')">
        <Button
          variant="ghost"
          size="icon"
          class="absolute right-2 top-3 z-10"
          @click="collapsed = !collapsed"
        >
          <PanelLeftOpen v-if="collapsed" />
          <PanelLeftClose v-else />
        </Button>
      </IconTooltip>

      <!-- expanded content keeps its full width while animating so it clips, not reflows -->
      <div
        class="flex h-full min-h-0 flex-col transition-opacity duration-200"
        :class="collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'"
        :style="{ width: `min(${sidebarWidth}px, calc(100vw - 56px))` }"
      >
        <div class="flex shrink-0 items-center gap-2 p-3 pr-11">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="searchInput"
              v-model="search"
              :placeholder="$t('sessions.searchPlaceholder')"
              class="pl-8 pr-8"
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
                  <PopoverContent align="end" class="w-80 space-y-3 p-3">
                    <p class="text-xs font-semibold">{{ $t('sessions.advancedSearchTitle') }}</p>
                    <div class="space-y-1.5">
                      <label class="text-xs font-medium text-muted-foreground">
                        {{ $t('sessions.advancedSearchQueryLabel') }}
                      </label>
                      <Input
                        v-model="advancedQuery"
                        :placeholder="$t('sessions.advancedSearchQueryPlaceholder')"
                        class="font-mono text-xs"
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
                <DropdownMenuContent align="end" class="max-w-56">
                  <DropdownMenuItem @select="refreshSessions">
                    <RefreshCw :class="sessionsLoading ? 'animate-spin' : ''" />
                    {{ $t('sessions.refresh') }}
                  </DropdownMenuItem>

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

                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <MessagesSquare />
                      {{ $t('sessions.filterSource') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ sourceFilterLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionSourceFilter">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.sourceAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="claude">{{ $t('sessions.sourceClaude') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="codex">{{ $t('sessions.sourceCodex') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="opencode">{{ $t('sessions.sourceOpenCode') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuSub
                    :disabled="sessionSourceFilter === 'codex' || sessionSourceFilter === 'opencode'"
                  >
                    <DropdownMenuSubTrigger>
                      <Boxes />
                      {{ $t('sessions.filterInstance') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ instanceFilterLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-80">
                      <DropdownMenuRadioGroup v-model="sessionInstanceFilter">
                        <DropdownMenuRadioItem value="">{{ $t('sessions.instanceAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="default">{{ $t('sessions.instanceDefault') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem v-for="i in namedInstances" :key="i.name" :value="i.name">{{ i.label }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="other">{{ $t('sessions.instanceOther') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- work we queued vs work you drove by hand. Known exactly rather than inferred:
                       every dispatch names the session id on the command line, so a queue row for
                       that id IS the fact. Never applied on our own initiative — 'all' is the
                       default and stays it. -->
                  <DropdownMenuSub :disabled="sessionSourceFilter === 'codex' || sessionSourceFilter === 'opencode'">
                    <DropdownMenuSubTrigger>
                      <ListTodo />
                      {{ $t('sessions.dispatched') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ dispatchedScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionDispatchedScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.dispatchedAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="queued">{{ $t('sessions.dispatchedQueued') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="manual">{{ $t('sessions.dispatchedManual') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- sessions a usage wall cut off. Server-side like the scopes above it, but
                       the verdict comes from the transcript parse rather than the mtime index, so
                       the first use after an upgrade is slow while the scan cache refills. -->
                  <DropdownMenuSub :disabled="sessionSourceFilter === 'codex' || sessionSourceFilter === 'opencode'">
                    <DropdownMenuSubTrigger>
                      <CircleAlert />
                      {{ $t('sessions.rateLimited') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ rateLimitScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-64">
                      <DropdownMenuRadioGroup v-model="sessionRateLimitScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.rateLimitedAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="only">{{ $t('sessions.rateLimitedOnly') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="pending">{{ $t('sessions.rateLimitedPending') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <p class="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                        {{ $t('sessions.rateLimitedNote') }}
                      </p>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- shape: derived in the browser from the two numbers already on every row, so
                       unlike the scopes around it this one narrows what was FETCHED rather than
                       reaching further back. The note in the submenu says so. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Hourglass />
                      {{ $t('sessions.shape') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ shapeScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-60">
                      <DropdownMenuRadioGroup v-model="sessionShapeScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.shapeAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="quick">{{ $t('sessions.shapeQuick') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="standard">{{ $t('sessions.shapeStandard') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="deep">{{ $t('sessions.shapeDeep') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="marathon">{{ $t('sessions.shapeMarathon') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="automation">{{ $t('sessions.shapeAutomation') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <p class="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                        {{ $t('sessions.shapeNote') }}
                      </p>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- three-way rather than a checkbox: archived is the large majority of the store,
                       so "only" is the only practical way to go back and find one. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Archive />
                      {{ $t('sessions.archived') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ archivedScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionArchivedScope">
                        <DropdownMenuRadioItem value="hide">{{ $t('sessions.archivedHide') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="include">{{ $t('sessions.archivedInclude') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="only">{{ $t('sessions.archivedOnly') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- how far back the list reaches. Applied server-side before the newest-N cap,
                       so widening the window genuinely reaches further back rather than
                       reshuffling the same rows. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <CalendarRange />
                      {{ $t('sessions.period') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
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
                      <span class="ml-auto pl-2 text-[11px] text-muted-foreground">
                        {{ $t('sessions.doneMarkCount', { n: doneCount }) }}
                      </span>
                    </DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>
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
            @click="checkedIds = new Set()"
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
          class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-warning/10 px-3 py-1.5 text-[11px] text-muted-foreground"
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

        <div class="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
          <!-- first-load skeletons so the list never looks blank -->
          <template v-if="sessionsLoading && sessions.length === 0 && !bodySearchActive">
            <div v-for="i in 6" :key="i" class="mb-1.5 px-3 py-2.5">
              <Skeleton class="h-4" :style="{ width: `${88 - (i % 3) * 16}%` }" />
              <div class="mt-2.5 flex items-center gap-2">
                <Skeleton class="h-3 w-16" />
                <Skeleton class="h-3 w-10" />
                <Skeleton class="h-3 w-12" />
              </div>
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
              class="mb-1.5 w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/50"
              @click="selectFromBodyResult(r)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="line-clamp-1 min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                  {{ baseName(r.cwd) }} · {{ shortId(r.session_id) }}
                </span>
                <Badge
                  variant="outline"
                  :class="['shrink-0 text-[10px]', sourceBadgeClass(r.source)]"
                >
                  {{ rowSourceLabel(r) }}
                </Badge>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {{ $t('sessions.matchCount', { n: r.match_count }) }}
                </span>
              </div>
              <p
                v-for="(snippet, i) in r.snippets"
                :key="i"
                class="mt-1 line-clamp-2 text-xs text-muted-foreground"
              >
                {{ snippet }}
              </p>
              <p v-if="r.truncated" class="mt-1 text-[11px] text-muted-foreground/70">
                {{ r.match_count - r.snippets.length }} {{ $t('sessions.truncatedMatches') }}
              </p>
            </button>
          </template>

          <div v-else-if="filtered.length === 0" class="p-4 text-center text-xs text-muted-foreground">
            <p>{{ $t('sessions.noSessionsFound') }}</p>
            <!-- the window is the most likely reason, and it is invisible until you open the ⋯
                 menu; offer the widening instead of making the user go find it -->
            <button
              v-if="emptyBecauseOfPeriod"
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="sessionPeriod = 'all'"
            >
              {{ $t('sessions.periodEmptyHint', { period: periodLabel }) }}
            </button>
          </div>

          <template v-if="!bodySearchActive">
            <!-- Each row owns a ContextMenu so right-click acts on the row under the pointer without
                 first selecting it (selecting would load a transcript the user never asked for).
                 The menu content only mounts while open, so the per-row cost is a reka root, not a
                 rendered menu. -->
            <ContextMenu v-for="s in filtered" :key="`${s.source}:${s.session_id}`">
              <ContextMenuTrigger as-child>
                <button
                  class="mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
                  :class="[
                    // Selected is a RAISED GREY, not an accent tint. bg-primary/10 composited to a
                    // maroon (#352626) against the dark ground, which read as a colour wash rather
                    // than a selection. Ladder in the sidebar: rest → hover (accent/50) → selected.
                    (selectMode
                      ? isChecked(s)
                      : s.session_id === selectedId && s.source === selectedSource)
                      ? 'border-border bg-accent'
                      : 'border-transparent hover:border-border hover:bg-accent/50',
                    // done rows stay in place and stay readable; they just stop competing for the eye
                    s.done && s.session_id !== selectedId ? 'opacity-55' : '',
                  ]"
                  @click="rowClick(s, $event)"
                >
                  <div class="flex items-start justify-between gap-2">
                    <span
                      v-if="selectMode"
                      class="mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors"
                      :class="[
                        isChecked(s)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                        s.source !== 'claude' ? 'opacity-25' : '',
                      ]"
                    >
                      <Check v-if="isChecked(s)" class="size-3" />
                    </span>
                    <CircleCheck
                      v-else-if="s.done"
                      class="mt-0.5 size-3.5 shrink-0 text-success"
                      :aria-label="$t('sessions.done')"
                    />
                    <span
                      class="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug"
                      :class="s.done ? 'line-through decoration-muted-foreground/40' : ''"
                      :title="titleOriginOf(s)"
                    >{{ s.title }}<!--
                      A title nobody chose gets a mark, and only that case: the string came out of a
                      wrapper around the first message, so it may match nothing the user has named.
                      --><span
                        v-if="titleIsUnattributed(s)"
                        class="ml-1 align-middle text-[10px] font-normal text-muted-foreground/70"
                      >&lt;{{ s.title_tag }}&gt;</span></span>
                    <!-- the wall this conversation died at. `pending` is the actionable half —
                         nothing followed the notice, so it is still sitting there — and it is the
                         only one loud enough to earn the warning colour. -->
                    <!-- ONLY while the wall is still the bottom of the transcript. A session that
                         hit a limit in the past and carried on is not rate limited, and a badge
                         that stays on forever stops meaning "this one needs you" — which is the
                         only thing it is for. `pending` is exactly that: nothing followed the
                         notice. Ever-hit is still reachable, as a filter. -->
                    <Badge
                      v-if="s.limit_stop?.pending"
                      variant="outline"
                      :title="limitTooltipOf(s)"
                      class="shrink-0 border-warning/50 bg-warning/10 text-[10px] text-warning"
                    >
                      {{ $t('sessions.rateLimitedBadgePending') }}
                    </Badge>
                    <StatusBadge v-if="s.queue_status" :status="s.queue_status" />
                    <Badge
                      variant="outline"
                      :class="['shrink-0 text-[10px]', sourceBadgeClass(s.source)]"
                    >
                      {{ rowSourceLabel(s) }}
                    </Badge>
                  </div>
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ baseName(s.cwd) }}</span>
                    <span v-if="s.git_branch" class="inline-flex items-center gap-1"><GitBranch class="size-3" />{{ s.git_branch }}</span>
                    <span class="inline-flex items-center gap-1"><MessagesSquare class="size-3" />{{ s.message_count }}</span>
                    <!-- the dot rides the timestamp it is derived from, so "green" and "2m ago" are
                         obviously the same fact rather than two claims to reconcile -->
                    <span class="inline-flex items-center gap-1">
                      <span
                        class="size-1.5 shrink-0 rounded-full"
                        :class="ACTIVITY_CLASS[activityOf(s)]"
                        :title="$t(ACTIVITY_LABEL[activityOf(s)])"
                      ></span>
                      <Clock class="size-3" />{{ timeAgo(s.last_activity_at) }}
                    </span>
                    <!-- SIZE, not a name. It sat unlabelled next to the account chip, so on a row
                         whose account was unknown "Marathon" was the last word on the line and read
                         as one. The tooltip says what it is; the always-present chip below stops it
                         being last. -->
                    <span class="inline-flex items-center gap-1" :title="shapeTitleOf(s)">
                      <ListTodo v-if="s.dispatched" class="size-3" />
                      <Hourglass v-else class="size-3" />{{ shapeLabel(sessionShape(s)) }}
                    </span>
                    <!-- Always rendered for a Claude session, even when the answer is "we don't
                         know". A blank space where the account goes reads as a rendering gap; the
                         truth is that Claude Desktop wrote no record of which account ran it, and
                         only saying so distinguishes the two. -->
                    <span
                      v-if="s.source === 'claude'"
                      class="inline-flex items-center gap-1"
                      :class="s.instance ? '' : 'text-muted-foreground/60'"
                      :title="s.instance ? undefined : $t('sessions.instanceUnknownHint')"
                    >
                      <Boxes class="size-3" />{{ s.instance ? (s.instance === 'default' ? $t('sessions.instanceDefault') : instanceLabelFor(s.instance)) : $t('sessions.instanceUnknown') }}
                    </span>
                    <!-- one conversation, several transcripts. Deliberately a label and not a
                         fold: every older copy measured held turns the newer one did not, and they
                         were things the user typed, so hiding one would lose them. -->
                    <span
                      v-if="s.copy_count > 1"
                      class="inline-flex items-center gap-1"
                      :title="copyWhyOf(s)"
                    >
                      <Layers class="size-3" />{{ copyChipOf(s) }}
                    </span>
                    <!-- this row stands for a fan-out: the subagents are sessions in the provider's
                         own store, folded in here rather than listed as conversations of their own -->
                    <span
                      v-if="s.subagent_count > 0"
                      class="inline-flex items-center gap-1"
                      :title="$t('sessions.subagentsHint', { count: s.subagent_count })"
                    >
                      <GitFork class="size-3" />{{ $t('sessions.subagents', { count: s.subagent_count }) }}
                    </span>
                    <!-- only meaningful while archived rows are being shown at all -->
                    <span
                      v-if="s.archived"
                      class="inline-flex items-center gap-1 text-muted-foreground"
                    >
                      <Archive class="size-3" />{{ $t('sessions.archived') }}
                    </span>
                  </div>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent class="max-w-60">
                <!-- Bulk section: only when THIS row is one of several checked rows, so a
                     right-click on an unchecked row still acts on that row alone. -->
                <template v-if="selectMode && bulkCount > 1 && isChecked(s)">
                  <ContextMenuLabel class="text-xs text-muted-foreground">
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
                        <ContextMenuLabel class="text-xs text-muted-foreground">
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
                        <ContextMenuLabel class="text-xs text-muted-foreground">
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
                            <span>{{ $t('sessions.migrateStartAndMove', { name: target.name }) }}</span>
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
                <template v-if="s.source !== 'opencode'">
                  <ContextMenuItem @select="openFile(s)">
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
                        <ContextMenuLabel class="text-xs text-muted-foreground">
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
                        <ContextMenuLabel class="text-xs text-muted-foreground">
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
                            <span>{{ $t('sessions.migrateStartAndMove', { name: target.name }) }}</span>
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
        </div>
      </div>

      <!-- drag-resize handle (double-click resets) -->
      <div
        v-show="!collapsed"
        class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors"
        :class="resizing ? 'bg-accent' : 'hover:bg-accent/60'"
        :title="$t('sessions.resizeSidebar')"
        @pointerdown.prevent="startResize"
        @dblclick="sidebarWidth = SIDEBAR_DEFAULT"
      />
    </aside>

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
                <Badge
                  variant="outline"
                  :class="['text-[10px]', sourceBadgeClass(selected.source)]"
                >
                  {{ rowSourceLabel(selected) }}
                </Badge>
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
                v-if="selected.source !== 'opencode'"
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
                      <DropdownMenuLabel class="flex items-center gap-2">
                        <SlidersHorizontal class="size-3.5" />{{ $t('sessions.displayControls') }}
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

                      <template v-if="selected.source !== 'opencode'">
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel class="flex items-center gap-2">
                          <FileSymlink class="size-3.5" />{{ $t('sessions.fileActions') }}
                        </DropdownMenuLabel>
                        <DropdownMenuItem @select="openFile(selected)">
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
                                :href="api.sessionExportUrl(selected.session_id, selected.source, 'markdown')"
                                download
                              >
                                <FileText />{{ $t('sessions.exportMarkdown') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem as-child>
                              <a
                                :href="api.sessionExportUrl(selected.session_id, selected.source, 'html')"
                                download
                              >
                                <Globe />{{ $t('sessions.exportHtml') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem as-child>
                              <a
                                :href="api.sessionFileUrl(selected.session_id, selected.source)"
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
                              <DropdownMenuItem disabled class="text-xs text-muted-foreground">
                                {{ $t('sessions.migrateRunningGroup') }}
                              </DropdownMenuItem>
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
                              <DropdownMenuItem disabled class="text-xs text-muted-foreground">
                                {{ $t('sessions.migrateClosedGroup') }}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                v-for="target in closedTargets"
                                :key="target.ref"
                                :disabled="migrating || target.isCurrent"
                                @select="migrateTo(selected, target)"
                              >
                                <ArrowRightLeft class="size-3.5" />
                                <span class="flex flex-col">
                                  <span>{{ $t('sessions.migrateStartAndMove', { name: target.name }) }}</span>
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
            class="h-7 max-w-xs text-xs"
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
            class="ml-auto"
            :aria-label="$t('sessions.findClose')"
            @click="closeFind"
          >
            <X />
          </Button>
        </div>

        <!-- transcript, styled as a chat: user right / assistant left, tool events as log lines -->
        <div
          ref="chatEl"
          class="scroll-slim min-h-0 flex-1 overflow-y-auto"
          :class="compactTranscript && 'transcript-compact'"
        >
          <div class="mx-auto w-full max-w-3xl px-4 py-4">
            <template v-if="tailLoading">
              <div class="space-y-4">
                <div class="flex justify-end"><Skeleton class="h-9 w-2/5 rounded-2xl" /></div>
                <div class="flex"><Skeleton class="h-20 w-4/5 rounded-2xl" /></div>
                <div class="flex justify-end"><Skeleton class="h-9 w-1/3 rounded-2xl" /></div>
                <div class="flex"><Skeleton class="h-14 w-3/5 rounded-2xl" /></div>
              </div>
            </template>

            <p v-else-if="tail?.error" class="text-xs text-destructive">{{ tail.error }}</p>
            <p v-else-if="events.length === 0" class="text-xs text-muted-foreground">
              {{ $t('sessions.noDisplayableTurns') }}
            </p>

            <template v-else>
              <div
                v-for="(ev, i) in events"
                :key="i"
                class="group flex items-end gap-1.5"
                :class="[
                  i > 0 && events[i - 1].role === ev.role ? 'mt-1.5' : 'mt-4',
                  ev.kind === 'text' && ev.role === 'user' ? 'justify-end' : 'justify-start',
                ]"
              >
                <!-- user bubbles get their copy button on the left, assistant on the right;
                     hover-revealed, but always faintly visible on touch screens -->
                <Button
                  v-if="ev.kind === 'text' && ev.role === 'user'"
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                  :title="$t('sessions.copyMessage')"
                  @click="copyMessage(i, ev.text)"
                >
                  <Check v-if="copiedIdx === i" class="text-success" />
                  <Copy v-else />
                </Button>

                <!-- tool activity and reasoning: a compact log line, not a bubble -->
                <div
                  v-if="ev.kind !== 'text'"
                  class="w-full min-w-0 rounded-md border-l-2 border-border bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground"
                  :class="ev.kind === 'thinking' ? 'italic' : 'font-mono'"
                >
                  <div class="mb-0.5 flex items-center gap-1 font-semibold not-italic">
                    <Brain v-if="ev.kind === 'thinking'" class="size-3" />
                    <Wrench v-else class="size-3" />
                    {{ ev.kind === 'thinking' ? $t('sessions.thinkingLabel') : ev.tool_name ?? ev.kind }}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                      :title="$t('sessions.copyMessage')"
                      @click="copyMessage(i, ev.text)"
                    >
                      <Check v-if="copiedIdx === i" class="text-success" />
                      <Copy v-else />
                    </Button>
                  </div>
                  <!-- eslint-disable-next-line vue/no-v-html -- the text is HTML-escaped before
                       anything reads it (lib/markdown.ts), and lib/find.ts only ever adds <mark>
                       around already-escaped slices, so no tag here came from the transcript -->
                  <div
                    class="break-words"
                    :class="[
                      ev.pre ? 'whitespace-pre-wrap' : 'md',
                      ev.long && !isExpanded(i) ? 'max-h-48 overflow-hidden' : '',
                    ]"
                    v-html="ev.html"
                  ></div>
                  <button
                    v-if="ev.long"
                    class="mt-1 text-[11px] font-medium text-primary hover:underline"
                    @click="toggleExpand(i)"
                  >
                    {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
                  </button>
                </div>

                <!-- chat bubbles: user = raised grey, assistant = flatter muted. The user bubble was
                     bg-primary/15, which composited to #352626 — a maroon block behind every message
                     you sent, rather than a neutral raised surface. -->
                <div
                  v-else
                  class="min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm"
                  :class="ev.role === 'user' ? 'rounded-br-md bg-accent' : 'rounded-bl-md bg-muted/50'"
                >
                  <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
                  <div
                    class="break-words"
                    :class="[
                      ev.pre ? 'whitespace-pre-wrap' : 'md',
                      ev.long && !isExpanded(i) ? 'max-h-56 overflow-hidden' : '',
                    ]"
                    v-html="ev.html"
                  ></div>
                  <button
                    v-if="ev.long"
                    class="mt-1 text-[11px] font-medium text-primary hover:underline"
                    @click="toggleExpand(i)"
                  >
                    {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
                  </button>
                </div>

                <Button
                  v-if="ev.kind === 'text' && ev.role !== 'user'"
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                  :title="$t('sessions.copyMessage')"
                  @click="copyMessage(i, ev.text)"
                >
                  <Check v-if="copiedIdx === i" class="text-success" />
                  <Copy v-else />
                </Button>
              </div>
            </template>
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
      <DialogContent class="max-w-md">
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
            <div class="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
              <span class="truncate">{{ g.project }}</span>
              <span class="shrink-0">{{ $t('sessions.groupCount', { n: g.sessions.length }) }}</span>
            </div>
            <ul class="space-y-1">
              <li v-for="s in g.sessions" :key="s.session_id">
                <button
                  type="button"
                  class="w-full truncate rounded border border-border px-2 py-1 text-left hover:bg-accent"
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
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('sessions.secretsTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('sessions.secretsCaveat') }}</DialogDescription>
        </DialogHeader>
        <ul class="scroll-slim max-h-80 space-y-1 overflow-y-auto text-xs">
          <li
            v-for="(f, i) in secrets?.findings ?? []"
            :key="i"
            class="flex items-center gap-2 rounded border border-border px-2 py-1.5"
          >
            <Badge variant="outline" class="shrink-0 text-[10px]">{{ f.kind }}</Badge>
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
