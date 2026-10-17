<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect, type Ref } from 'vue'
import { ArrowLeft } from '@lucide/vue'
import type { ChatSummary, TranscriptIndex, TranscriptItem } from '@shared/protocol'
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { accountFace, groupChoices, type RowMenuItem } from '@/components/sidebar/logic'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import Composer from '@/components/composer/Composer.vue'
import { OPEN_CLIMAYTE_EVENT, OPEN_DIFF_EVENT, OPEN_REPOYETI_EVENT } from '@/components/composer/api'
import { OPEN_BROWSER_EVENT, type BrowserOpenRequest } from '@shared/browser'
import { lastBrowserRequest } from '@/components/transcript/lib/tools'
const CliMaytePanel = lazyPanel(() => import('@/components/climayte/CliMaytePanel.vue'))
const ChangesPane = lazyPanel(() => import('@/components/panes/ChangesPane.vue'))
const ServersPane = lazyPanel(() => import('@/components/servers/ServersPane.vue'))
const loadInfoPane = () => import('@/components/servers/info/InfoPane.vue')
const InfoPane = lazyPanel(loadInfoPane)
const ConnectionsPane = lazyPanel(() => import('@/components/connectors/ConnectionsPane.vue'))
const FourmanPane = lazyPanel(() => import('@/components/fourman/FourmanPane.vue'))
import type { ServerFocus } from '@/components/servers/store'
import type { DevSelection } from '@/components/servers/info/selection'
const loadSettingsView = () => import('@/components/panes/SettingsView.vue')
const SettingsView = lazyPanel(loadSettingsView)
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
// Loaded on first use, so their chunks stay out of the files the window loads before its first paint.
const ExternalSessionView = lazyPanel(() => import('@/components/external/ExternalSessionView.vue'))
const HydraPane = lazyPanel(() => import('@/components/hydra/HydraPane.vue'))
import { OPEN_HYDRA_EVENT, hydraOpen, hydraShown } from '@/components/hydra/api'
import { useCloud } from '@/components/cloud/store'
import { useDevServers } from '@/components/servers/store'
import { closeDashboard, dashboardCwd, dashboardOpen, dashboardTab } from '@/components/dashboard/store'
import { startFourman, todoRequest, todoShowing } from '@/components/fourman/store'
import { browserRequest } from '@/components/servers/browser-request'
const DashboardPage = lazyPanel(() => import('@/components/dashboard/DashboardPage.vue'))
import { setChatLive } from '@/components/servers/background-views'
import { showTasks } from '@/components/sidebar/tasks'
import { cleanSidebar } from '@/components/sidebar/clean'
import { compactSidebar } from '@/components/sidebar/compact'
import { CHROME_COLLAPSED, COMPACT_WIDTH, SIDEBAR_WIDTH_KEY, chromeOverhang, drawerWidth, savedSidebarWidth } from '@/components/sidebar/width'
const BackgroundTasksPanel = lazyPanel(() => import('@/components/tasks/BackgroundTasksPanel.vue'))
import { OPEN_TASKS_EVENT, cleared, outsideTasks, type OpenTasksDetail } from '@/components/tasks/api'
import { panelLists } from '@/components/tasks/logic'
import { sessionTasks } from '@/components/tasks/session'
import { useDesk } from '@/stores/desk'
import { PUT_BACK_EVENT, type PutBack } from '@/components/composer/draft-images'
import { putBackDraft } from '@/components/composer/change-project'
import { loadDraft, saveDraft } from '@/components/composer/logic'
import { readOnlyChild, LOCKED_TITLE } from './readonly-child'
import ChromeBar from './ChromeBar.vue'
import WindowControls from './WindowControls.vue'
import { CAPTION_W, appFocused, canCollapse, collapseWindow, collapsed, expandWindow, ownFrame, startOwnFrame } from '@/lib/host-window'
import { chatAction, focusAction, modeAction } from '@/components/sidebar/collapse'
import { setSidebarSide, sidebarSide, type SidebarSide } from '@/components/sidebar/side'
import ShellHeader, { type RightPane } from './ShellHeader.vue'
import WhatsNewDialog from './WhatsNewDialog.vue'
import PeopleFirstRun from '@/components/people/PeopleFirstRun.vue'
import { changesTabFor } from '@/components/connectors/logic'
import { changesTab, repoYeti, setChangesTab } from '@/components/connectors/repoyeti-state'
import NewSessionScreen from './NewSessionScreen.vue'
import { CHAT_DEFAULT, CHAT_MIN, NavHistory, RAIL_INSET, RAIL_MAX, RAIL_MIN, archivedNotice, SidebarPeek, chatViewOf, matchShortcut, railReserve, railWidthIn, splitChat, splitColumns, unreadHold, viewUnder, type View } from './logic'
const SessionRail = lazyPanel(() => import('@/components/rail/SessionRail.vue'))
import { railOpen, railWidth, saveRailWidth } from '@/components/rail/state'
import { headerPeek } from '@/components/session-header/state'
import { useElementSize, useWindowSize } from '@vueuse/core'
import { rememberScreen, restoreScreen, type ScreenMemory } from '@/lib/view-memory'
import { useShellSource } from './source'
import { externalIndexBySession } from '@/components/external/paging'
import { restartServer, updateOffer } from '@/lib/server-update'
import { lazyPanel, prefetchPanels } from '@/lib/lazy-panel'
import { waitForNextPaint } from '@/lib/wait-for-next-paint'
import { requestedSection } from '@/components/panes/settings-request'
import type { SettingsSection } from '@/components/panes/settings'
import { actionError } from '@/lib/action-error'

// The whole window: sidebar (294, resizable from 200 to 420), the chrome bar over its top, and the pane with the
// title bar, the view, the composer and an optional right pane.
const props = defineProps<{
  /** Gallery only: the composer renders from fixtures. */ demo?: boolean
  /** Gallery only: the account popup starts open. */ accountsOpen?: boolean
  /** Gallery only: the sidebar starts hidden. */ sidebarHidden?: boolean
  /** Gallery and parity only: views visited before the current one, so Alt + Left has somewhere to go. */ history?: View[]
}>()

