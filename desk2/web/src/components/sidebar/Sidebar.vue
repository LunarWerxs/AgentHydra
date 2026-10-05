<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChatSummary, CliMayteWorker, CloudSession, ExternalSession, SessionMetaPatch } from '@shared/protocol'
import { icons, shellGlyphs, sidebarIcons } from '@/lib/icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import AccountsPopover from '@/components/accounts/AccountsPopover.vue'
import { useShellSource } from '@/components/shell/source'
import CloudList from '@/components/cloud/CloudList.vue'
import { useCloud } from '@/components/cloud/store'
import HydraSidebar from '@/components/hydra/HydraSidebar.vue'
import { hydraOpen, hydraSidebar, openWorkerInHydra } from '@/components/hydra/api'
import { Cloud, Info } from '@lucide/vue'
import TaskRows from './TaskRows.vue'
import RunningBadge from './RunningBadge.vue'
import { nestTasks, runningIn, showTasks, unplacedText, type NestedTasks, type NestRow } from './tasks'
import ChatRow from './ChatRow.vue'
import SidebarTools from './SidebarTools.vue'
import ExternalRow from './ExternalRow.vue'
import SearchHitRow from './SearchHitRow.vue'
import {
  IDLE_SEARCH,
  createSearchRunner,
  everywhereRows,
  moveCursor,
  resolveCursor,
  searchEscape,
  searchTargets,
  shownSessionIds,
  type SearchState
} from './search'
import {
  accountFace,
  chatRow,
  entryRunning,
  externalRow,
  groupChats,
  groupChoices,
  groupOrderKey,
  isOrange,
  moveInOrder,
  raiseNewlyOrange,
  recordDeskOrder,
  moveTarget,
  parseFilter,
  resumeCommand,
  revealChat,
  rowPatch,
  runningSessionIds,
  movingGlyphs,
  type ChatGroup,
  type RowMenuItem,
  type RowState,
  type SidebarFilter
} from './logic'
import { useSidebarOrder } from './order'
import { leaveUnlessFiltered } from '@/lib/row-leave'

// The real sidebar: 288 wide on #111111, 36px left free at the top for the chrome bar, the New row (the
// real app's Projects, Artifacts, Customize and More rows are left out on purpose), then Pinned and one
// group per folder holding our chats and the sessions running elsewhere, and a 44px footer with the
// profile (account) control and the Settings gear.
const props = withDefaults(defineProps<{ width?: number; /** Gallery: open the account popup at once. */ accountsOpen?: boolean }>(), {
  width: 288,
  accountsOpen: false
})
const emit = defineEmits<{ resize: [width: number] }>()

// 240, not the real app's 220: the chrome bar over it carries Hydra Desk 2's three extra buttons.
const MIN_WIDTH = 240
const MAX_WIDTH = 420

const src = useShellSource()
const selected = computed(() => src.selected.value)
const selectedChatId = computed(() => (selected.value.kind === 'chat' ? selected.value.id : null))

const selectedExternalId = computed(() => (selected.value.kind === 'external' ? selected.value.id : null))
const accountsOpen = ref(props.accountsOpen)

const storage = typeof localStorage === 'undefined' ? null : localStorage

// Search, filter (remembered), archived
const searchOpen = ref(false)
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const FILTER_KEY = 'hydra-desk.sidebar.filter'
function readFilter(): SidebarFilter {
  try {
    return parseFilter(storage?.getItem(FILTER_KEY))
  } catch {
    return 'active'
  }
}
const filter = ref<SidebarFilter>(readFilter())
watch(filter, (f) => storage?.setItem(FILTER_KEY, f))

function openSearch() {
  searchOpen.value = true
  nextTick(() => searchInput.value?.focus())
}
function closeSearch() {
  searchOpen.value = false
  query.value = ''
  cloud.search.value = ''
}

