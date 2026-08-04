<script setup lang="ts">
import { safeTranscriptFilename } from '@agenthydra/server/filenames'
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Boxes,
  CalendarRange,
  Check,
  CircleCheck,
  CircleSlash,
  ClipboardCopy,
  Clock,
  Copy,
  Download,
  FileSymlink,
  FolderGit2,
  GitBranch,
  ListTodo,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Wrench,
  X,
} from '@lucide/vue'
import { useMediaQuery, useStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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
import type {
  ArchivedScope,
  SessionPeriod,
  SessionSearchResult,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  TailResult,
} from '@/lib/api'
import * as api from '@/lib/api'
import { baseName, shortId, timeAgo } from '@/lib/format'
import { displayName } from '@/lib/instance-appearance'
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
const { instances: desktopInstances, refreshInstances } = useInstances()
const namedInstances = computed(() =>
  desktopInstances.value.map((i) => ({ name: i.name, label: displayName(i) })),
)
const instanceLabelFor = (folder: string) =>
  namedInstances.value.find((i) => i.name === folder)?.label ?? folder
// silent: this view has no instance-list spinner to drive, and the toolbar Refresh icon it would
// toggle belongs to a different view entirely.
onMounted(() => void refreshInstances({ silent: true }))
// Every scope is applied server-side, so any of them changing needs a refetch, not a re-filter.
watch([sessionInstanceFilter, sessionArchivedScope, sessionPeriod], () => refreshSessions())
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
    // Only a WIDENED window counts. 24h is the default, so flagging it would light the trigger up
    // permanently and the signal would stop meaning anything.
    sessionPeriod.value !== '24h',
)
const SOURCE_LABEL: Record<SessionSourceScope, string> = {
  all: 'sessions.sourceAll',
  claude: 'sessions.sourceClaude',
  codex: 'sessions.sourceCodex',
  opencode: 'sessions.sourceOpenCode',
}
const sourceFilterLabel = computed(() => t(SOURCE_LABEL[sessionSourceFilter.value]))
const sourceLabel = (source: SessionSource) => t(SOURCE_LABEL[source])
const SOURCE_BADGE_CLASS: Record<SessionSource, string> = {
  claude: 'border-[#D97757]/40 bg-[#D97757]/10 text-[#B85D3D] dark:text-[#E9A287]',
  codex: 'border-[#10A37F]/40 bg-[#10A37F]/10 text-[#087D62] dark:text-[#65D4B3]',
  opencode: 'border-[#5B6EF5]/40 bg-[#5B6EF5]/10 text-[#4053D6] dark:text-[#9AA6FF]',
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
    await navigator.clipboard.writeText(path)
    toast.success(t('sessions.copyFileLocationDone'))
  } catch {
    toast.error(t('sessions.copyFileLocationFailed'))
  }
}

const search = ref('')
const selectedId = ref<string | null>(null)
const selectedSource = ref<SessionSource | null>(null)
const tail = ref<TailResult | null>(null)
const tailLoading = ref(false)
// verbose mode: also show tool_use / tool_result events (off = responses only)
const showTools = useStorage('agenthydra.sessions.showTools', false)

// --- sidebar: persisted drag-resize + animated collapse, auto-collapsing when narrow ---
const RAIL_WIDTH = 44
const SIDEBAR_MIN = 240
const SIDEBAR_MAX = 560
const SIDEBAR_DEFAULT = 340
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))