// The lazy-loading members the store (and the parity scene's source) carry beyond ShellSource.
type LazyMembers = {
  indexByChat?: Readonly<Ref<ReadonlyMap<string, TranscriptIndex>>>
  loadOlder?(id: string): Promise<number>
  hasOlder?(id: string): boolean
}
const src = useShellSource() as ReturnType<typeof useShellSource> & LazyMembers
// A reload (a right-click Refresh, a new build) comes back to the same screen: the store keeps Desk's view,
// and the rest is kept here (lib/view-memory.ts): the view under Settings, the AgentHydra pane, the Settings
// page. The demo window starts from its props.
const kept: ScreenMemory = props.demo ? {} : restoreScreen()
// Settings is a dialog over the window: under it stays the last other view, and closing it (Esc, the X)
// selects that view again.
const under = ref<View>(src.selected.value.kind === 'settings' ? (props.history?.at(-1) ?? kept.under ?? { kind: 'new' }) : src.selected.value)
watch(
  () => src.selected.value,
  (v) => {
    if (v.kind !== 'settings') under.value = v
  }
)
watch(under, (v) => !props.demo && rememberScreen({ under: v }), { immediate: true })
// SettingsView checks the page is still one of its own.
if (!props.demo && src.selected.value.kind === 'settings' && kept.section) requestedSection.value = kept.section as SettingsSection
const view = computed<View>(() => chatViewOf(viewUnder(src.selected.value, under.value), src.chats.value))
// Opening a new session (the plus button, a folder's +, Ctrl+N, the menu) puts the caret in its box and
// keeps it there while a closing menu hands focus back to its trigger (lib/hold-focus.ts).
const composer = ref<{ focus: () => void } | null>(null)
watch(
  () => src.selected.value,
  (v) => {
    if (v.kind === 'new') void nextTick(() => composer.value?.focus())
  }
)
const settingsOpen = computed(() => src.selected.value.kind === 'settings')
const closeSettings = () => src.select(under.value)
// The dialog opens on its current section, not on the Search box (the real one shows no focus ring there).
const focusSettingsNav = async (e: Event) => {
  e.preventDefault()
  const box = e.target as HTMLElement | null
  // SettingsView loads on first open: wait (bounded, ~2 s) until it has rendered its nav before focusing it.
  await loadSettingsView().catch(() => {}) // floor-ok: a failed load leaves the dialog as it is; lazyPanel sends it to the stale-bundle check
  for (let i = 0; i < 120; i++) {
    const nav = box?.querySelector<HTMLElement>('[data-section][aria-current="page"]')
    if (nav) return nav.focus()
    await waitForNextPaint()
  }
}
// A browser tab that kept playing in the background of another chat closes when that chat is archived or deleted.
watch(
  () => [src.chats.value, src.external.value] as const,
  ([chats, outside]) =>
    setChatLive((id) => {
      if (id.startsWith('external:')) return !outside.find((s) => s.id === id.slice('external:'.length))?.archived
      return chats.length === 0 || !!chats.find((c) => c.id === id && !c.archived)
    }),
  { immediate: true }
)
const chat = computed<ChatSummary | null>(() => {
  const v = view.value
  return v.kind === 'chat' ? (src.chats.value.find((c) => c.id === v.id) ?? null) : null
})
// A chat view whose chat is gone (deleted, or nothing picked yet) is the new-session screen.
const isNew = computed(() => view.value.kind === 'new' || (view.value.kind === 'chat' && !chat.value))
const items = computed(() => (chat.value ? (src.itemsByChat.value.get(chat.value.id) ?? []) : []))
// Items the server holds above the loaded ones (the index's total less what is loaded): counted in the transcript's
// scrollbar, and the page above is fetched as the view nears them. A fetch that adds nothing is not asked again until
// the loaded items change, so a failing route is not hit in a loop.
const loadingOlder = ref(false)
const olderStalledAt = ref<{ id: string; n: number } | null>(null)
const olderCount = computed(() => {
  const id = chat.value?.id
  if (!id || !src.hasOlder?.(id)) return 0
  if (olderStalledAt.value?.id === id && olderStalledAt.value.n === items.value.length) return 0
  return Math.max(0, (src.indexByChat?.value.get(id)?.total ?? 0) - items.value.length)
})
const fetchChatItem = async (id: string): Promise<TranscriptItem | null> => {
  if (!chat.value) return null
  const res = await fetch(`/api/chats/${encodeURIComponent(chat.value.id)}/items/${encodeURIComponent(id)}`)
  return res.ok ? ((await res.json()) as TranscriptItem) : null
}
async function loadOlder() {
  const id = chat.value?.id
  if (!id || loadingOlder.value || !src.loadOlder) return
  loadingOlder.value = true
  const had = items.value.length
  try {
    if ((await src.loadOlder(id)) <= 0) olderStalledAt.value = { id, n: had }
  } catch {
    olderStalledAt.value = { id, n: had } // floor-ok: the rows show as they are; the next change of them asks again
  } finally {
    loadingOlder.value = false
  }
}
// The Background tasks panel for an outside session: its id, and the transcript its view published.
const outsideId = computed(() => (view.value.kind === 'external' ? view.value.id : null))
const tasksSessionId = computed(() => outsideId.value ?? chat.value?.sessionId)
const tasksItems = computed(() =>
  outsideId.value ? (outsideTasks.value?.sessionId === outsideId.value ? outsideTasks.value.items : []) : items.value
)
const tasksIndex = computed(() => (outsideId.value ? externalIndexBySession.get(outsideId.value) : chat.value ? src.indexByChat?.value.get(chat.value.id) : null) ?? null)
const tasksWorkerIds = computed(() => (outsideId.value ? undefined : chat.value?.workerIds))

// The list of outside sessions holds the last 24 hours; a search hit can open an older one, which is
// fetched on its own. Unknown to AgentHydra (404), the pane keeps its read-only fallback.
const fetchingSession = ref<string | null>(null)
watch(
  () => {
    const v = view.value
    return v.kind === 'external' ? v.id : null
  },
  async (id) => {
    if (!id || !src.ensureExternal || src.external.value.some((s) => s.id === id)) return
    fetchingSession.value = id
    try {
      await src.ensureExternal(id)
    } catch {
      // floor-ok: a 404 or a dead server leaves the pane as it was before the fetch; the next open asks again.
    } finally {
      if (fetchingSession.value === id) fetchingSession.value = null
    }
  },
  { immediate: true }
)

const viewTitle = computed(() => {
  const v = view.value
  if (v.kind === 'external') return src.external.value.find((s) => s.id === v.id)?.title ?? (fetchingSession.value === v.id ? 'Loading session…' : 'Session')
  return ''
})

const greetingName = computed(() => {
  const id = src.settings.value?.defaultAccountId ?? 'auto'
  return id === 'auto' ? '' : accountFace(id, src.accounts.value).name
})

// Sidebar
const storage = typeof localStorage === 'undefined' ? null : localStorage
const sidebarWidth = ref(savedSidebarWidth(storage?.getItem(SIDEBAR_WIDTH_KEY)))
// Open or hidden (header toggle, Ctrl+B), remembered; it slides 300ms on the snap ease.
const OPEN_KEY = 'hydra-desk.sidebar.open'
const sidebarOpen = ref(props.sidebarHidden ? false : storage?.getItem(OPEN_KEY) !== '0')
// Under COMPACT_WIDTH (a phone's 375px) there is no room for the sidebar beside the chat, so it is a drawer over the chat
// (sidebar/width.ts): shut until its toggle opens it, shut again once anything is picked, the scrim beside it is tapped or Esc is
// pressed, and never saved, so the docked sidebar a wide window remembers is untouched. The session rail lies over the chat
// there too, shut until its button asks for it (railNarrow), and a right pane takes the chat's place (paneNarrow, below). All three
// start shut each time the window turns narrow.
const { width: windowWidth } = useWindowSize()
const narrow = computed(() => !collapsed.value && windowWidth.value < COMPACT_WIDTH)
const drawer = ref(false)
const railNarrow = ref(false)
const paneNarrow = ref<RightPane | null>(null)
watch(narrow, () => {
  drawer.value = false
  railNarrow.value = false
  paneNarrow.value = null
})
/** The sidebar holds its column: open, on a window wide enough for it and the chat. */
const docked = computed(() => sidebarOpen.value && !narrow.value)
const shownWidth = computed(() => (narrow.value ? drawerWidth(sidebarWidth.value, windowWidth.value) : sidebarWidth.value))
// The slide moves layers, never a width (owner, 2026-10-08: "the sidebar does not animate open/closed"): animating
// the column's width laid the whole chat out again on every frame, which a real transcript cannot do in 16ms, so it
// jumped. While it slides the sidebar lies over the stage and both move by transform, the stage at the window's
// full width; the grid takes its new columns once, when the slide ends. 'from' is drawn first with no transition,
// 'to' animates. Pinning the hover flyout slides the stage alone: the sidebar is already on screen.
const slide = ref<{ open: boolean; pin: boolean; at: 'from' | 'to' } | null>(null)
const sliding = computed(() => slide.value !== null)
let slideTimer: ReturnType<typeof setTimeout> | null = null
function toggleSidebar(want?: boolean) {
  if (narrow.value) {
    peek.close()
    peekLive.value = true
    drawer.value = want ?? !drawer.value
    return
  }
  const open = want ?? !sidebarOpen.value
  if (open === sidebarOpen.value) return
  const pin = open && peekOpen.value
  peek.close()
  peekLive.value = false
  peekArmed = false
  slide.value = { open, pin, at: 'from' }
  sidebarOpen.value = open
  storage?.setItem(OPEN_KEY, open ? '1' : '0')
  if (slideTimer) clearTimeout(slideTimer)
  void nextTick(() => {
    // The 'from' places must be laid out before 'to' changes them, or there is nothing to animate from.
    void stageEl.value?.offsetWidth
    if (slide.value?.at === 'from') slide.value = { ...slide.value, at: 'to' }
  })
  slideTimer = setTimeout(() => (slide.value = null), 340)
}
const stageEl = ref<HTMLElement | null>(null)
/** Where the sidebar and the stage sit during a slide (px from their resting places); undefined at rest. */
const slideX = computed(() => {
  const s = slide.value
  if (!s) return undefined
  const w = sidebarWidth.value
  const end = s.at === 'to'
  // A pin starts with the flyout already out; the stage starts where it was either way.
  const sidebarOut = end ? s.open : !s.open || s.pin
  const stagePushed = end ? s.open : !s.open
  // On the right the stage keeps its left edge and the sidebar slides over it: the stage's content never shifts.
  const right = sidebarSide.value === 'right'
  return { sidebar: sidebarOut ? 0 : right ? w : -w, stage: !right && stagePushed ? w : 0 }
})
const SLIDE_EASE = 'transition-transform duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none'
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null)