// Hydra Desk 2: the chrome bar's cloud button shows the cloud list here instead (every session of both
// PCs, components/cloud). The search box then searches it: AgentHydra matches titles over everything in
// the list's scope, or over everything at all unless "Only this view" is ticked.
const cloud = useCloud()
const searchText = computed({
  get: () => (cloud.on.value ? cloud.search.value : query.value),
  set: (v: string) => {
    if (cloud.on.value) cloud.search.value = v
    else query.value = v
  }
})
// A cloud row opens as an outside session on Desk's side, with AgentHydra's session header over it
// (AgentHydra, if it is open, slides away: DeskFrame).
function openCloud(r: CloudSession) {
  src.select({ kind: 'external', id: r.id })
}
function onCloudSearchKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    const first = cloud.groups.value[0]?.rows[0]
    if (first) openCloud(first)
  } else if (e.key === 'Escape') {
    if (searchEscape(e, cloud.search.value) === 'clear') cloud.search.value = ''
    else closeSearch()
  }
}

// The order groups and rows keep (Jacob, 2026-10-04: sending a message must not reorder the list; groups
// are dragged into the order wanted), the one the cloud list keeps too (order.ts). New ones join at the top.
const { order, save: saveOrder } = useSidebarOrder()

// While AgentHydra is open, a tab of it with a sidebar of its own (CliMayte, HSwarm) has it drawn here.
const hydraModel = computed(() => (hydraOpen.value ? hydraSidebar.value : null))

const groups = computed(() =>
  groupChats(src.chats.value, { query: query.value, filter: filter.value, external: src.external.value, order: order.value })
)
// A group or row the plain list shows that the order lacks joins it at the top, so it keeps the place it
// appeared in, and so does one only the cloud list had shown (recordDeskOrder); any other saved one never
// moves; a row that just turned orange goes to the top of its group.
const wasOrange = new Map<string, boolean>()
watch(
  groups,
  (g) => {
    if (query.value.trim() || filter.value !== 'active') return
    const shownEntries = [...(g.pinned?.entries ?? []), ...g.folders.flatMap((f) => f.entries)]
    const shownGroups = g.folders.map(groupOrderKey)
    const shownRows = shownEntries.map((e) => e.id)
    const next = recordDeskOrder(order.value, shownGroups, shownRows)
    const rows = raiseNewlyOrange(next.rows, shownEntries, wasOrange)
    for (const e of shownEntries) wasOrange.set(e.id, isOrange(e))
    saveOrder({ ...next, rows })
  },
  { immediate: true }
)

// Dragging a folder group's header onto another puts it just above that one.
const dragging = ref<string | null>(null)
const dropOn = ref<string | null>(null)
const draggable = (g: ChatGroup) => g.key !== 'pinned' && g.key !== 'archived'
function onGroupDragStart(ev: DragEvent, g: ChatGroup) {
  dragging.value = groupOrderKey(g)
  ev.dataTransfer?.setData('text/plain', g.label)
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
}
function onGroupDragOver(ev: DragEvent, g: ChatGroup) {
  if (!dragging.value || !draggable(g)) return
  ev.preventDefault()
  dropOn.value = groupOrderKey(g)
}
function onGroupDrop(ev: DragEvent, g: ChatGroup) {
  ev.preventDefault()
  const from = dragging.value
  const to = groupOrderKey(g)
  dragging.value = dropOn.value = null
  if (!from || from === to || !draggable(g)) return
  saveOrder({ ...order.value, groups: moveInOrder(order.value.groups, from, to) })
}
function onGroupDragEnd() {
  dragging.value = dropOn.value = null
}
const groupList = computed<ChatGroup[]>(() => {
  const g = groups.value
  return [...(g.pinned ? [g.pinned] : []), ...g.folders, ...(g.archived ? [g.archived] : [])]
})
const filtering = computed(() => query.value.trim() !== '' || filter.value !== 'active')
const rowLeave = leaveUnlessFiltered([query, filter])
const emptyText = computed(() =>
  query.value.trim() ? 'No matching sessions' : filter.value === 'archived' ? 'No archived sessions' : 'No sessions yet'
)