const sidebarWidth = useStorage('agenthydra.sessions.sidebarWidth', SIDEBAR_DEFAULT)
sidebarWidth.value = clampWidth(sidebarWidth.value)

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
  if (!q) return sessions.value
  return sessions.value.filter(
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
const advancedCaseSensitive = useStorage('agenthydra.sessions.advancedCaseSensitive', false)
const bodySearching = ref(false)
const bodySearchActive = ref(false)
const bodySearchQueryUsed = ref('')
const bodyResults = ref<SessionSearchResult[]>([])

async function runBodySearch() {
  const q = advancedQuery.value.trim()
  if (!q) return
  bodySearching.value = true
  try {
    const results = await api.searchSessionBodies(q, {
      regex: advancedRegex.value,
      caseSensitive: advancedCaseSensitive.value,
      instance: sessionInstanceFilter.value || undefined,
      source: sessionSourceFilter.value === 'all' ? undefined : sessionSourceFilter.value,
    })
    bodyResults.value = results
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

function exitBodySearch() {
  bodySearchActive.value = false
  bodyResults.value = []
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

const events = computed(() =>
  (tail.value?.events ?? []).map((ev) => ({ ...ev, long: isLong(ev.text) })),
)

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

async function loadTail(opts: { silent?: boolean } = {}) {
  const id = selectedId.value
  const source = selectedSource.value
  if (!id || !source) return
  // measured BEFORE the fetch: whether the reader was already at the conversation's end
  const el = chatEl.value
  const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
  if (!opts.silent) tailLoading.value = true
  try {
    const r = await api.getTail(id, source, {
      limit: 40,
      textOnly: !showTools.value,
    })
    if (selectedId.value !== id || selectedSource.value !== source) return
    tail.value = r
  } catch {
    if (!opts.silent) tail.value = null
  } finally {
    if (!opts.silent) tailLoading.value = false
  }
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

watch(showTools, () => loadTail())

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
  if (!!id !== !!oldId && selectedId.value) loadTail({ silent: true })
})
onBeforeUnmount(() => window.clearInterval(tailPollTimer))

// --- multi-select: pick several sessions, message them all at once ------------
const selectMode = ref(false)
const checkedIds = ref<Set<string>>(new Set())
const sessionKey = (s: Pick<SessionSummary, 'source' | 'session_id'>) =>
  `${s.source}:${s.session_id}`
const isChecked = (s: SessionSummary) => checkedIds.value.has(sessionKey(s))
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) checkedIds.value = new Set()
}
function toggleChecked(s: SessionSummary) {
  if (s.source !== 'claude') return
  const next = new Set(checkedIds.value)
  const key = sessionKey(s)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  checkedIds.value = next
}
function checkAllFiltered() {
  checkedIds.value = new Set(filtered.value.filter((s) => s.source === 'claude').map(sessionKey))
}
function rowClick(s: SessionSummary) {
  if (selectMode.value) toggleChecked(s)
  else select(s)
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
                <DropdownMenuContent align="end" class="w-56">
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
                    <DropdownMenuSubContent class="w-52">
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
                    <DropdownMenuSubContent class="w-80">
                      <DropdownMenuRadioGroup v-model="sessionInstanceFilter">
                        <DropdownMenuRadioItem value="">{{ $t('sessions.instanceAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="default">{{ $t('sessions.instanceDefault') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem v-for="i in namedInstances" :key="i.name" :value="i.name">{{ i.label }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="other">{{ $t('sessions.instanceOther') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
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
                    <DropdownMenuSubContent class="w-52">
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
                    <DropdownMenuSubContent class="w-52">
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
                  {{ sourceLabel(r.source) }}
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
                  @click="rowClick(s)"
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
                    >{{ s.title }}</span>
                    <StatusBadge v-if="s.queue_status" :status="s.queue_status" />
                    <Badge
                      variant="outline"
                      :class="['shrink-0 text-[10px]', sourceBadgeClass(s.source)]"
                    >
                      {{ sourceLabel(s.source) }}
                    </Badge>
                  </div>
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ baseName(s.cwd) }}</span>
                    <span v-if="s.git_branch" class="inline-flex items-center gap-1"><GitBranch class="size-3" />{{ s.git_branch }}</span>
                    <span class="inline-flex items-center gap-1"><MessagesSquare class="size-3" />{{ s.message_count }}</span>
                    <span class="inline-flex items-center gap-1"><Clock class="size-3" />{{ timeAgo(s.last_activity_at) }}</span>
                    <span v-if="s.instance" class="inline-flex items-center gap-1">
                      <Boxes class="size-3" />{{ s.instance === 'default' ? $t('sessions.instanceDefault') : instanceLabelFor(s.instance) }}
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
              <ContextMenuContent class="w-52">
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
                  {{ sourceLabel(selected.source) }}
                </Badge>
                <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ selected.cwd }}</span>
                <span class="inline-flex items-center gap-1">
                  <MessagesSquare class="size-3" />{{ tail?.events.length ?? 0 }} {{ $t('sessions.turnsShown') }}
                </span>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <!-- icon-only toggle (same shape as the ID button): pressed = tool events shown -->
              <IconTooltip :label="$t('sessions.showToolActivity')" :description="$t('sessions.showToolActivityHint')">
                <Button
                  :variant="showTools ? 'secondary' : 'outline'"
                  size="sm"
                  :aria-label="$t('sessions.showToolActivity')"
                  :aria-pressed="showTools"
                  @click="showTools = !showTools"
                >
                  <Wrench />
                </Button>
              </IconTooltip>
              <IconTooltip
                v-if="selected.source !== 'opencode'"
                :label="$t('sessions.openFile')"
                :description="$t('sessions.openFileHint')"
              >
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="$t('sessions.openFile')"
                  @click="openFile(selected)"
                >
                  <FileSymlink />
                </Button>
              </IconTooltip>
              <IconTooltip
                v-if="selected.source !== 'opencode'"
                :label="$t('sessions.saveCopy')"
                :description="$t('sessions.saveCopyHint')"
              >
                <Button
                  as="a"
                  variant="outline"
                  size="sm"
                  :href="api.sessionFileUrl(selected.session_id, selected.source)"
                  :download="safeTranscriptFilename(selected.title, selected.session_id)"
                  :aria-label="$t('sessions.saveCopy')"
                >
                  <Download />
                </Button>
              </IconTooltip>
              <IconTooltip
                v-if="selected.source !== 'opencode'"
                :label="$t('sessions.copyFile')"
                :description="$t('sessions.copyFileHint')"
              >
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="copyingFile"
                  :aria-label="$t('sessions.copyFile')"
                  @click="copyFile(selected)"
                >
                  <ClipboardCopy />
                </Button>
              </IconTooltip>
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
                  <Copy />
                </Button>
              </IconTooltip>
              <IconTooltip :label="$t('sessions.copySessionId')">
                <Button variant="outline" size="sm" @click="copy(selected.session_id)">
                  <Copy /> {{ $t('sessions.id') }}
                </Button>
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

        <!-- transcript, styled as a chat: user right / assistant left, tool events as log lines -->
        <div ref="chatEl" class="scroll-slim min-h-0 flex-1 overflow-y-auto">
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

                <!-- tool activity: a compact log line, not a bubble -->
                <div
                  v-if="ev.kind !== 'text'"
                  class="w-full min-w-0 rounded-md border-l-2 border-border bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground"
                >
                  <div class="mb-0.5 flex items-center gap-1 font-semibold">
                    <Wrench class="size-3" />{{ ev.tool_name ?? ev.kind }}
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
                  <div
                    class="whitespace-pre-wrap break-words"
                    :class="ev.long && !isExpanded(i) ? 'max-h-48 overflow-hidden' : ''"
                  >{{ ev.text }}</div>
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
                  <div
                    class="whitespace-pre-wrap break-words"
                    :class="ev.long && !isExpanded(i) ? 'max-h-56 overflow-hidden' : ''"
                  >{{ ev.text }}</div>
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
  </div>
</template>