// Collapsed, the sidebar slides in over the content (the layout stays) while the pointer is on the
// show-sidebar toggle, a 6px strip at the window's left edge or the flyout itself. Zones are marked
// data-peek-zone: 'open' opens it, 'keep' (the chrome bar over its top) only keeps it open. A menu
// opened from the flyout lives in a portal and counts as part of it.
const flyout = computed(() => !collapsed.value && !docked.value && !sliding.value)
const peekOpen = ref(false)
// The flyout animates only once the pointer has used it, so collapsing does not slide it past again.
const peekLive = ref(false)
const overlayOpen = () => !!document.querySelector('[role="menu"], [role="dialog"]')
const peek = new SidebarPeek((open) => {
  if (open) peekLive.value = true
  peekOpen.value = open
}, overlayOpen)
// After the toggle hid the sidebar, the pointer still on it must leave once before it can peek.
let peekArmed = true
function onPeekPointer(e: PointerEvent) {
  // A held button is a drag (a text selection reaching the left edge): it must not slide the flyout over it.
  if (!flyout.value || e.buttons !== 0) return
  const t = e.target instanceof Element ? e.target : null
  const zone = t?.closest('[data-peek-zone]')?.getAttribute('data-peek-zone')
  const inside = zone === 'open' || (peekOpen.value && (zone === 'keep' || !!t?.closest('[role="menu"]')))
  if (!peekArmed) peekArmed = !inside
  else peek.hover(inside)
}
function onPeekPointerOut(e: PointerEvent) {
  if (!e.relatedTarget) peek.hover(false) // left the window
}
// Keyboard focus inside keeps it open; a mouse click inside does not pin it.
const onPeekFocusIn = (e: FocusEvent) => peek.focused(e.target instanceof Element && e.target.matches(':focus-visible'))
const onPeekFocusOut = () => peek.focused(false)
watch(
  () => src.selected.value,
  () => {
    peek.close()
    drawer.value = false
    railNarrow.value = false
    paneNarrow.value = null
  }
)
// A drag reports every pointer move: the width follows once per frame, and is saved once the drag rests.
let widthFrame = 0
let widthSave: ReturnType<typeof setTimeout> | null = null
let pendingWidth = sidebarWidth.value
function resizeSidebar(w: number) {
  pendingWidth = w
  if (!widthFrame) {
    widthFrame = requestAnimationFrame(() => {
      widthFrame = 0
      sidebarWidth.value = pendingWidth
    })
  }
  if (widthSave) clearTimeout(widthSave)
  widthSave = setTimeout(saveWidth, 250)
}
/** Saves the width a drag left; a close or reload before the save fires saves it at once (pagehide). */
function saveWidth() {
  if (!widthSave) return
  clearTimeout(widthSave)
  widthSave = null
  storage?.setItem(SIDEBAR_WIDTH_KEY, String(pendingWidth))
}
// The group names a row's menu offers, worked out when the chats or outside sessions change, not on every render.
const rowGroups = computed(() => groupChoices(src.chats.value, src.external.value))
function openSearch() {
  toggleSidebar(true)
  sidebar.value?.openSearch()
}

// Back / Forward: Alt + Left / Right (the chrome bar's arrows are gone, owner 2026-10-06).
const history = new NavHistory()
for (const v of props.history ?? []) history.visit(v)
function travel(dir: 'back' | 'forward') {
  let next = dir === 'back' ? history.back() : history.forward()
  // Skip chats that were deleted since.
  while (next && next.kind === 'chat' && !src.chats.value.some((c) => c.id === (next as { id: string }).id)) {
    history.forget(next.id)
    next = dir === 'back' ? history.back() : history.forward()
  }
  if (next) src.select(next)
}
watch(view, (v) => history.visit(v.kind === 'chat' && !chat.value ? { kind: 'new' } : v), { immediate: true })

// Opening a chat loads its transcript and clears its unread mark (its orange dot goes back to the idle
// ring). A turn that ends while its chat is open in the focused window was seen, so it is cleared too;
// one that ends while the owner is in another window keeps it.
watch(
  () => [chat.value?.id, chat.value?.status] as const,
  ([id], before) => {
    const c = chat.value
    if (!id || !c) return
    const opened = id !== before?.[0]
    // floor-ok: both catches predate this change (same calls, new conditions); a failed load or read mark is retried on the next open.
    if (opened && !src.itemsByChat.value.has(id)) void src.loadItems(id).catch(() => {}) // floor-ok
    const reads = unreadHold.reads(id, opened ? 'opened' : 'turn', document.hasFocus())
    if (c.unread && reads) void src.updateChat(id, { unread: false }).catch(() => {}) // floor-ok
  },
  { immediate: true }
)

// View options: thinking blocks open, remembered. The transcript takes its open rows at mount, so
// toggling remounts it.
const THINKING_KEY = 'hydra-desk.view.showThinking'
const showThinking = ref(storage?.getItem(THINKING_KEY) === '1')
function setShowThinking(show: boolean) {
  showThinking.value = show
  storage?.setItem(THINKING_KEY, show ? '1' : '0')
}
const openThinking = computed(() => (showThinking.value ? items.value.filter((i) => i.kind === 'thinking').map((i) => i.id) : undefined))

// Hydra Desk 2: AgentHydra slides in over the chat side (the sidebar stays), pushing the chat out to the
// left; the same button or the pane's own "← Desk" button slides the chat back. While it is open the
// sidebar is the list of AgentHydra's current tab where it has one (HSwarm's tree, CliMayte among its
// nodes: components/hydra/HydraSidebar.vue), else AgentHydra's session list (the cloud list, turned on for it
// and off again after unless it was already on); a session clicked there opens on Desk's side. Picking anything of Desk's own in
// the sidebar slides the chat back. The cloud button turns the sidebar's list into every session of
// both PCs on its own too (components/cloud). The Dev servers page takes the same place (below), so opening
// one closes the other.
const cloud = useCloud()
const devServers = useDevServers()
let cloudForHydra = false
function toggleHydra(open = !hydraOpen.value) {
  if (open === hydraOpen.value) return
  hydraOpen.value = open
  if (open) {
    devServers.closePage()
    closeDashboard()
    cloudForHydra = !cloud.on.value
    cloud.on.value = true
    sidebarBesidePage()
  } else if (cloudForHydra) {
    cloudForHydra = false
    cloud.on.value = false
  }
  keepHydra()
}
function keepHydra() {
  if (!props.demo) rememberScreen({ hydra: hydraOpen.value ? { cloud: cloudForHydra } : undefined })
}
/** A page slid into the chat's place (AgentHydra, the Dev servers page): the sidebar opens beside it, or as a drawer shuts off it. */
function sidebarBesidePage() {
  if (narrow.value) drawer.value = false
  else toggleSidebar(true)
}
// A reload with AgentHydra open opens it again, on the tab it showed (the pane keeps its own tab).
if (kept.hydra) {
  toggleHydra(true)
  cloudForHydra = kept.hydra.cloud
  keepHydra()
}
// An ask to show AgentHydra (openHydra) closes Settings first: its dialog sat over the pane it opened (2026-10-16,
// Settings > Managers' View more and its Routines tab row slid AgentHydra in behind the dialog).
const onOpenHydra = () => {
  if (settingsOpen.value) closeSettings()
  toggleHydra(true)
}
// The AgentHydra frame preloads once the sidebar has its first outside sessions (or 10 s passed), so its burst of
// requests does not compete with the sidebar's first reads; pointing at or focusing its button starts it at once.
// The lazy panels' chunks load then too, each while the window is idle (prefetchPanels).
const sidebarReady = ref(false)
const hydraIntent = ref(false)
const readyTimer = setTimeout(() => {
  sidebarReady.value = true
  prefetchPanels()
}, 10_000)
const stopReadyWatch = watch(
  () => src.external.value,
  () => {
    sidebarReady.value = true
    prefetchPanels()
    clearTimeout(readyTimer)
    stopReadyWatch()
  }
)
// Picking anything slides the chat back, from AgentHydra or the Dev servers page; an outside session came from the
// cloud list, which stays. Settings is a pop-up over whatever is on screen, so opening and closing it leaves the page
// where it is: a table's gear opens its Instances page over the table, and closing Settings goes back to it.
watch(
  () => src.selected.value,
  (v, was) => {
    if (v.kind === 'settings' || was?.kind === 'settings') return
    devServers.closePage()
    closeDashboard()
    if (!hydraOpen.value) return
    if (v.kind === 'external') cloudForHydra = false
    toggleHydra(false)
  }
)
// A table's gear in the AgentHydra pane opens its Instances page: the pane's settings are in Desk's dialog
// now (panes/agenthydra.ts, panes/instances.ts).
function openSettingsOn(section?: SettingsSection) {
  requestedSection.value = section ?? null
  src.openSettings()
}
// The Connections sign-in (Settings → Connections) comes back to this page with ?connected=1 or
// ?connect=failed: AgentHydra's /oauth/callback lands on its own address, which sends a page visit on to
// Desk (server/src/index.ts). The result shows on Connections; the query goes so a reload does not ask again.
function takeConnectReturn() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('connected') && !params.has('connect')) return
  params.delete('connected')
  params.delete('connect')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  openSettingsOn('connections')
}
function showSessions() {
  cloudForHydra = false
  cloud.on.value = true
  toggleHydra(false)
}
function toggleCloud() {
  cloud.on.value = !cloud.on.value
  cloudForHydra = false
  keepHydra()
  if (cloud.on.value) toggleSidebar(true)
}
// The Dev servers button: the sidebar lists the projects and servers (components/servers) and the Dev servers page
// slides in, in the chat's place, as AgentHydra does (owner, 2026-10-07: "just be its own page ... have it slide in like
// Hydra slides in"): its overview, until a row is picked. One list at a time: it and the cloud list turn each other off,
// and AgentHydra, which borrows the cloud list, does too. Pressed with the list on and the page closed (its X, Esc, a
// chat picked), it brings the page back; pressed with both, both go. A reload with the page open opens it again.
watch(
  () => devServers.on.value,
  (on) => {
    if (on) cloud.on.value = false
    else devServers.closePage()
    // The page's code loads with the list, so its first slide in is not an empty page while it arrives.
    if (on) void loadInfoPane().catch(() => {}) // floor-ok: a failed load is the page's to report when it opens (lazyPanel)
  },
  { immediate: true }
)
watch(() => cloud.on.value, (on) => on && devServers.setOn(false))
function toggleDev() {
  if (devServers.on.value && devServers.page.value) return devServers.setOn(false)
  devServers.setOn(true)
  devServers.openPage()
  cloudForHydra = false
  toggleHydra(false)
  keepHydra()
  sidebarBesidePage()
}
if (kept.dev && !kept.hydra && devServers.on.value) devServers.openPage()
function toggleTasks() {
  showTasks.value = !showTasks.value
  if (!showTasks.value) return
  toggleSidebar(true)
  // An AgentHydra tab with a list of its own (HSwarm's tree) has the sidebar while it is open, so the
  // tasks would not show: slide back to the desk, as showSessions does (the other owner, 2026-10-04: "toggling ...
  // does nothing in the sidebar").
  if (hydraOpen.value && hydraShown.value) toggleHydra(false)
}