// Hydra Desk 2: with the chrome bar's CliMayte button on, each row of the list shown (the cloud list or the
// desk list, the rows each draws) lists the CliMayte tasks it handed out under it, a manager's wave one step
// further in, each task once (tasks.ts), another PC's under its chat too (the chat sync brings that chat here
// with the same session id; owner, 2026-10-04: "Under the chat which spawned them. Not as its own stand alone
// table"). A running task no drawn row lists (its PC does not say which chat started it, or the filter, the
// search or the list leaves that chat out) is still shown, at the top, per PC, the reason behind its ⓘ: every
// task AgentHydra's CliMayte list shows running is here (owner, 2026-10-05: "Is one smaller than six?"). The
// other PCs' tasks only with the cloud on (owner, 2026-10-05: "when cloud is turned off, it shouldn't show
// these"): the desk store keeps them apart from src.workers so they never count as this PC's
// (stores/desk.ts splitWorkers); a source without them (the Gallery) has none.
const remoteWorkers = computed(() => (cloud.on.value ? (src.remoteWorkers?.value ?? []) : []))
const nesting = computed<NestedTasks | null>(() => {
  if (!showTasks.value) return null
  const workers = [...src.workers.value, ...remoteWorkers.value]
  if (cloud.on.value) return nestTasks(cloud.groups.value.flatMap((g) => g.rows.map((r) => ({ key: `cloud:${r.id}`, sessionIds: [r.id] }))), workers)
  // The rows the desk list draws, as groupChats picks them (never a CliMayte worker's own session, nor a
  // session that is one of our chats); a row in a folded group still holds its tasks, and the group's heading
  // counts the running ones (RunningBadge). A chat stands for its worker by id too, so one still queued (no
  // session yet) is not listed again as a task.
  const rows: NestRow[] = groupList.value.flatMap((g) =>
    g.entries.map((e) =>
      e.kind === 'chat'
        ? { key: `chat:${e.id}`, sessionIds: e.chat.sessionId ? [e.chat.sessionId] : [], workerId: e.chat.workerId }
        : { key: `external:${e.id}`, sessionIds: [e.session.id] }
    )
  )
  return nestTasks(rows, workers)
})
const tasksOf = (key: string) => nesting.value?.byRow.get(key) ?? null
/** The running tasks under a desk-list group's rows, and its rows that run, for its heading while it is folded. */
const runningInGroup = (g: ChatGroup) => runningIn(g.entries.map((e) => tasksOf(`${e.kind}:${e.id}`)))
const chatsRunningIn = (g: ChatGroup) => g.entries.filter(entryRunning).length
/** The cloud list's rows that run: the ones the desk knows as running. */
const runningSessions = computed(() => runningSessionIds(src.chats.value, src.external.value))
const sessionRunning = (id: string) => runningSessions.value.has(id)
const movingDots = computed(() => movingGlyphs(src.chats.value, src.external.value))
/** A task with a session here opens its transcript; one still queued, or another PC's, opens on CliMayte's tab. */
function openTask(w: CliMayteWorker) {
  if (w.sessionId && !w.pc) src.select({ kind: 'external', id: w.sessionId })
  else openWorkerInHydra(w.id, w.pc)
}

// The chosen chat lands visibly: its group opens and its row scrolls into view (a new chat is the
// first row of its group). One the filter or the search hides (a chat started while Archived is on)
// brings the list that shows it back; one picked from the Everywhere rows leaves the search as it is.
const groupOf = (id: string) => groupList.value.find((g) => g.entries.some((e) => e.kind === 'chat' && e.id === id))
watch(selectedChatId, (id) => {
  if (!id) return
  let group = groupOf(id)
  const chat = group ? null : src.chats.value.find((c) => c.id === id)
  if (chat && !everywhere.value.some((r) => r.view.kind === 'chat' && r.view.id === id)) {
    const shown = revealChat(chat, filter.value)
    query.value = shown.query
    filter.value = shown.filter
    group = groupOf(id)
  }
  if (group && collapsed.value.has(group.key)) toggleGroup(group.key)
  nextTick(() => {
    const row = root.value?.querySelector<HTMLElement>('[aria-current="page"]')
    row?.closest('section')?.querySelector('header')?.scrollIntoView({ block: 'nearest' })
    row?.scrollIntoView({ block: 'nearest' })
  })
})

