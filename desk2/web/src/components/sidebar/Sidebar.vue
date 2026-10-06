<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChatSummary, CliMayteWorker, CloudSession, ExternalSession, SessionMetaPatch, SwarmJob } from '@shared/protocol'
import { icons, shellGlyphs, sidebarIcons } from '@/lib/icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import AccountsPopover from '@/components/accounts/AccountsPopover.vue'
import { useShellSource } from '@/components/shell/source'
const CloudList = lazyPanel(() => import('@/components/cloud/CloudList.vue'))
import { useCloud } from '@/components/cloud/store'
import { ahSource, appShown } from '@/components/cloud/logic'
const HydraSidebar = lazyPanel(() => import('@/components/hydra/HydraSidebar.vue'))
import { actionError } from '@/lib/action-error'
import { lazyPanel } from '@/lib/lazy-panel'
import { useSwarmJobs } from '@/lib/swarm-jobs'
import { ahUpdateDot, hydraOpen, hydraShown, openSwarmInHydra, openWorkerInHydra } from '@/components/hydra/api'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { EyeOff } from '@lucide/vue'
import TaskRows from './TaskRows.vue'
import SubBadges from './SubBadges.vue'
import { expanded, rowSubItems, subModes } from './subitems'
import RunningBadge from './RunningBadge.vue'
import {
  addToCloudGroups,
  addToDeskGroups,
  addedStatus,
  addedPulse,
  isAddedRow,
  nestTasks,
  runningJobsIn,
  runningTasksIn,
  showTasks,
  type AddedRow,
  type KnownChat,
  type NestedTasks,
  type NestRow,
  type TaskNode
} from './tasks'
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
  externalGlyph,
  externalRow,
  groupChats,
  groupChoices,
  groupOrderKey,
  HIDE_TITLE,
  hideable,
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
  deskGlyphs,
  rowMenu,
  runPulse,
  SWARM_RUNNING,
  type ChatGroup,
  type RowMenuEntry,
  type RowMenuItem,
  type RowState,
  type StatusGlyph,
  type SidebarFilter,
  type SidebarGroups
} from './logic'
import { useSidebarOrder } from './order'
import { useHiddenGroups } from './hidden'
import { MENU_CONTENT, MENU_ITEM, focusFirstItem } from './menuClasses'
import { useRowDrag } from './rowDrag'
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

// 240, not the real app's 220: the chrome bar over it carries AgentHydra 2.0's four extra buttons.
const MIN_WIDTH = 240
const MAX_WIDTH = 420

const src = useShellSource()
const selected = computed(() => src.selected.value)
const selectedChatId = computed(() => (selected.value.kind === 'chat' ? selected.value.id : null))