const toggleClean = () => (cleanSidebar.value = !cleanSidebar.value)
const toggleCompact = () => (compactSidebar.value = !compactSidebar.value)

// Right pane: which one is open, or none, is remembered per chat (and per outside session), so opening the browser in
// one chat leaves the others as they were. Background tasks below is kept the same way. Narrow, the pane is the window's alone
// (paneNarrow), never a chat's remembered one: it takes the chat's place, and any pick, its back row or its button brings the chat
// back. Opening one there shuts the drawer it was asked from (a group's To-do, the Dev servers list's Open in browser).
const viewKey = computed(() => {
  const v = view.value
  return v.kind === 'chat' || v.kind === 'external' ? `${v.kind}:${v.id}` : v.kind
})
const paneByView = ref(new Map<string, RightPane>())
const pane = computed<RightPane | null>({
  get: () => (narrow.value ? paneNarrow.value : (paneByView.value.get(viewKey.value) ?? null)),
  set: (p) => {
    if (narrow.value) {
      paneNarrow.value = p
      if (p) drawer.value = false
      return
    }
    const next = new Map(paneByView.value)
    if (p) next.set(viewKey.value, p)
    else next.delete(viewKey.value)
    paneByView.value = next
  }
})
// The browser this chat's AI last used: a chat whose browser has no tabs yet starts on it. Read only while the servers
// pane is open, and the same object while it is unchanged, so a streaming reply does not touch the pane.
const aiBrowser = computed<BrowserOpenRequest | null>((old) => {
  const r = pane.value === 'servers' && chat.value ? lastBrowserRequest(items.value) : null
  return old && r && old.profile === r.profile && old.url === r.url ? old : r
})
// The servers pane is for the chat's folder, unless the Dev servers list asked for a server of another project: that
// project's folder, until another chat is picked or the pane is closed. `serversFocus` is the request itself (the pane
// shows that server once).
const serversCwd = ref<string | null>(null)
const serversFocus = ref<ServerFocus | null>(null)
const serversDir = computed(() => serversCwd.value ?? chat.value?.cwd ?? null)
watch(
  () => devServers.focus.value,
  (f) => {
    if (!f) return
    serversCwd.value = f.cwd
    serversFocus.value = f
    tasks.value = null
    // The browser is the chat's pane: the Dev servers page slides back so it shows.
    devServers.closePage()
    pane.value = 'servers'
  }
)
// The dashboard page's Open in tab: the page slides back and the pane opens the site in a tab, in the dashboard's
// folder as the list's request does (the pane's tabs are the chat's, so one stays when the folder changes back).
watch(dashboardTab, (t) => {
  if (!t) return
  closeDashboard()
  serversCwd.value = t.cwd
  tasks.value = null
  pane.value = 'servers'
  browserRequest.value = { url: t.url }
})
watch(
  () => chat.value?.id,
  () => {
    serversCwd.value = null
    todoCwd.value = null
  }
)
watch(pane, (p) => {
  if (p !== 'servers') serversCwd.value = null
  if (p !== 'todo') todoCwd.value = null
})
// The To-do pane shows the folder a group head asked for, else this chat's folder (the header's button). A second request
// for the folder it shows closes it.
const todoCwd = ref<string | null>(null)
const todoDir = computed(() => todoCwd.value ?? chat.value?.cwd ?? null)
watch(todoRequest, (r) => {
  if (!r) return
  if (pane.value === 'todo' && todoDir.value === r.cwd) pane.value = null
  else {
    todoCwd.value = r.cwd
    pane.value = 'todo'
  }
})
watchEffect(() => (todoShowing.value = pane.value === 'todo' ? todoDir.value : null))
startFourman()
// The page side of the track (owner, 2026-10-07: the right-hand info pane "kind of ugly ... just be in the center of the
// page ... like Hydra slides in"): AgentHydra and the Dev servers page are its two layers. Opened from the desk, the
// track pushes the chat out and the page in; one page opened over the other pushes that one out within the side, the
// same 420ms push. The Dev servers page is mounted while it is open and through its slide out (it polls while mounted),
// and keeps the last selection while it leaves, so it never empties on its way.
type Page = 'hydra' | 'dev' | 'dash'
const devPage = computed(() => devServers.page.value)
const pageOpen = computed(() => hydraOpen.value || devPage.value || dashboardOpen.value)
const PAGE_SLIDE = 'transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none'
const PAGE_MS = 460
const slotPage = ref<Page>(devPage.value && !hydraOpen.value ? 'dev' : dashboardOpen.value && !hydraOpen.value && !devPage.value ? 'dash' : 'hydra')
const slotLeaving = ref<Page | null>(null)
let slotTimer: ReturnType<typeof setTimeout> | undefined
watch([hydraOpen, devPage, dashboardOpen], ([h, d, a], [wasH, wasD, wasA]) => {
  const next: Page | null = h && !wasH ? 'hydra' : d && !wasD ? 'dev' : a && !wasA ? 'dash' : null
  if (!next || next === slotPage.value) return
  clearTimeout(slotTimer)
  // Only a page on screen is pushed out; with the desk on screen the new one is simply there when the track slides.
  slotLeaving.value = wasH || wasD || wasA ? slotPage.value : null
  slotPage.value = next
  if (slotLeaving.value) slotTimer = setTimeout(() => (slotLeaving.value = null), PAGE_MS)
})
const layerAt = (p: Page) => (p === slotPage.value ? 'translateX(0)' : p === slotLeaving.value ? 'translateX(-100%)' : 'translateX(100%)')
const layerSlides = (p: Page) => !!slotLeaving.value && (p === slotPage.value || p === slotLeaving.value)
watch(devPage, (open) => {
  if (open && hydraOpen.value) toggleHydra(false)
  if (open) closeDashboard()
  if (!props.demo) rememberScreen({ dev: open || undefined })
})
watch(dashboardOpen, (open) => {
  if (open && hydraOpen.value) toggleHydra(false)
  if (open) devServers.closePage()
})
const dashMounted = ref(dashboardOpen.value)
let dashTimer: ReturnType<typeof setTimeout> | undefined
watch(dashboardOpen, (open) => {
  clearTimeout(dashTimer)
  if (open) dashMounted.value = true
  else dashTimer = setTimeout(() => (dashMounted.value = dashboardOpen.value), PAGE_MS)
})
const devMounted = ref(devPage.value)
let devTimer: ReturnType<typeof setTimeout> | undefined
watch(devPage, (open) => {
  clearTimeout(devTimer)
  if (open) devMounted.value = true
  else devTimer = setTimeout(() => (devMounted.value = devPage.value), PAGE_MS)
})
const devShown = ref<DevSelection | null>(devServers.selection.value)
watch([() => devServers.selection.value, devPage], ([sel, open]) => {
  if (open) devShown.value = sel
})
// Changes with RepoYeti selected is as wide as the servers pane (it is a whole page in a frame).
const wide = computed(() => pane.value === 'servers' || (pane.value === 'diff' && changesTabFor(changesTab.value, repoYeti.value) === 'repoyeti'))
function togglePane(p: RightPane) {
  pane.value = pane.value === p ? null : p
}
const asideOpen = computed(() => !tasks.value && !!pane.value && (pane.value === 'climayte' || !!chat.value || (pane.value === 'servers' && !!serversCwd.value) || (pane.value === 'todo' && !!todoDir.value)))
// A wide pane splits the stage: the chat keeps the width it was dragged to and the pane takes the rest, so resizing the
// window resizes the pane and leaves the chat as it is. The width is each chat's own, like whether its pane is open: a
// chat never dragged opens at the default. The divider on the pane's left edge drags the split, or arrow keys move it;
// each side keeps only enough room to stay usable. Narrow there is no split: the pane lies in the chat's place (paneOver).
const split = computed(() => wide.value && asideOpen.value && !narrow.value)
const paneOver = computed(() => narrow.value && asideOpen.value)
const splitEl = ref<HTMLElement | null>(null)
const { width: stageWidth } = useElementSize(splitEl)
const chatWidthByView = ref(new Map<string, number>())
const chatWidth = computed(() => chatWidthByView.value.get(viewKey.value) ?? CHAT_DEFAULT)
const chatAt = computed(() => splitChat(chatWidth.value, stageWidth.value))
function setChatWidth(want: number) {
  const next = new Map(chatWidthByView.value)
  next.set(viewKey.value, splitChat(want, stageWidth.value))
  chatWidthByView.value = next
}
function onSplitDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const left = splitEl.value?.getBoundingClientRect().left ?? 0
  const move = (ev: PointerEvent) => setChatWidth(ev.clientX - left)
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onSplitKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') setChatWidth(chatAt.value - 16)
  else if (e.key === 'ArrowRight') setChatWidth(chatAt.value + 16)
}
const onOpenDiff = () => (pane.value = 'diff')
const onOpenCliMayte = () => (pane.value = 'climayte')
const onOpenRepoYeti = () => {
  setChangesTab('repoyeti')
  pane.value = 'diff'
}
// A Browser card in the transcript: the servers pane shows that browser (it reads the same event itself).
const onOpenBrowser = () => {
  if (chat.value) pane.value = 'servers'
  // The card's browser is the chat's: the pane leaves a project the Dev servers list showed.
  if (chat.value) serversCwd.value = null
}
// Background tasks (the inline row, a workflow card, desk.openBackgroundTasks(), a task in the session rail) slides the session
// rail over to its panel, or, expanded, takes the chat's place. Which (and on which task) is remembered per chat: switching chats
// shows each one's own.
type TasksState = { focus: string | null; expanded: boolean }
const tasksByView = ref(new Map<string, TasksState>())
const tasks = computed<TasksState | null>({
  get: () => tasksByView.value.get(viewKey.value) ?? null,
  set: (t) => {
    const next = new Map(tasksByView.value)
    if (t) next.set(viewKey.value, t)
    else next.delete(viewKey.value)
    tasksByView.value = next
  }
})
// The running count on the title bar's Session details button: the session on view's, with its own lists when the rail or the
// tasks line has them read (never asked for here).
const desk = useDesk()
const tasksRunningCount = computed(
  () =>
    panelLists({
      workers: src.workers.value,
      items: tasksItems.value,
      index: tasksIndex.value,
      jobs: [...desk.swarmJobs.value, ...desk.remoteSwarmJobs.value],
      own: tasksSessionId.value ? sessionTasks.value.get(tasksSessionId.value) : null,
      sessionId: tasksSessionId.value,
      workerIds: tasksWorkerIds.value,
      cleared: cleared.value
    }).running.length
)
function onOpenTasks(e: Event) {
  pane.value = null
  devServers.closePage()
  tasks.value = { focus: (e as CustomEvent<OpenTasksDetail>).detail?.taskId ?? null, expanded: tasks.value?.expanded ?? false }
}
watch(pane, (p) => {
  if (p) tasks.value = null
})