// Collapsed groups, remembered
const COLLAPSED_KEY = 'hydra-desk.sidebar.collapsed'
function readCollapsed(): string[] {
  try {
    const v = JSON.parse(storage?.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
const collapsed = ref(new Set(readCollapsed()))
function toggleGroup(key: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(key)) next.add(key)
  collapsed.value = next
  storage?.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
}

// AgentHydra's transcript search under the title matches ("Everywhere"), debounced. The arrow keys
// move through both lists, Enter opens, Escape clears the box and then closes it.
const search = ref<SearchState>(IDLE_SEARCH)
const runner = createSearchRunner({ run: (q) => src.search(q), onChange: (s) => (search.value = s) })
const everywhere = computed(() => everywhereRows(search.value.hits, src.chats.value, shownSessionIds(groupList.value, collapsed.value)))
const targets = computed(() => (searchOpen.value ? searchTargets(groupList.value, collapsed.value, everywhere.value) : []))
// The cursor is its row (kind and id) and the place it was last at, for when that row goes away.
const cursor = ref<{ key: string | null; at: number }>({ key: null, at: -1 })
const cursorAt = computed(() => resolveCursor(targets.value, cursor.value.key, cursor.value.at))
const cursorKey = computed(() => targets.value[cursorAt.value]?.key ?? null)
const setCursor = (at: number) => (cursor.value = { key: targets.value[at]?.key ?? null, at })
// Its row gone, the cursor takes the row now at its place, and follows that one from then on.
watch(cursorKey, (key) => key !== cursor.value.key && setCursor(cursorAt.value))
watch(query, (q) => {
  runner.input(q)
  setCursor(-1)
})
onBeforeUnmount(runner.stop)
function onSearchKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    setCursor(moveCursor(cursorAt.value, e.key === 'ArrowDown' ? 1 : -1, targets.value.length))
    nextTick(() => root.value?.querySelector('[data-search-cursor]')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    // A search that failed or found AgentHydra offline is asked again.
    if (search.value.phase === 'failed' || search.value.phase === 'offline') runner.input(query.value)
    const target = targets.value[Math.max(0, cursorAt.value)]
    if (target) src.select(target.view)
  } else if (e.key === 'Escape') {
    if (searchEscape(e, query.value) === 'clear') query.value = ''
    else closeSearch()
  }
}

// Row actions: one menu for our chats and outside sessions. A chat's marks are the chat's; an outside
// session's are Hydra Desk's overlay on it (its own files are never touched, so it has no Delete).
type Row = { kind: 'chat'; chat: ChatSummary } | { kind: 'external'; session: ExternalSession }
const deleting = ref<ChatSummary | null>(null)
const groupNames = computed(() => groupChoices(src.chats.value, src.external.value))
const stateOf = (row: Row): RowState => (row.kind === 'chat' ? chatRow(row.chat) : externalRow(row.session))
// A row action that failed says so under the list, with the server's reason, until the next one.
const rowError = ref<string | null>(null)
function attempt(what: string, run: Promise<unknown>) {
  rowError.value = null
  void run.catch((err: unknown) => (rowError.value = `${what} failed: ${err instanceof Error ? err.message : String(err)}`))
}
function mark(row: Row, patch: SessionMetaPatch & { title?: string }) {
  attempt('The change', row.kind === 'chat' ? src.updateChat(row.chat.id, patch) : src.updateSessionMeta(row.session.id, patch))
}
function act(row: Row, item: RowMenuItem) {
  const state = stateOf(row)
  const patch = rowPatch(item, state)
  if (patch) return mark(row, patch)
  if (item.action === 'stop' && row.kind === 'chat') attempt('Stop', src.interrupt(row.chat.id))
  else if (item.action === 'delete' && row.kind === 'chat') deleting.value = row.chat
  else if (item.action === 'fork') attempt('Fork', row.kind === 'chat' ? src.forkChat(row.chat.id) : src.forkExternal(row.session.id))
  else if (item.action === 'newGroup') {
    groupDraft.value = ''
    naming.value = row
  } else if (item.action === 'reveal') attempt('Opening the folder', src.revealFolder(state.cwd))
  else if (item.action === 'copyResume' && state.sessionId) attempt('Copy', navigator.clipboard.writeText(resumeCommand(state.sessionId)))
  else if (item.action === 'copySessionId' && state.sessionId) attempt('Copy', navigator.clipboard.writeText(state.sessionId))
}
/** Opening an outside session reads it, as opening a chat does. */
function openExternal(s: ExternalSession) {
  src.select({ kind: 'external', id: s.id })
  if (s.unread) mark({ kind: 'external', session: s }, { unread: false })
}

// Move to group > New group…: a name, then the row moves there.
const naming = ref<Row | null>(null)
const groupDraft = ref('')
const GROUP_MAX = 60
const groupName = computed(() => groupDraft.value.trim())
function confirmGroup() {
  const row = naming.value
  naming.value = null
  if (row && groupName.value && groupName.value.length <= GROUP_MAX) mark(row, { group: moveTarget(stateOf(row), groupName.value) })
}
async function confirmDelete() {
  const chat = deleting.value
  deleting.value = null
  if (!chat) return
  if (selectedChatId.value === chat.id) src.select({ kind: 'new' })
  await src.removeChat(chat.id).catch(() => {})
}

// Footer
const face = computed(() => accountFace(src.settings.value?.defaultAccountId ?? 'auto', src.accounts.value))

// Resize handle
const root = ref<HTMLElement | null>(null)
function clampWidth(w: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
}
function onResizeDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const left = root.value?.getBoundingClientRect().left ?? 0
  const move = (ev: PointerEvent) => emit('resize', clampWidth(ev.clientX - left))
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onResizeKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') emit('resize', clampWidth(props.width - 8))
  else if (e.key === 'ArrowRight') emit('resize', clampWidth(props.width + 8))
}