const selectedExternalId = computed(() => (selected.value.kind === 'external' ? selected.value.id : null))
// The cloud list's rows are sessions: an open chat of Desk's own is the row of its session.
const selectedCloudId = computed(() => {
  const s = selected.value
  return s.kind === 'chat' ? (src.chats.value.find((c) => c.id === s.id)?.sessionId ?? null) : selectedExternalId.value
})
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
// (AgentHydra, if it is open, slides away: DeskFrame); a row added for running work opens what it stands for.
function openCloud(r: CloudSession) {
  const added = addedRows.value.get(r.id)
  if (added) openAdded(added)
  else src.select({ kind: 'external', id: r.id })
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

// While AgentHydra is open, a tab of it with a sidebar of its own (HSwarm's tree) has it drawn here.
const hydraModel = computed(() => hydraShown.value?.model ?? null)

// Groups hidden with their header's right-click (hidden.ts), out of the list unless the Filter menu's Show hidden.
const hiddenGroups = useHiddenGroups()

const groups = computed(() =>
  groupChats(src.chats.value, {
    query: query.value,
    filter: filter.value,
    external: src.external.value,
    // The Filter menu's Apps (cloud store scopes) narrow this list's outside sessions too; Claude alone by default.
    showApp: (s) => appShown(ahSource(s.source), cloud.scopes.value.apps),
    order: order.value,
    hidden: hiddenGroups.hidden.value,
    showHidden: hiddenGroups.showHidden.value
  })
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
/** The desk list's own groups, without the rows added for running work (`deskShown` below has those too). */
const ownGroups = computed<ChatGroup[]>(() => {
  const g = groups.value
  return [...(g.pinned ? [g.pinned] : []), ...g.folders, ...(g.archived ? [g.archived] : [])]
})
const filtering = computed(() => query.value.trim() !== '' || filter.value !== 'active')
// Rows drag to another place in their own group (rowDrag.ts); not while a search or a filter narrows the list.
const rowDrag = useRowDrag()
const rowsDraggable = (g: ChatGroup) => !filtering.value && g.key !== 'archived'
const rowLeave = leaveUnlessFiltered([query, filter])
const emptyText = computed(() =>
  query.value.trim()
    ? 'No matching sessions'
    : groups.value.hiddenOut
      ? 'Every group here is hidden'
      : filter.value === 'archived'
        ? 'No archived sessions'
        : 'No sessions yet'
)

// Hydra Desk 2: with the chrome bar's CliMayte button on, each row of the list shown (the cloud list or the
// desk list, the rows each draws) lists the CliMayte tasks it handed out under it, a manager's wave one step
// further in, each task once (tasks.ts), another PC's under its chat too (the chat sync brings that chat here
// with the same session id; owner, 2026-10-04: "Under the chat which spawned them. Not as its own stand alone
// table"). A running task no drawn row lists (its chat is another PC's and not synced here, nothing says which
// chat started it, or the filter or the list leaves that chat out) is still shown: the chat that started it,
// else the task itself, is added as a row of its folder's group, drawn as the list draws its own rows, another
// PC's with a cloud (owner, 2026-10-05: "I shouldn't even be able to tell the difference between ones on his
// computer and mine, besides them having a Cloud icon"), so every task AgentHydra's CliMayte list shows running
// is here (owner, 2026-10-05: "Is one smaller than six?"). The other PCs' tasks only with the cloud on (owner,
// 2026-10-05: "when cloud is turned off, it shouldn't show these"): the desk store keeps them apart from
// src.workers so they never count as this PC's (stores/desk.ts splitWorkers); a source without them (the
// Gallery) has none.
// HSwarm's jobs, pushed by the server into the desk store (lib/swarm-jobs.ts); the other PCs' only with the cloud on.
// The cloud list draws them under its rows as the desk list does (a running job whose caller no row is adds a row for it).
const swarmJobs = useSwarmJobs(cloud.on)
const remoteWorkers = computed(() => (cloud.on.value ? (src.remoteWorkers?.value ?? []) : []))
/**
 * Every chat the window knows by its session id: the cloud list's answer (the other PC's synced chats among
 * them), then this PC's outside sessions and chats, whose facts win as the desk list's. A row added for a chat
 * no drawn row is takes its title and folder from here.
 */
const knownChats = computed(() => {
  const out = new Map<string, KnownChat>()
  for (const r of cloud.sessions.value) out.set(r.id, { title: r.title, cwd: r.cwd, at: r.lastActivityAt })
  for (const s of src.external.value) if (s.source !== 'climayte') out.set(s.id, { title: s.title, cwd: s.cwd, at: s.lastActivityAt })
  for (const c of src.chats.value) if (c.sessionId) out.set(c.sessionId, { title: c.title, cwd: c.cwd || null, at: c.updatedAt })
  return out
})
const nesting = computed<NestedTasks | null>(() => {
  if (!showTasks.value) return null
  const workers = [...src.workers.value, ...remoteWorkers.value]
  const jobs = swarmJobs.value
  if (cloud.on.value) return nestTasks(cloud.groups.value.flatMap((g) => g.rows.map((r) => ({ key: `cloud:${r.id}`, sessionIds: [r.id] }))), workers, jobs, knownChats.value)
  // The rows the desk list draws of its own, as groupChats picks them (never a CliMayte worker's own session, nor
  // a session that is one of our chats); a row in a folded group still holds its tasks, and the group's heading
  // counts the running ones (RunningBadge). A chat stands for its worker by id too, so one still queued (no
  // session yet) is not listed again as a task.
  const rows: NestRow[] = ownGroups.value.flatMap((g) =>
    g.entries.map((e) =>
      e.kind === 'chat'
        ? { key: `chat:${e.id}`, sessionIds: e.chat.sessionId ? [e.chat.sessionId] : [], workerId: e.chat.workerId }
        : { key: `external:${e.id}`, sessionIds: [e.session.id] }
    )
  )
  return nestTasks(rows, workers, jobs, knownChats.value)
})
/** The rows added for running work no drawn row lists (tasks.ts AddedRow), by id. */
const addedRows = computed(() => new Map((nesting.value?.added ?? []).map((a) => [a.id, a])))
/** The added row a row key (`external:` or `cloud:`, then its id) is, if any. */
const addedAt = (key: string) => addedRows.value.get(key.slice(key.indexOf(':') + 1))
const tasksOf = (key: string) => nesting.value?.byRow.get(key) ?? addedAt(key)?.nodes ?? null
const jobsOf = (key: string) => nesting.value?.jobsByRow.get(key) ?? addedAt(key)?.jobs ?? null
/** An added row that is itself a running HSwarm job no chat is known to have called: its dot pulses blue and a folded heading counts it with the jobs. */
const jobRow = (a: AddedRow | undefined): boolean => !!a?.job?.active && !a.worker
/** The HSwarm jobs a folded group's heading counts under a row: its jobs, and the job an added row is itself. */
const jobsCounted = (key: string): SwarmJob[] | null => {
  const a = addedAt(key)
  return jobRow(a) ? [a!.job!, ...(jobsOf(key) ?? [])] : jobsOf(key)
}
/** What a row draws of its tasks and jobs: lines, a badge, or both once the badge is opened (subitems.ts). */
const subOf = (key: string, tasks: TaskNode[] | null, jobs: SwarmJob[] | null) => rowSubItems(key, tasks, jobs, { tasks: subModes.tasks.value, jobs: subModes.jobs.value }, expanded.value)
const rowSub = (key: string) => subOf(key, tasksOf(key), jobsOf(key))

// The desk list as drawn: its own groups and, while the cloud is off, the rows added for this PC's running work
// no row of it lists, each in its folder's group among the list's own rows (tasks.ts addToDeskGroups); not while
// a search or the Archived filter narrows it to the rows it matches.
const deskShown = computed<SidebarGroups>(() => {
  const g = groups.value
  const added = cloud.on.value || query.value.trim() || filter.value === 'archived' ? [] : (nesting.value?.added ?? []).filter((a) => !a.pc)
  if (!added.length) return g
  return { ...g, folders: addToDeskGroups(g.folders, added, { order: order.value, hidden: hiddenGroups.hidden.value, showHidden: hiddenGroups.showHidden.value }) }
})
const groupList = computed<ChatGroup[]>(() => {
  const g = deskShown.value
  return [...(g.pinned ? [g.pinned] : []), ...g.folders, ...(g.archived ? [g.archived] : [])]
})
// A group or row the plain list shows that the order lacks joins it at the top, so it keeps the place it
// appeared in, and so does one only the cloud list had shown (recordDeskOrder); any other saved one never
// moves; a row that just turned orange goes to the top of its group. An added row joins as a new row does; a
// group only added rows make stays after the list's own (tasks.ts), so it is not recorded.
const wasOrange = new Map<string, boolean>()
watch(
  deskShown,
  (g) => {
    if (query.value.trim() || filter.value !== 'active') return
    const shownEntries = [...(g.pinned?.entries ?? []), ...g.folders.flatMap((f) => f.entries)]
    const shownGroups = g.folders.filter((f) => !f.entries.every((e) => isAddedRow(e.id))).map(groupOrderKey)
    const shownRows = shownEntries.map((e) => e.id)
    const next = recordDeskOrder(order.value, shownGroups, shownRows)
    const rows = raiseNewlyOrange(next.rows, shownEntries, wasOrange)
    for (const e of shownEntries) wasOrange.set(e.id, isOrange(e))
    saveOrder({ ...next, rows })
  },
  { immediate: true }
)
// The cloud list as drawn: the store's groups and the rows added for running work no row of it lists, both PCs',
// each in its folder's group among the list's own rows (tasks.ts addToCloudGroups); not while a search answers it,
// and another PC's not while the Computer filter (Show only local) leaves that PC's rows out, as it does the list's own.
const cloudGroups = computed(() => {
  const pcs = cloud.scopes.value.pcs
  const added = cloud.search.value.trim() ? [] : (nesting.value?.added ?? []).filter((a) => pcs === null || pcs.includes(a.pc ?? cloud.thisPc.value))
  if (!cloud.on.value || !added.length) return cloud.groups.value
  return addToCloudGroups(cloud.groups.value, added, {
    order: order.value,
    hidden: hiddenGroups.hidden.value,
    showHidden: hiddenGroups.showHidden.value,
    orderKey: cloud.orderKey,
    onDesk: cloud.onDesk
  })
})

/** The running CliMayte tasks and HSwarm jobs under a desk-list group's rows, and its rows that run, for its heading while it is folded. */
const foldedRunning = computed(() => {
  const out = new Map<string, { tasks: number; jobs: number; chats: number }>()
  for (const g of groupList.value) {
    if (!collapsed.value.has(g.key)) continue
    const tasks = runningTasksIn(g.entries.map((e) => tasksOf(`${e.kind}:${e.id}`)))
    const jobs = runningJobsIn(g.entries.map((e) => jobsCounted(`${e.kind}:${e.id}`)))
    const chats = g.entries.filter((e) => entryRunning(e) && !jobRow(addedRows.value.get(e.id))).length
    if (tasks || jobs || chats) out.set(g.key, { tasks, jobs, chats })
  }
  return out
})
/** An added row's state, as its dot shows it (tasks.ts addedStatus); null for any other row. */
const addedState = (id: string) => {
  const a = addedRows.value.get(id)
  return a ? addedStatus(a) : null
}
/** The cloud list's rows that run: the ones the desk knows as running, and the added rows whose worker runs (one that is a job counts with the jobs). */
const runningSessions = computed(() => runningSessionIds(src.chats.value, src.external.value))
const sessionRunning = (id: string) => runningSessions.value.has(id) || (addedState(id) === 'working' && !jobRow(addedRows.value.get(id)))
const deskDots = computed(() => deskGlyphs(src.chats.value, src.external.value))
/**
 * An added row's dot, in both lists: a session's dot for its state (addedStatus), save that a row that is itself a
 * running HSwarm job pulses blue as the job's line does, blue being HSwarm's alone (owner, 2026-10-05). Undefined
 * for any other row.
 */
const addedGlyph = (id: string): StatusGlyph | undefined => {
  const a = addedRows.value.get(id)
  if (!a) return undefined
  return jobRow(a) ? SWARM_RUNNING : externalGlyph({ status: addedStatus(a), unread: false })
}
/** A cloud row's dot: an added row's, or its desk row's. */
const cloudDot = (id: string) => addedGlyph(id) ?? deskDots.value.get(id)
/** How an added row's cloud pulses, from the work it stands for and lists (tasks.ts addedPulse); undefined for any other row. */
const cloudPulse = (id: string) => {
  const a = addedRows.value.get(id)
  return a ? addedPulse(a) : undefined
}
/** An HSwarm job opens on AgentHydra's HSwarm page, selected in its list (the id goes to App.vue's deskSwarmAsk watch). */
const openJob = (j: SwarmJob) => openSwarmInHydra(j.id)
/** A task with a session here opens its transcript; one still queued, or another PC's, opens on CliMayte's tab. */
function openTask(w: CliMayteWorker) {
  if (w.sessionId && !w.pc) src.select({ kind: 'external', id: w.sessionId })
  else openWorkerInHydra(w.id, w.pc)
}
/**
 * An added row opens what it stands for: its worker or its job, this PC's chat (a Desk chat, else its
 * session's transcript), else, another PC's chat, its first task or job there.
 */
function openAdded(a: AddedRow) {
  if (a.worker) return openTask(a.worker)
  if (a.job) return openJob(a.job)
  if (a.sessionId && !a.pc) {
    const chat = src.chats.value.find((c) => c.sessionId === a.sessionId)
    if (chat) src.select({ kind: 'chat', id: chat.id })
    else src.select({ kind: 'external', id: a.sessionId })
    return
  }
  const first = a.nodes[0]?.worker
  if (first) openTask(first)
  else if (a.jobs[0]) openJob(a.jobs[0])
}

// The chosen chat lands visibly: its group opens and its row scrolls into view (a new chat is the
// first row of its group). One the filter or the search hides (a chat started while Archived is on)
// brings the list that shows it back, and one in a hidden group turns Show hidden on (its group stays
// hidden for when that goes off again); one picked from the Everywhere rows leaves the search as it is.
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
    if (!group && groups.value.hiddenOut) {
      hiddenGroups.setShowHidden(true)
      group = groupOf(id)
    }
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
    const view = targets.value[Math.max(0, cursorAt.value)]?.view
    // A row added for running work is no session of its own: it opens what it stands for, as its click does.
    const added = view?.kind === 'external' ? addedRows.value.get(view.id) : undefined
    if (added) openAdded(added)
    else if (view) src.select(view)
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
const rowError = actionError
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
/** The desk row a session is, when the desk list shows it: a chat of ours by its session, else an outside session. */
function deskRowOf(id: string): Row | null {
  const chat = src.chats.value.find((c) => c.sessionId === id)
  if (chat) return { kind: 'chat', chat }
  const session = src.external.value.find((s) => s.id === id && s.source !== 'climayte')
  return session ? { kind: 'external', session } : null
}
/** An added row's menu: Open, and Copy session ID when it has one; none of a session's marks, which it is not. */
function addedMenu(a: AddedRow): RowMenuEntry[] {
  const out: RowMenuEntry[] = [{ action: 'open', label: 'Open' }]
  if (a.sessionId) out.push({ action: 'copySessionId', label: 'Copy session ID' })
  return out
}
function addedAct(a: AddedRow, item: RowMenuItem) {
  if (item.action === 'open') openAdded(a)
  else if (item.action === 'copySessionId' && a.sessionId) attempt('Copy', navigator.clipboard.writeText(a.sessionId))
}
/** A cloud row's menu: its desk row's (without Rename, which the row does inline), or Open, Pin and Copy session ID for one only the cloud list has. */
function cloudMenu(r: CloudSession): RowMenuEntry[] {
  const added = addedRows.value.get(r.id)
  if (added) return addedMenu(added)
  const row = deskRowOf(r.id)
  if (!row) {
    return [
      { action: 'open', label: 'Open' },
      'separator',
      { action: 'pin', label: 'Pin', shortcut: 'P' },
      { action: 'copySessionId', label: 'Copy session ID' }
    ]
  }
  return rowMenu(stateOf(row), groupNames.value).filter((e) => e === 'separator' || !('action' in e) || e.action !== 'rename')
}
function cloudAct(r: CloudSession, item: RowMenuItem) {
  const added = addedRows.value.get(r.id)
  if (added) return addedAct(added, item)
  const row = deskRowOf(r.id)
  if (row) return item.action === 'open' ? openCloud(r) : act(row, item)
  if (item.action === 'open') openCloud(r)
  else if (item.action === 'pin') attempt('The change', src.updateSessionMeta(r.id, { pinned: true }))
  else if (item.action === 'copySessionId') attempt('Copy', navigator.clipboard.writeText(r.id))
}
/** Opening an outside session reads it, as opening a chat does. */
function openExternal(s: ExternalSession) {
  src.select({ kind: 'external', id: s.id })
  if (s.unread) mark({ kind: 'external', session: s }, { unread: false })
}
/** A desk-list row of an outside session: an added one (tasks.ts addedEntry) opens and acts as what it stands for, any other as its session. */
function selectExternal(s: ExternalSession) {
  const added = addedRows.value.get(s.id)
  if (added) openAdded(added)
  else openExternal(s)
}
function externalAct(s: ExternalSession, item: RowMenuItem) {
  const added = addedRows.value.get(s.id)
  if (added) addedAct(added, item)
  else act({ kind: 'external', session: s }, item)
}
function renameExternal(s: ExternalSession, title: string | null) {
  if (!isAddedRow(s.id)) attempt('The change', src.updateSessionMeta(s.id, { title }))
}
/** An added row's menu in place of an outside session's; undefined for any other row. */
function externalMenu(id: string): RowMenuEntry[] | undefined {
  const added = addedRows.value.get(id)
  return added ? addedMenu(added) : undefined
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
function confirmDelete() {
  const chat = deleting.value
  deleting.value = null
  if (!chat) return
  if (selectedChatId.value === chat.id) src.select({ kind: 'new' })
  attempt('Delete', src.removeChat(chat.id))
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
  chatAction: (chat: ChatSummary, item: RowMenuItem) => act({ kind: 'chat', chat }, item),
  /** The title bar's rename: a failure shows in the same alert as a row's. */
  renameChat: (chat: ChatSummary, title: string) => mark({ kind: 'chat', chat }, { title })
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

        <HydraSidebar v-if="hydraModel" :model="hydraModel" :stale="hydraShown?.stale" />

        <CloudList v-else-if="cloud.on.value" :groups="cloudGroups" :selected-id="selectedCloudId" @new-session="(cwd: string) => src.select({ kind: 'new', cwd })" :tasks-of="nesting ? (id: string) => tasksOf(`cloud:${id}`) : undefined" :shown-of="nesting ? (id: string) => rowSub(`cloud:${id}`).nodes : undefined" :jobs-of="nesting ? (id: string) => jobsCounted(`cloud:${id}`) : undefined" :shown-jobs-of="nesting ? (id: string) => rowSub(`cloud:${id}`).jobs : undefined" :running="sessionRunning" :glyph="cloudDot" :pulse="cloudPulse" :menu-for="cloudMenu" @action="cloudAct" @open="openCloud" @open-task="openTask" @open-job="openJob">
          <template #sub-badges="{ id }">
            <SubBadges v-if="nesting" :row-key="`cloud:${id}`" :badges="rowSub(`cloud:${id}`).badges" />
          </template>
          <template #tools>
            <SidebarTools :search-open="searchOpen" :filter="filter" @search="searchOpen ? closeSearch() : openSearch()" @update:filter="(f: SidebarFilter) => (filter = f)" />
          </template>
        </CloudList>

        <template v-else>
        <!-- A folder whose last row went away fades and folds shut like the row (row-leave.ts). -->
        <TransitionGroup :css="false" @leave="rowLeave">
        <section v-for="(group, gi) in groupList" :key="group.key" :aria-label="group.label">
          <!-- A project group's right-click hides it (hidden.ts); Show hidden in the Filter menu brings it back, dimmed, with Unhide. -->
          <ContextMenu>
          <ContextMenuTrigger as-child :disabled="!hideable(group)">
          <header
            class="group/head flex h-[34px] items-center gap-0 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted"
            :class="[dropOn === groupOrderKey(group) && dragging !== dropOn && 'shadow-[inset_0_2px_0_var(--accent)]', group.hidden && 'opacity-60']"
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
                <EyeOff v-if="group.hidden" role="img" aria-label="Hidden group" class="ml-0.5 size-3 shrink-0" />
                <component
                  :is="shellGlyphs.groupChevron"
                  class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
                  :class="collapsed.has(group.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
                />
                <RunningBadge v-if="foldedRunning.get(group.key)" class="ml-1" :tasks="foldedRunning.get(group.key)!.tasks" :jobs="foldedRunning.get(group.key)!.jobs" :chats="foldedRunning.get(group.key)!.chats" />
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
          </ContextMenuTrigger>
          <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
            <ContextMenuItem :class="MENU_ITEM" :title="group.hidden ? undefined : HIDE_TITLE" @select="hiddenGroups.hide(groupOrderKey(group), !group.hidden)">
              <span class="flex-1">{{ group.hidden ? 'Unhide' : 'Hide' }}</span>
            </ContextMenuItem>
          </ContextMenuContent>
          </ContextMenu>
          <TransitionGroup v-if="!collapsed.has(group.key)" tag="div" class="flex flex-col gap-[1.5px] pt-[1.5px]" :css="false" @leave="rowLeave">
            <div
              v-for="entry in group.entries"
              :key="`${entry.kind}:${entry.id}`"
              :data-search-cursor="cursorKey === `${entry.kind}:${entry.id}` || undefined"
              :class="[cursorKey === `${entry.kind}:${entry.id}` ? 'rounded-[var(--radius-6)] bg-fill-hover' : '', rowDrag.line(entry.id)]"
              :draggable="rowsDraggable(group)"
              @dragstart="rowsDraggable(group) && rowDrag.start($event, group.key, entry.id)"
              @dragover="rowsDraggable(group) && rowDrag.onOver($event, group.key, entry.id)"
              @drop="rowsDraggable(group) && rowDrag.drop($event, group.key, group.entries.map((e) => e.id), entry.id)"
              @dragend="rowDrag.end"
            >
              <ChatRow
                v-if="entry.kind === 'chat'"
                :chat="entry.chat"
                :selected="selectedChatId === entry.id"
                :groups="groupNames"
                @select="src.select({ kind: 'chat', id: entry.id })"
                @action="(item: RowMenuItem) => act({ kind: 'chat', chat: entry.chat }, item)"
                @rename="(title: string) => mark({ kind: 'chat', chat: entry.chat }, { title })"
              >
                <SubBadges v-if="rowSub(`chat:${entry.id}`).badges.length" :row-key="`chat:${entry.id}`" :badges="rowSub(`chat:${entry.id}`).badges" />
              </ChatRow>
              <ExternalRow
                v-else
                :session="entry.session"
                :selected="selectedExternalId === entry.id"
                :groups="groupNames"
                :entries="externalMenu(entry.id)"
                :dot="addedGlyph(entry.id)"
                @select="selectExternal(entry.session)"
                @action="(item: RowMenuItem) => externalAct(entry.session, item)"
                @rename="(title: string | null) => renameExternal(entry.session, title)"
              >
                <SubBadges v-if="rowSub(`external:${entry.id}`).badges.length" :row-key="`external:${entry.id}`" :badges="rowSub(`external:${entry.id}`).badges" />
              </ExternalRow>
              <TaskRows v-if="rowSub(`${entry.kind}:${entry.id}`).nodes.length || rowSub(`${entry.kind}:${entry.id}`).jobs.length" :nodes="rowSub(`${entry.kind}:${entry.id}`).nodes" :jobs="rowSub(`${entry.kind}:${entry.id}`).jobs" :selected-id="selectedExternalId" @open="openTask" @open-job="openJob" />
            </div>
          </TransitionGroup>
        </section>
        </TransitionGroup>

        <div v-if="groupList.length === 0" class="flex items-center gap-1 px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
          <span class="flex-1">{{ emptyText }}</span>
          <template v-if="filtering && !searchOpen">
            <button type="button" class="rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="filter = 'active'">Show active</button>
          </template>
          <button v-if="groups.hiddenOut" type="button" class="rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="hiddenGroups.setShowHidden(true)">Show hidden</button>
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
            <!-- A gray pulsing dot, not a spinner: nothing in the sidebar spins (owner, 2026-10-05). -->
            <span
              v-if="search.phase === 'loading'"
              role="status"
              aria-label="Searching AgentHydra"
              class="size-1.5 rounded-full bg-current"
              :class="runPulse('gray')"
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
        <p v-if="cloud.on.value && !hydraModel && rowError" role="alert" class="flex items-start gap-1 px-1.5 pt-3 text-[12px] leading-4 text-danger-text">
          <span class="min-w-0 flex-1">{{ rowError }}</span>
          <button type="button" aria-label="Dismiss" class="shrink-0 rounded-[4px] px-1 text-text-muted hover:bg-fill-hover hover:text-text" @click="rowError = null">
            <component :is="icons.dismiss" class="size-3" />
          </button>
        </p>
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
      <Tip :label="ahUpdateDot ? 'Settings: an AgentHydra update is waiting' : 'Settings'" side="top">
        <button
          type="button"
          aria-label="Settings"
          :aria-description="ahUpdateDot ? 'An AgentHydra update is waiting' : undefined"
          class="relative flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text"
          @click="src.openSettings()"
        >
          <component :is="sidebarIcons.footer" class="size-4" />
          <span v-if="ahUpdateDot" class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />
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