// The session rail (components/rail, owner 2026-10-14) in place of the session header's bar and the docked Background tasks
// panel: shown for a chat or an outside session while no right pane takes its place, open or shut for the window (the title
// bar's Session details button), and always while Background tasks is on it. A session opened from a search peeks it for a
// moment (session-header/state.ts), lying over the chat. It takes from the chat only the room the centred text column needs
// (railReserve), so on a wide window it lies over the empty margin and the column stays where it was.
// Narrow, it lies over the chat, takes no room and is asked for in that window alone (railNarrow), never by the saved railOpen.
const railWanted = computed(() => (narrow.value ? railNarrow.value : railOpen.value))
const setRail = (open: boolean) => {
  if (narrow.value) railNarrow.value = open
  else railOpen.value = open
}
const railFloats = computed(() => !railWanted.value && !tasks.value && !!outsideId.value && headerPeek.value)
const railShown = computed(
  () => (!!chat.value || !!outsideId.value) && !isNew.value && !asideOpen.value && !tasks.value?.expanded && (railWanted.value || !!tasks.value || railFloats.value)
)
const railAt = computed(() => railWidthIn(railWidth.value, stageWidth.value))
const railRoom = computed(() => (railFloats.value || narrow.value ? 0 : railReserve(railAt.value, stageWidth.value)))
// How far the open rail lies over the chat (its width past the room it takes), as --rail-over on the chat: the transcript's step
// arrows and peek keep that far in from its right edge (owner, 2026-10-14: the rail "hides the peek and previous message buttons").
// Not while it only peeks for a moment (the arrows would jump out and back), nor narrow, where it lies over most of the chat.
const railOver = computed(() => (railShown.value && !railFloats.value && !narrow.value ? Math.max(0, railAt.value + RAIL_INSET - railRoom.value) : 0))
function toggleRail() {
  if (railShown.value && !railFloats.value) {
    tasks.value = null
    setRail(false)
    return
  }
  pane.value = null
  if (tasks.value?.expanded) tasks.value = null
  setRail(true)
}
/** Background tasks leaves the rail: back to its cards, or (its Close) the rail shut with it. */
function closeRailTasks(shut: boolean) {
  tasks.value = null
  setRail(!shut)
}
// It slides in from the right and back out (owner, 2026-10-08, of the panel before it: "still snaps open, ZERO nice
// animations") on transforms alone, as the sidebar does. The chat takes its new width the moment the rail is asked for or
// shut, both ways (owner, 2026-10-14: closing, the text "waits until the sidebar closes to snap open"), and is drawn
// half the room that changed off its new place, from where its column was, gliding there with the rail. Another chat, a
// pane taking its place, or Background tasks expanding show at once.
const railSlide = ref<{ open: boolean; at: 'from' | 'to'; room: number } | null>(null)
/** The rail on its way out, drawn over the chat until the slide ends. */
const railLeaving = ref(false)
/** The slide's out end: the rail past the window's right edge, the chat where it was before the rail came. */
const railOut = computed(() => !!railSlide.value && railSlide.value.open === (railSlide.value.at === 'from'))
let railTimer: ReturnType<typeof setTimeout> | undefined
function endRailSlide() {
  clearTimeout(railTimer)
  railSlide.value = null
  railLeaving.value = false
}
/** Where the chat is drawn off its place: from where its column was, to its place. */
const railShift = computed(() => (railSlide.value?.at === 'from' ? (railSlide.value.open ? 1 : -1) * (railSlide.value.room / 2) : 0))
watch([railShown, viewKey, railRoom], ([on, key, room], [was, wasKey, wasRoom]) => {
  if (on === was && key === wasKey) return
  endRailSlide()
  if (key !== wasKey || on === was || (!on && (pane.value || tasks.value?.expanded))) return
  railLeaving.value = !on
  railSlide.value = { open: on, at: 'from', room: on ? room : wasRoom }
  void nextTick(() => {
    // The 'from' places must be laid out before 'to' changes them, or there is nothing to animate from.
    void splitEl.value?.offsetWidth
    if (railSlide.value?.at === 'from') railSlide.value = { ...railSlide.value, at: 'to' }
  })
  railTimer = setTimeout(endRailSlide, 340)
})
// The divider on the rail's left edge drags its width, or arrow keys move it; the width is the window's, saved once it rests.
function setRailWidth(want: number) {
  railWidth.value = railWidthIn(want, stageWidth.value)
}
function onRailResizeDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const right = el.parentElement?.getBoundingClientRect().right ?? 0
  const move = (ev: PointerEvent) => setRailWidth(right - RAIL_INSET - ev.clientX)
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    saveRailWidth()
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onRailResizeKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') setRailWidth(railAt.value + 16)
  else if (e.key === 'ArrowRight') setRailWidth(railAt.value - 16)
  else return
  saveRailWidth()
}