defineExpose({
  openSearch,
  /** The title bar's chat menu runs here: the same actions and dialogs as the row's. */
  chatAction: (chat: ChatSummary, item: RowMenuItem) => act({ kind: 'chat', chat }, item)
})

const NAV_ROW =
  'group/nav flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-left text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none'
const HEADER_BTN = 'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text'
</script>

<template>
  <aside
    ref="root"
    aria-label="Sidebar"
    class="relative flex h-full shrink-0 flex-col border-r border-border bg-bg-sidebar pt-9"
    :style="{ width: `${width}px` }"
  >
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-1 pt-2">
      <nav class="flex shrink-0 flex-col gap-[0.5px] pr-[2px]">
        <button
          type="button"
          :class="[NAV_ROW, selected.kind === 'new' ? 'bg-fill-selected text-text' : 'text-text hover:bg-fill-hover']"
          @click="src.select({ kind: 'new' })"
        >
          <span class="flex size-6 shrink-0 items-center justify-center text-text-2">
            <span class="flex size-[18px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text-2)_15%,transparent)]">
              <component :is="shellGlyphs.newPlus" class="size-4" />
            </span>
          </span>
          <span class="min-w-0 flex-1 truncate">New</span>
          <kbd class="pr-1.5 font-sans text-[12px] text-text-shortcut opacity-0 group-hover/nav:opacity-100">Ctrl + N</kbd>
        </button>

      </nav>

      <!-- Sessions: Pinned, then one group per folder; ours and the ones running elsewhere together -->
      <div class="min-h-0 flex-1 overflow-y-auto pr-[2px] pt-1 [scrollbar-width:none]">
        <div v-if="searchOpen && !hydraModel" class="mb-1 flex h-[26px] items-center gap-1 rounded-[var(--radius-6)] bg-fill-5 px-0.5">
          <span class="flex size-6 shrink-0 items-center justify-center text-text-muted"><component :is="icons.search" class="size-4" /></span>
          <input
            ref="searchInput"
            v-model="searchText"
            type="text"
            aria-label="Search sessions"
            :placeholder="cloud.on.value ? 'Search every session' : 'Search sessions'"
            class="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-muted"
            @keydown="cloud.on.value ? onCloudSearchKey($event) : onSearchKey($event)"
          />
          <button type="button" aria-label="Close search" class="flex size-5 items-center justify-center rounded-[var(--radius-5)] text-text-muted hover:bg-fill-hover hover:text-text" @click="closeSearch">
            <component :is="icons.dismiss" class="size-3.5" />
          </button>
        </div>

        <template v-if="!hydraModel && nesting">
          <section v-for="g in nesting.unplaced" :key="`${g.pc ?? ''}|${g.reason}`" :aria-label="`${unplacedText(g).title}: CliMayte tasks not under a chat`">
            <!-- Why they are not under a chat sits behind the ⓘ (owner, 2026-10-05: "remove this ... text and put it in a info note"). -->
            <header class="flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-3 text-[12px] leading-4 text-text-muted">
              <Cloud v-if="g.pc" class="size-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ unplacedText(g).title }}</span>
              <Tip :label="unplacedText(g).note" align="start" :delay="100">
                <button type="button" class="flex size-4 shrink-0 items-center justify-center rounded-[4px] hover:text-text-2" :aria-label="unplacedText(g).note">
                  <Info class="size-3" aria-hidden="true" />
                </button>
              </Tip>
              <span class="flex-1" />
              <span class="tnum">{{ unplacedText(g).count }}</span>
            </header>
            <TaskRows :nodes="g.nodes" :selected-id="selectedExternalId" @open="openTask" />
          </section>
        </template>

        <HydraSidebar v-if="hydraModel" :model="hydraModel" />

        <CloudList v-else-if="cloud.on.value" :selected-id="selectedExternalId" :tasks-of="nesting ? (id: string) => tasksOf(`cloud:${id}`) : undefined" :running="sessionRunning" :glyph="(id: string) => movingDots.get(id)" @open="openCloud" @open-task="openTask">
          <template #tools>
            <SidebarTools :search-open="searchOpen" :filter="filter" @search="searchOpen ? closeSearch() : openSearch()" @update:filter="(f: SidebarFilter) => (filter = f)" />
          </template>
        </CloudList>

        <template v-else>
        <!-- A folder whose last row went away fades and folds shut like the row (row-leave.ts). -->
        <TransitionGroup :css="false" @leave="rowLeave">
        <section v-for="(group, gi) in groupList" :key="group.key" :aria-label="group.label">
          <header
            class="group/head flex h-[34px] items-center gap-0 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted"
            :class="dropOn === groupOrderKey(group) && dragging !== dropOn && 'shadow-[inset_0_2px_0_var(--accent)]'"
            :draggable="draggable(group) && !filtering"
            @dragstart="onGroupDragStart($event, group)"
            @dragover="onGroupDragOver($event, group)"
            @dragleave="dropOn === groupOrderKey(group) && (dropOn = null)"
            @drop="onGroupDrop($event, group)"
            @dragend="onGroupDragEnd"
          >
            <Tip :label="group.cwd ?? ''" align="start">
              <button
                type="button"
                class="flex min-w-0 items-center gap-0.5 rounded-[4px] hover:text-text-2"
                :aria-expanded="!collapsed.has(group.key)"
                @click="toggleGroup(group.key)"
              >
                <span class="truncate">{{ group.label }}</span>
                <component
                  :is="shellGlyphs.groupChevron"
                  class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
                  :class="collapsed.has(group.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
                />
                <RunningBadge v-if="collapsed.has(group.key) && (runningInGroup(group) || chatsRunningIn(group))" class="ml-1" :tasks="runningInGroup(group)" :chats="chatsRunningIn(group)" />
              </button>
            </Tip>
            <span class="flex-1" />
            <Tip v-if="group.cwd" :label="`New session in ${group.label}`">
              <button type="button" :class="HEADER_BTN" :aria-label="`New session in ${group.label}`" @click="src.select({ kind: 'new', cwd: group.cwd })">
                <component :is="shellGlyphs.groupNew" class="size-4" />
              </button>
            </Tip>
            <template v-if="gi === 0">
              <SidebarTools :search-open="searchOpen" :filter="filter" @search="searchOpen ? closeSearch() : openSearch()" @update:filter="(f: SidebarFilter) => (filter = f)" />
            </template>
          </header>
          <TransitionGroup v-if="!collapsed.has(group.key)" tag="div" class="flex flex-col gap-[1.5px] pt-[1.5px]" :css="false" @leave="rowLeave">
            <div
              v-for="entry in group.entries"
              :key="`${entry.kind}:${entry.id}`"
              :data-search-cursor="cursorKey === `${entry.kind}:${entry.id}` || undefined"
              :class="cursorKey === `${entry.kind}:${entry.id}` ? 'rounded-[var(--radius-6)] bg-fill-hover' : ''"
            >
              <ChatRow
                v-if="entry.kind === 'chat'"
                :chat="entry.chat"
                :selected="selectedChatId === entry.id"
                :groups="groupNames"
                @select="src.select({ kind: 'chat', id: entry.id })"
                @action="(item: RowMenuItem) => act({ kind: 'chat', chat: entry.chat }, item)"
                @rename="(title: string) => mark({ kind: 'chat', chat: entry.chat }, { title })"
              />
              <ExternalRow
                v-else
                :session="entry.session"
                :selected="selectedExternalId === entry.id"
                :groups="groupNames"
                @select="openExternal(entry.session)"
                @action="(item: RowMenuItem) => act({ kind: 'external', session: entry.session }, item)"
                @rename="(title: string | null) => attempt('The change', src.updateSessionMeta(entry.id, { title }))"
              />
              <TaskRows v-if="tasksOf(`${entry.kind}:${entry.id}`)" :nodes="tasksOf(`${entry.kind}:${entry.id}`)!" :selected-id="selectedExternalId" @open="openTask" />
            </div>
          </TransitionGroup>
        </section>
        </TransitionGroup>

        <div v-if="groupList.length === 0" class="flex items-center gap-1 px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
          <span class="flex-1">{{ emptyText }}</span>
          <template v-if="filtering && !searchOpen">
            <button type="button" class="rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="filter = 'active'">Show active</button>
          </template>
        </div>

        <p v-if="rowError" role="alert" class="flex items-start gap-1 px-1.5 pt-3 text-[12px] leading-4 text-danger-text">
          <span class="min-w-0 flex-1">{{ rowError }}</span>
          <button type="button" aria-label="Dismiss" class="shrink-0 rounded-[4px] px-1 text-text-muted hover:bg-fill-hover hover:text-text" @click="rowError = null">
            <component :is="icons.dismiss" class="size-3" />
          </button>
        </p>

        <!-- AgentHydra's transcript search: sessions the query was said in, minus the rows above -->
        <section v-if="searchOpen && search.phase !== 'idle'" aria-label="Everywhere">
          <header class="flex h-[34px] items-center gap-1.5 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted">
            <span>Everywhere</span>
            <span
              v-if="search.phase === 'loading'"
              role="status"
              aria-label="Searching AgentHydra"
              class="size-2.5 animate-spin rounded-full border border-current border-t-transparent"
            />
          </header>
          <p v-if="search.phase === 'offline'" class="px-1.5 text-[12px] leading-4 text-text-muted">AgentHydra search is offline</p>
          <p v-else-if="search.phase === 'failed'" class="truncate px-1.5 text-[12px] leading-4 text-text-muted" :title="search.error ?? ''">
            AgentHydra search failed: {{ search.error }}
          </p>
          <p v-else-if="search.phase === 'done' && everywhere.length === 0" class="px-1.5 text-[12px] leading-4 text-text-muted">No matches</p>
          <div v-else class="flex flex-col gap-[1.5px] pt-[1.5px]">
            <SearchHitRow
              v-for="row in everywhere"
              :key="row.key"
              :hit="row.hit"
              :query="search.query"
              :active="cursorKey === row.key"
              :selected="row.view.kind === 'chat' ? selectedChatId === row.view.id : selectedExternalId === row.view.id"
              @select="src.select(row.view)"
            />
          </div>
        </section>
        </template>
      </div>
    </div>

    <!-- Footer: the profile pill opens the account popup above it; the gear opens Settings itself -->
    <footer class="flex h-11 shrink-0 items-center justify-between border-t border-border pb-px pl-2 pr-[10px]">
      <AccountsPopover v-model:open="accountsOpen" @settings="src.openSettings()">
        <button
          type="button"
          :aria-label="`Account for new chats: ${face.name}`"
          class="flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-[var(--radius-6)] pl-1 pr-1.5 transition-colors duration-[60ms] hover:bg-fill-hover data-[state=open]:bg-fill-hover"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--fill-secondary)] text-[10px] font-semibold leading-none text-text">{{ face.initial }}</span>
          <span class="truncate text-[13px] leading-[19.5px] text-text-2">{{ face.name }}</span>
          <span v-if="face.plan" class="shrink-0 text-[12px] leading-4 text-text-muted">· {{ face.plan }}</span>
          <component :is="icons.more" class="ml-2.5 size-3 shrink-0 text-text-muted" />
        </button>
      </AccountsPopover>
      <Tip label="Settings" side="top">
        <button type="button" aria-label="Settings" class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text" @click="src.openSettings()">
          <component :is="sidebarIcons.footer" class="size-4" />
        </button>
      </Tip>
    </footer>

    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabindex="0"
      :aria-valuenow="width"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="MAX_WIDTH"
      class="absolute -right-1.5 top-0 z-[22] h-full w-3 cursor-col-resize touch-none"
      @pointerdown.prevent="onResizeDown"
      @keydown="onResizeKey"
    />

    <Dialog :open="deleting !== null" @update:open="(o: boolean) => !o && (deleting = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-[var(--radius-12)] p-4 shadow-(--shadow-popover) ring-0 sm:max-w-[360px]">
        <DialogTitle class="text-[14px] font-semibold leading-5 text-text">Delete session?</DialogTitle>
        <DialogDescription class="text-[13px] leading-[19px] text-text-2">
          “{{ deleting?.title }}” will be removed from Hydra Desk. This cannot be undone.
        </DialogDescription>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="deleting = null">Cancel</button>
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-danger px-3 text-[13px] font-medium text-white hover:brightness-110" @click="confirmDelete">Delete</button>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog :open="naming !== null" @update:open="(o: boolean) => !o && (naming = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-[var(--radius-12)] p-4 shadow-(--shadow-popover) ring-0 sm:max-w-[360px]">
        <DialogTitle class="text-[14px] font-semibold leading-5 text-text">New group</DialogTitle>
        <DialogDescription class="sr-only">Name the group to move this session to.</DialogDescription>
        <form class="flex flex-col gap-3" @submit.prevent="confirmGroup">
          <Input v-model="groupDraft" aria-label="Group name" placeholder="Group name" :maxlength="GROUP_MAX" class="h-8 text-[13px]" />
          <div class="flex justify-end gap-2">
            <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="naming = null">Cancel</button>
            <button
              type="submit"
              :disabled="!groupName"
              class="h-7 rounded-[var(--radius-6)] bg-accent px-3 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              Move
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </aside>
</template>