// A session running elsewhere. One the composer can carry on has a stand-in chat until its first
// message; the title bar's Account menu picks where it continues.
const external = computed(() => {
  const v = view.value
  return v.kind === 'external' ? (src.external.value.find((s) => s.id === v.id) ?? null) : null
})
// An archived chat or outside session says so at its bottom, with a link that unarchives it.
const notice = computed(() => archivedNotice(view.value, chat.value, external.value))
function unarchive() {
  const n = notice.value
  if (!n) return
  actionError.value = null
  const run = n.kind === 'chat' ? src.updateChat(n.id, n.patch) : src.updateSessionMeta(n.id, n.patch)
  void run.catch((err: unknown) => (actionError.value = `The change failed: ${err instanceof Error ? err.message : String(err)}`))
}
const standIn = computed(() => (external.value && src.standInOf?.(external.value.id)) || null)
// A chat another chat opened is run by that parent: the person reads it here and talks to the parent.
const lockedChild = computed(() => (chat.value ? readOnlyChild(chat.value, src.chats.value) : null))
const lockedParentFound = computed(() => !!lockedChild.value && src.chats.value.some((c) => c.id === lockedChild.value?.parentId))
function tellParent() {
  const locked = lockedChild.value
  if (!locked) return
  desk.select({ kind: 'chat', id: locked.parentId })
  void nextTick(() => {
    const put: PutBack = { chatId: locked.parentId, text: locked.draft, images: [] }
    window.dispatchEvent(new CustomEvent<PutBack>(PUT_BACK_EVENT, { detail: put }))
    if (!put.taken) saveDraft(storage, locked.parentId, putBackDraft(locked.draft, loadDraft(storage, locked.parentId)))
  })
}
// Composer owns the window file-drop listeners and is unmounted for a locked chat, so refuse file drops here.
function refuseFileDrop(e: DragEvent) {
  if (!lockedChild.value || !e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'none'
}

// The title bar's Account menu: a chat's next start, or where a stand-in continues.
function pickAccount(id: string) {
  const target = chat.value ?? standIn.value
  // floor-ok: a stand-in's change never fails; a chat whose PATCH fails keeps showing the account it has.
  if (target) void src.updateChat(target.id, { accountId: id }).catch(() => {})
}

// An outside session's unread mark clears the same way as a chat's, however it was opened (its row, a
// search hit, Back / Forward): on opening it, or when it turns unread or its turn moves on while open in
// the focused window. A mark the owner set by hand stays (unreadHold). Going stale is no new turn.
watch(
  () => [external.value?.id, external.value?.unread, external.value?.status] as const,
  ([id, unread, status], before) => {
    if (!id) return
    const turn = status !== before?.[2] && status !== 'stale'
    const reads = unreadHold.reads(id, id !== before?.[0] ? 'opened' : turn ? 'turn' : 'mark', document.hasFocus())
    // floor-ok: a failed read mark is retried on the next open or focus.
    if (unread && reads) void src.updateSessionMeta(id, { unread: false }).catch(() => {})
  },
  { immediate: true }
)

// Coming back to the window reads what is open: a turn that ended while the owner was away keeps its
// unread mark until then. A mark the owner set by hand is not undone by coming back (unreadHold).
function markOpenRead() {
  if (document.visibilityState === 'hidden') return
  // floor-ok: both are retried on the next open or focus.
  if (chat.value?.unread && unreadHold.reads(chat.value.id, 'focus', true))
    void src.updateChat(chat.value.id, { unread: false }).catch(() => {})
  if (external.value?.unread && unreadHold.reads(external.value.id, 'focus', true))
    void src.updateSessionMeta(external.value.id, { unread: false }).catch(() => {})
}
const onVisibility = () => document.visibilityState === 'visible' && markOpenRead()

// Title bar actions (the same menu as the sidebar row, run by the sidebar)
function act(item: RowMenuItem) {
  if (chat.value) sidebar.value?.chatAction(chat.value, item)
}
function rename(title: string) {
  if (chat.value) sidebar.value?.renameChat(chat.value, title)
}

// Keyboard
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && (peekOpen.value || drawer.value) && !e.defaultPrevented && !overlayOpen()) {
    // Taken: a docked permission card must not read this Esc as a No.
    e.preventDefault()
    peek.close()
    drawer.value = false
    return
  }
  const s = matchShortcut(e)
  if (!s) return
  e.preventDefault()
  if (s === 'new') src.select({ kind: 'new' })
  else if (s === 'toggleSidebar') toggleSidebar()
  else if (s === 'search') openSearch()
  else travel(s)
}

onMounted(() => {
  if (!props.demo) takeConnectReturn()
  // In AgentHydra's own window the page draws the title bar from here on (lib/host-window.ts); a browser tab is untouched.
  startOwnFrame()
  window.addEventListener('keydown', onKey)
  window.addEventListener(OPEN_DIFF_EVENT, onOpenDiff)
  window.addEventListener(OPEN_CLIMAYTE_EVENT, onOpenCliMayte)
  window.addEventListener(OPEN_REPOYETI_EVENT, onOpenRepoYeti)
  window.addEventListener(OPEN_BROWSER_EVENT, onOpenBrowser)
  window.addEventListener(OPEN_TASKS_EVENT, onOpenTasks)
  window.addEventListener(OPEN_HYDRA_EVENT, onOpenHydra)
  document.addEventListener('pointermove', onPeekPointer)
  document.addEventListener('pointerout', onPeekPointerOut)
  window.addEventListener('focus', markOpenRead)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', saveWidth)
  window.addEventListener('pointerdown', holdPointer)
  window.addEventListener('pointerup', releasePointer)
  window.addEventListener('pointercancel', releasePointer)
  window.addEventListener('blur', releasePointer)
  window.addEventListener('dragover', refuseFileDrop)
  window.addEventListener('drop', refuseFileDrop)
})
function holdPointer() {
  pointerHeld.value = true
}
onBeforeUnmount(() => {
  saveWidth()
  window.removeEventListener('pagehide', saveWidth)
  window.removeEventListener('pointerdown', holdPointer)
  window.removeEventListener('pointerup', releasePointer)
  window.removeEventListener('pointercancel', releasePointer)
  window.removeEventListener('blur', releasePointer)
  window.removeEventListener('dragover', refuseFileDrop)
  window.removeEventListener('drop', refuseFileDrop)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener(OPEN_DIFF_EVENT, onOpenDiff)
  window.removeEventListener(OPEN_CLIMAYTE_EVENT, onOpenCliMayte)
  window.removeEventListener(OPEN_REPOYETI_EVENT, onOpenRepoYeti)
  window.removeEventListener(OPEN_BROWSER_EVENT, onOpenBrowser)
  window.removeEventListener(OPEN_TASKS_EVENT, onOpenTasks)
  window.removeEventListener(OPEN_HYDRA_EVENT, onOpenHydra)
  document.removeEventListener('pointermove', onPeekPointer)
  document.removeEventListener('pointerout', onPeekPointerOut)
  window.removeEventListener('focus', markOpenRead)
  document.removeEventListener('visibilitychange', onVisibility)
  if (slideTimer) clearTimeout(slideTimer)
  clearTimeout(readyTimer)
  clearTimeout(slotTimer)
  clearTimeout(devTimer)
  peek.dispose()
})

// Collapse mode (collapse.ts): a focus change or a chat click moves the window; a pointer still down holds it until release.
const collapseMode = computed(() => src.settings.value?.collapseMode ?? 'off')
const pointerHeld = ref(false)
const focusWaiting = ref(false)
function applyFocus() {
  if (!canCollapse()) return
  const act = focusAction({ mode: collapseMode.value, collapsed: collapsed.value, focused: appFocused.value, busy: pointerHeld.value })
  focusWaiting.value = act === 'wait'
  if (act === 'collapse') collapseWindow(sidebarWidth.value)
  else if (act === 'expand') expandWindow()
}
function releasePointer() {
  pointerHeld.value = false
}
watch(appFocused, applyFocus)
watch(pointerHeld, (held) => {
  if (!held && focusWaiting.value) applyFocus()
})
watch(collapseMode, (mode) => {
  if (modeAction({ mode, collapsed: collapsed.value }) === 'expand') expandWindow()
})
watch(
  () => src.selected.value,
  (v) => {
    if (canCollapse() && v.kind === 'chat' && chatAction({ mode: collapseMode.value, collapsed: collapsed.value }) === 'expand') expandWindow()
  }
)
function collapseNow() {
  collapseWindow(sidebarWidth.value)
}

// With the sidebar hidden the title bar starts after the chrome bar's buttons (Dev servers, the last, ends at 286: the bar's
// CHROME_COLLAPSED 290 less its 4px padding); open, after the sidebar, or after the bar where it reaches past a sidebar narrower
// than its buttons (sidebar/width.ts).
const titlePad = computed(() => (docked.value ? 9 + chromeOverhang(sidebarWidth.value) : CHROME_COLLAPSED))
// On the right the chrome bar sits inside the window's caption buttons, so the title bar ends before it.
const titlePadEnd = computed(() => (docked.value ? CAPTION_W + 9 + chromeOverhang(sidebarWidth.value) : CAPTION_W + CHROME_COLLAPSED))
const titleStart = computed(() => (sidebarSide.value === 'left' ? titlePad.value : 9))
/** Dragged to the other half of the window, the sidebar moves there; the drop preview lies over that edge until it lands. */
const sideDrop = ref<SidebarSide | null>(null)
function moveSidebar(side: SidebarSide) {
  sideDrop.value = null
  setSidebarSide(side)
}
</script>

<template>
  <!-- DOM order is the tab order: chrome bar, sidebar, then the pane (title bar first); the grid places them. -->
  <div
    class="relative grid size-full grid-rows-[41px_minmax(0,1fr)] overflow-hidden bg-bg-page text-text"
    :class="collapsed ? 'grid-cols-[minmax(0,1fr)]' : sidebarSide === 'right' ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)]'"
  >
    <ChromeBar
      v-show="!collapsed"
      :sidebar-open="docked || drawer"
      :width="shownWidth"
      :side="sidebarSide"
      :sliding="sliding || narrow"
      :hydra-open="hydraOpen"
      :cloud-on="cloud.on.value"
      :tasks-on="showTasks"
      :dev-on="devServers.on.value"
      :clean-on="cleanSidebar"
      :compact-on="compactSidebar"
      :update="demo ? null : updateOffer"
      @restart="restartServer"
      @hydra="toggleHydra()"
      @hydra-intent="hydraIntent = true"
      @cloud="toggleCloud"
      @tasks="toggleTasks"
      @dev="toggleDev"
      @clean="toggleClean"
      @compact="toggleCompact"
      @new="src.select({ kind: 'new' })"
      @search="openSearch"
      @toggle-sidebar="toggleSidebar()"
      @settings="src.openSettings()"
    />

    <!-- Sliding, it lies over the stage at its full width and moves by transform (slideX); at rest it is the grid's first column. -->
    <div
      class="h-full overflow-hidden"
      :class="collapsed ? 'col-span-full row-span-2 row-start-1' : slideX ? ['absolute top-0 z-10', slide?.at === 'to' && SLIDE_EASE] : [sidebarSide === 'right' ? 'col-start-2' : 'col-start-1', 'row-span-2 row-start-1']"
      :style="collapsed ? { width: '100%' } : slideX ? { width: `${sidebarWidth}px`, transform: `translateX(${slideX.sidebar}px)`, [sidebarSide === 'right' ? 'right' : 'left']: '0px' } : { width: docked ? `${sidebarWidth}px` : '0px' }"
      :inert="!collapsed && !docked && !peekOpen && !drawer"
      data-testid="sidebar-slot"
    >
      <!-- Collapsed, this is the hover flyout: positioned on the window (not the 0-wide slot), under the chrome bar (z-21), below dialogs.
           Narrow, it is also the drawer, over its scrim. -->
      <div
        class="h-full"
        :class="
          flyout && [
            'absolute top-0 z-20 shadow-(--shadow-popover)',
            sidebarSide === 'right' ? 'right-0' : 'left-0',
            !peekOpen && !drawer && (sidebarSide === 'right' ? 'invisible translate-x-full' : 'invisible -translate-x-full'),
            peekLive && 'transition-[translate,visibility] duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none'
          ]
        "
        :data-peek-zone="flyout ? 'open' : undefined"
        :data-testid="flyout ? 'sidebar-flyout' : undefined"
        @transitionend.self="!peekOpen && !drawer && (peekLive = false)"
        @focusin="onPeekFocusIn"
        @focusout="onPeekFocusOut"
      >
        <Sidebar
          ref="sidebar"
          :width="shownWidth"
          :side="sidebarSide"
          :accounts-open="props.accountsOpen"
          :collapsible="collapseMode !== 'off' && canCollapse()"
          :fill="collapsed"
          @collapse="collapseNow"
          @expand="expandWindow"
          @resize="resizeSidebar"
          @side="moveSidebar"
          @side-preview="(side: SidebarSide | null) => (sideDrop = side)"
        />
      </div>
    </div>
    <div v-if="flyout" data-peek-zone="open" aria-hidden="true" class="absolute top-0 z-19 h-full w-1.5" :class="sidebarSide === 'right' ? 'right-0' : 'left-0'" />
    <!-- The drawer's scrim, over the chat beside it: a tap shuts the drawer. -->
    <div v-if="drawer" aria-hidden="true" class="absolute inset-0 z-19 bg-black/50 duration-(--dur-slow) motion-safe:animate-in motion-safe:fade-in-0" data-testid="sidebar-scrim" @click="toggleSidebar(false)" />

    <!-- Hydra Desk 2: the chat side and the page side (AgentHydra or the Dev servers page) on one track; their buttons
         slide it (a push: one goes out to the left as the other comes in). The side out of view is inert. -->
    <!-- Never scrolled sideways: a focus or find-in-page landing near the edge would show half of each side. -->
    <div
      v-if="sideDrop"
      class="pointer-events-none absolute inset-y-0 z-30 bg-accent/15"
      :class="sideDrop === 'right' ? 'right-0' : 'left-0'"
      :style="{ width: `${sidebarWidth}px` }"
      data-testid="sidebar-drop"
    />
    <div
      v-show="!collapsed"
      ref="stageEl"
      class="relative row-span-2 row-start-1 min-w-0 overflow-hidden"
      :class="[sidebarSide === 'right' ? 'col-start-1' : 'col-start-2', slideX && ['will-change-transform', slide?.at === 'to' && SLIDE_EASE]]"
      :style="slideX && { transform: `translateX(${slideX.stage}px)` }"
      data-testid="stage"
      @scroll="(e: Event) => ((e.target as HTMLElement).scrollLeft = 0)"
    >
      <div
        class="flex h-full w-[200%] transition-transform duration-420 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        :style="{ transform: pageOpen ? 'translateX(-50%)' : 'translateX(0)' }"
      >
        <div
          ref="splitEl"
          class="grid h-full w-1/2 min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[41px_minmax(0,1fr)]"
          :style="split ? { gridTemplateColumns: splitColumns(chatWidth) } : undefined"
          :inert="pageOpen"
          :aria-hidden="pageOpen || undefined"
        >
          <div
            class="title-drag col-start-1 row-start-1 flex min-w-0 items-start pt-0.5"
            :class="[(ownFrame || railShown || railLeaving) && 'col-end-3', sliding && 'transition-[padding] duration-(--dur-slow) ease-(--ease-snap)']"
            :style="{ paddingInlineStart: `${titleStart}px`, paddingInlineEnd: sidebarSide === 'right' ? `${titlePadEnd}px` : undefined }"
          >
            <ShellHeader
              class="min-w-0 flex-1"
              :chat="isNew ? null : chat"
              :title="viewTitle"
              :pane="pane"
              :accounts="src.accounts.value"
              :external="external"
              :stand-in="standIn"
              :show-thinking="showThinking"
              :groups="rowGroups"
              @action="act"
              @rename="rename"
              @toggle-pane="togglePane"
              @account="pickAccount"
              :rail-open="railShown && !railFloats"
              :tasks-running="tasksRunningCount"
              :alert="actionError && (!docked || cloud.on.value) ? actionError : ''"
              @toggle-rail="toggleRail"
              @update:show-thinking="setShowThinking"
            />
          </div>

          <main
            class="col-start-1 row-start-2 flex min-h-0 min-w-0"
            :class="railSlide && ['will-change-transform', railSlide.at === 'to' && SLIDE_EASE]"
            :style="{ '--rail-over': `${railOver}px`, ...(railSlide ? { transform: `translateX(${railShift}px)` } : {}) }"
          >
            <!-- data-file-drop: a file dropped anywhere on the chat attaches to its composer -->
            <div v-show="!tasks?.expanded && !paneOver" class="flex min-w-0 flex-1 flex-col" data-file-drop>
              <NewSessionScreen v-if="isNew" :name="greetingName" :chats="src.chats.value" />
              <div v-else-if="chat" class="min-h-0 flex-1 overflow-hidden">
                <TranscriptView :key="`${chat.id}:${showThinking}`" :chat-id="chat.id" :items="items" :chat="chat" :read-only="!!lockedChild" :expanded-ids="openThinking" :unfold-thinking="showThinking" :loading="!src.itemsByChat.value.has(chat.id)" :load-error="src.itemsError?.value.get(chat.id) ?? null" :older-count="olderCount" :loading-older="loadingOlder" :index="src.indexByChat?.value.get(chat.id) ?? null" :fetch-item="fetchChatItem" @load-older="loadOlder" />
              </div>
              <div v-else-if="view.kind === 'external'" class="min-h-0 flex-1 overflow-auto">
                <ExternalSessionView :key="view.id" :session-id="view.id" :paused="pageOpen" />
              </div>

              <div v-if="notice" role="status" data-testid="archived-notice" class="shrink-0 bg-(--bg-page) px-4 pb-1.5 pt-1">
                <p class="mx-auto w-full max-w-3xl text-center text-ui leading-4.75 text-text-muted">
                  This chat was archived.
                  <button type="button" class="rounded-(--radius-6) text-text-2 underline-offset-2 transition-colors duration-60 hover:text-(--accent-text) hover:underline focus-visible:underline" @click="unarchive">Click here to unarchive.</button>
                </p>
              </div>

              <div v-if="lockedChild" role="status" data-testid="readonly-child-notice" class="shrink-0 bg-(--bg-page) px-4 pb-1.5 pt-1">
                <p class="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-2 text-center text-ui leading-4.75 text-text-muted">
                  <span>{{ lockedChild.parentTitle }} runs this chat. To change anything, tell it.</span>
                  <button type="button" class="rounded-(--radius-6) text-text-2 underline-offset-2 transition-colors duration-60 hover:text-(--accent-text) hover:underline focus-visible:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline" :disabled="!lockedParentFound" :title="lockedParentFound ? undefined : LOCKED_TITLE" @click="tellParent">Tell {{ lockedChild.parentTitle }}</button>
                </p>
              </div>

              <Composer
                ref="composer"
                v-if="(chat || isNew) && !lockedChild"
                :chat="isNew ? null : chat"
                :demo="props.demo ? { cwd: view.kind === 'new' ? view.cwd : undefined } : undefined"
              />
            </div>
          </main>

          <!-- Servers and Changes-with-RepoYeti take the full height of the chat area, from the title bar row down, so the title bar's
               buttons end at the pane's left edge; plain Changes, Connections and CliMayte sit under the title bar. When
               the window draws its own title bar (lib/host-window.ts) that row is the window's, across the whole width,
               with the pane buttons beside the window's buttons, so every pane starts under it. Narrow, every pane takes the chat's
               cell under the title bar, the whole width, with a row back to the chat over it (paneOver). -->
          <aside
            v-if="asideOpen"
            class="relative flex min-h-0 min-w-0 shrink-0"
            :class="paneOver ? 'col-start-1 row-start-2 pt-9' : ['col-start-2 border-s border-border', split ? (ownFrame ? 'row-start-2' : 'row-span-2 row-start-1') : 'row-start-2 w-95']"
            :aria-label="pane === 'diff' ? 'Changes' : pane === 'servers' ? 'Servers' : pane === 'connections' ? 'Connections' : pane === 'todo' ? 'To-do' : 'CliMayte'"
          >
            <div v-if="paneOver" class="absolute inset-x-0 top-0 flex h-9 items-center border-b border-border px-1.5" data-testid="pane-back-row">
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-(--radius-8) ps-1.5 pe-2.5 text-ui font-medium text-text-2 hover:bg-fill-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="pane = null"
              >
                <ArrowLeft class="size-4" aria-hidden="true" />
                Back to the chat
              </button>
            </div>
            <div
              v-if="split"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the chat and the pane"
              tabindex="0"
              :aria-valuenow="chatAt"
              :aria-valuemin="CHAT_MIN"
              class="absolute -left-1.5 top-0 z-22 h-full w-3 cursor-col-resize touch-none focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
              @pointerdown.prevent="onSplitDown"
              @keydown="onSplitKey"
            />
            <ChangesPane v-if="pane === 'diff' && chat" :key="chat.cwd" :cwd="chat.cwd" @close="pane = null" />
            <ServersPane v-else-if="pane === 'servers' && serversDir" :key="chat?.id ?? viewKey" :chat-id="chat?.id ?? viewKey" :cwd="serversDir" :focus="serversFocus" :ai-browser="aiBrowser" :paused="pageOpen" @close="pane = null" />
            <ConnectionsPane v-else-if="pane === 'connections' && chat" :key="chat.id" :chat="chat" />
            <FourmanPane v-else-if="pane === 'todo' && todoDir" :key="todoDir" :cwd="todoDir" @close="pane = null" />
            <!-- Narrow, it shrinks to the window: a long task's title is cut short instead of drawing it wider than the screen. -->
            <CliMaytePanel v-else :class="paneOver && 'min-w-0 flex-1'" :origin-session-id="chat?.sessionId" :worker-ids="chat?.workerIds" />
          </aside>

          <!-- Expanded, Background tasks takes the chat's place under the title bar (the same cell as main, whose content hides). -->
          <aside v-if="tasks?.expanded" class="relative col-start-1 row-start-2 flex min-w-0 pb-2 pe-2 ps-2 pt-0.5">
            <BackgroundTasksPanel
              :session-id="tasksSessionId"
              :worker-ids="tasksWorkerIds"
              :items="tasksItems"
              :index="tasksIndex"
              :chat-id="outsideId ? null : chat?.id"
              :climayte="!outsideId && chat?.workerId !== undefined"
              :focus-id="tasks.focus"
              expanded
              @close="tasks = null"
              @toggle-expand="tasks && (tasks = { ...tasks, expanded: false })"
            />
          </aside>

          <!-- The session rail: a column under the title bar only as wide as the room it takes from the chat (railRoom), the rail
               itself right-aligned in it, lying over the chat's empty margin when it is wider than that. -->
          <aside
            v-if="railShown || railLeaving"
            class="pointer-events-none relative z-11 col-start-2 row-start-2 min-h-0"
            :style="{ width: `${railShown ? railRoom : 0}px` }"
            aria-label="Session details"
          >
            <div
              class="absolute inset-y-0 right-0 pe-2 pt-0.5"
              :class="railSlide?.at === 'to' && SLIDE_EASE"
              :style="{ width: `${railAt + RAIL_INSET}px`, transform: railSlide ? `translateX(${railOut ? '100%' : '0'})` : undefined }"
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize session details"
                tabindex="0"
                :aria-valuenow="railAt"
                :aria-valuemin="RAIL_MIN"
                :aria-valuemax="RAIL_MAX"
                class="pointer-events-auto absolute -left-1.5 top-0 z-22 h-full w-3 cursor-col-resize touch-none focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
                @pointerdown.prevent="onRailResizeDown"
                @keydown="onRailResizeKey"
              />
              <SessionRail
                :chat="outsideId ? null : chat"
                :outside="!!outsideId"
                :items="tasksItems"
                :index="tasksIndex"
                :session-id="tasksSessionId"
                :worker-ids="tasksWorkerIds"
                :chat-id="outsideId ? null : chat?.id"
                :climayte="!outsideId && chat?.workerId !== undefined"
                :tasks="tasks"
                @open-tasks="(focus: string | null) => (tasks = { focus, expanded: false })"
                @back="closeRailTasks(false)"
                @close="closeRailTasks(true)"
                @toggle-expand="tasks = { focus: tasks?.focus ?? null, expanded: true }"
              />
            </div>
          </aside>
        </div>
        <!-- The page side: AgentHydra and the Dev servers page are layers of it, the one on screen at 0, one being pushed
             out to the left, the other waiting on the right. -->
        <div class="relative h-full w-1/2 min-w-0 overflow-hidden" :inert="!pageOpen" :aria-hidden="!pageOpen || undefined" @scroll="(e: Event) => ((e.target as HTMLElement).scrollLeft = 0)">
          <div class="absolute inset-0" :class="layerSlides('hydra') && PAGE_SLIDE" :style="{ transform: layerAt('hydra') }" :inert="slotPage !== 'hydra'" :aria-hidden="slotPage !== 'hydra' || undefined">
            <HydraPane
              :open="hydraOpen"
              :pad-left="titleStart"
              :preload="sidebarReady"
              :intent="hydraIntent"
              @close="toggleHydra(false)"
              @open-session="(id: string) => src.select({ kind: 'external', id })"
              @show-sessions="showSessions"
              @open-settings="openSettingsOn"
            />
          </div>
          <div class="absolute inset-0 flex" :class="layerSlides('dev') && PAGE_SLIDE" :style="{ transform: layerAt('dev') }" :inert="slotPage !== 'dev'" :aria-hidden="slotPage !== 'dev' || undefined" data-testid="dev-page">
            <InfoPane v-if="devMounted" :sel="devShown" :active="devPage" :pad-left="titleStart" @close="devServers.closePage()" />
          </div>
          <div class="absolute inset-0 flex" :class="layerSlides('dash') && PAGE_SLIDE" :style="{ transform: layerAt('dash') }" :inert="slotPage !== 'dash'" :aria-hidden="slotPage !== 'dash' || undefined" data-testid="dashboard-page-layer">
            <DashboardPage v-if="dashMounted" :cwd="dashboardCwd" :active="dashboardOpen" :pad-left="titleStart" />
          </div>
        </div>
      </div>
    </div>

    <Dialog :open="settingsOpen" @update:open="(o: boolean) => !o && closeSettings()">
      <DialogContent
        flush
        :aria-describedby="undefined"
        @open-auto-focus="focusSettingsNav"
        class="flex h-[min(680px,calc(100vh-48px))] max-h-none w-[min(920px,calc(100vw-48px))] max-w-none flex-col overflow-hidden rounded-(--radius-12) shadow-(--shadow-popover) ring-0 sm:max-w-none"
      >
        <DialogTitle class="sr-only">Settings</DialogTitle>
        <SettingsView />
      </DialogContent>
    </Dialog>

    <WhatsNewDialog />
    <PeopleFirstRun />
    <WindowControls v-if="ownFrame && !collapsed" />
  </div>
</template>
