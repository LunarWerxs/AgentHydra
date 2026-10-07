<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { accountFace, groupChoices, type RowMenuItem } from '@/components/sidebar/logic'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import Composer from '@/components/composer/Composer.vue'
import { OPEN_CLIMAYTE_EVENT, OPEN_DIFF_EVENT, OPEN_REPOYETI_EVENT } from '@/components/composer/api'
import { OPEN_BROWSER_EVENT, type BrowserOpenRequest } from '@shared/browser'
import { lastBrowserRequest } from '@/components/transcript/lib/tools'
import CliMaytePanel from '@/components/climayte/CliMaytePanel.vue'
const ChangesPane = lazyPanel(() => import('@/components/panes/ChangesPane.vue'))
const ServersPane = lazyPanel(() => import('@/components/servers/ServersPane.vue'))
const loadInfoPane = () => import('@/components/servers/info/InfoPane.vue')
const InfoPane = lazyPanel(loadInfoPane)
const ConnectionsPane = lazyPanel(() => import('@/components/connectors/ConnectionsPane.vue'))
import type { ServerFocus } from '@/components/servers/store'
import type { DevSelection } from '@/components/servers/info/selection'
const loadSettingsView = () => import('@/components/panes/SettingsView.vue')
const SettingsView = lazyPanel(loadSettingsView)
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import ExternalSessionView from '@/components/external/ExternalSessionView.vue'
import HydraPane from '@/components/hydra/HydraPane.vue'
import { OPEN_HYDRA_EVENT, hydraOpen, hydraShown } from '@/components/hydra/api'
import { useCloud } from '@/components/cloud/store'
import { useDevServers } from '@/components/servers/store'
import { setChatLive } from '@/components/servers/background-views'
import { showTasks } from '@/components/sidebar/tasks'
import { cleanSidebar } from '@/components/sidebar/clean'
const BackgroundTasksPanel = lazyPanel(() => import('@/components/tasks/BackgroundTasksPanel.vue'))
import { OPEN_TASKS_EVENT, cleared, outsideTasks, type OpenTasksDetail } from '@/components/tasks/api'
import { panelLists } from '@/components/tasks/logic'
import ChromeBar from './ChromeBar.vue'
import ShellHeader, { type RightPane } from './ShellHeader.vue'
import { changesTabFor } from '@/components/connectors/logic'
import { changesTab, repoYeti, setChangesTab } from '@/components/connectors/repoyeti-state'
import NewSessionScreen from './NewSessionScreen.vue'
import { CHAT_DEFAULT, CHAT_MIN, NavHistory, archivedNotice, SidebarPeek, chatViewOf, matchShortcut, splitChat, splitColumns, viewUnder, type View } from './logic'
import { useElementSize } from '@vueuse/core'
import { rememberScreen, restoreScreen, type ScreenMemory } from '@/lib/view-memory'
import { useShellSource } from './source'
import { restartServer, updateOffer } from '@/lib/server-update'
import { lazyPanel } from '@/lib/lazy-panel'
import { requestedSection } from '@/components/panes/settings-request'
import type { SettingsSection } from '@/components/panes/settings'
import { actionError } from '@/lib/action-error'

// The whole window: sidebar (288, resizable), the chrome bar over its top, and the pane with the
// title bar, the view, the composer and an optional right pane.
const props = defineProps<{
  /** Gallery only: the composer renders from fixtures. */ demo?: boolean
  /** Gallery only: the account popup starts open. */ accountsOpen?: boolean
  /** Gallery only: the sidebar starts hidden. */ sidebarHidden?: boolean
  /** Gallery and parity only: views visited before the current one, so Alt + Left has somewhere to go. */ history?: View[]
}>()

const src = useShellSource()
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
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
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
// The Background tasks panel for an outside session: its id, and the transcript its view published.
const outsideId = computed(() => (view.value.kind === 'external' ? view.value.id : null))
const tasksSessionId = computed(() => outsideId.value ?? chat.value?.sessionId)
const tasksItems = computed(() =>
  outsideId.value ? (outsideTasks.value?.sessionId === outsideId.value ? outsideTasks.value.items : []) : items.value
)
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
const SIDEBAR_KEY = 'hydra-desk.sidebar.width'
const storage = typeof localStorage === 'undefined' ? null : localStorage
const savedWidth = Number(storage?.getItem(SIDEBAR_KEY))
// A width saved before the minimum rose to 250 (Sidebar.vue's MIN_WIDTH) is raised to it.
const sidebarWidth = ref(savedWidth >= 240 && savedWidth <= 420 ? Math.max(250, savedWidth) : 288)
// Open or hidden (header toggle, Ctrl+B), remembered; the width animates 300ms on the snap ease.
const OPEN_KEY = 'hydra-desk.sidebar.open'
const sidebarOpen = ref(props.sidebarHidden ? false : storage?.getItem(OPEN_KEY) !== '0')
const sliding = ref(false)
let slideTimer: ReturnType<typeof setTimeout> | null = null
function toggleSidebar(open = !sidebarOpen.value) {
  if (open === sidebarOpen.value) return
  // Pinning the flyout open: it is already on screen, so the layout snaps under it without a slide.
  const fromPeek = open && peekOpen.value
  peek.close()
  peekLive.value = false
  peekArmed = false
  sliding.value = !fromPeek
  sidebarOpen.value = open
  storage?.setItem(OPEN_KEY, open ? '1' : '0')
  if (slideTimer) clearTimeout(slideTimer)
  if (!fromPeek) slideTimer = setTimeout(() => (sliding.value = false), 320)
}
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null)

// Collapsed, the sidebar slides in over the content (the layout stays) while the pointer is on the
// show-sidebar toggle, a 6px strip at the window's left edge or the flyout itself. Zones are marked
// data-peek-zone: 'open' opens it, 'keep' (the chrome bar over its top) only keeps it open. A menu
// opened from the flyout lives in a portal and counts as part of it.
const flyout = computed(() => !sidebarOpen.value && !sliding.value)
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
  () => peek.close()
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
  storage?.setItem(SIDEBAR_KEY, String(pendingWidth))
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
    if (c.unread && (opened || document.hasFocus())) void src.updateChat(id, { unread: false }).catch(() => {}) // floor-ok
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
    cloudForHydra = !cloud.on.value
    cloud.on.value = true
    toggleSidebar(true)
  } else if (cloudForHydra) {
    cloudForHydra = false
    cloud.on.value = false
  }
  keepHydra()
}
function keepHydra() {
  if (!props.demo) rememberScreen({ hydra: hydraOpen.value ? { cloud: cloudForHydra } : undefined })
}
// A reload with AgentHydra open opens it again, on the tab it showed (the pane keeps its own tab).
if (kept.hydra) {
  toggleHydra(true)
  cloudForHydra = kept.hydra.cloud
  keepHydra()
}
const onOpenHydra = () => toggleHydra(true)
// Picking anything slides the chat back, from AgentHydra or the Dev servers page; an outside session came from the
// cloud list, which stays. Settings is a pop-up over whatever is on screen, so opening and closing it leaves the page
// where it is: a table's gear opens its Instances page over the table, and closing Settings goes back to it.
watch(
  () => src.selected.value,
  (v, was) => {
    if (v.kind === 'settings' || was?.kind === 'settings') return
    devServers.closePage()
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
  toggleSidebar(true)
}
if (kept.dev && !kept.hydra && devServers.on.value) devServers.openPage()
function toggleTasks() {
  showTasks.value = !showTasks.value
  if (!showTasks.value) return
  toggleSidebar(true)
  // An AgentHydra tab with a list of its own (HSwarm's tree) has the sidebar while it is open, so the
  // tasks would not show: slide back to the desk, as showSessions does (Michael, 2026-10-04: "toggling ...
  // does nothing in the sidebar").
  if (hydraOpen.value && hydraShown.value) toggleHydra(false)
}

const toggleClean = () => (cleanSidebar.value = !cleanSidebar.value)

// Right pane: which one is open, or none, is remembered per chat (and per outside session), so opening the browser in
// one chat leaves the others as they were. Background tasks below is kept the same way.
const viewKey = computed(() => {
  const v = view.value
  return v.kind === 'chat' || v.kind === 'external' ? `${v.kind}:${v.id}` : v.kind
})
const paneByView = ref(new Map<string, RightPane>())
const pane = computed<RightPane | null>({
  get: () => paneByView.value.get(viewKey.value) ?? null,
  set: (p) => {
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
watch(
  () => chat.value?.id,
  () => (serversCwd.value = null)
)
watch(pane, (p) => {
  if (p !== 'servers') serversCwd.value = null
})
// The page side of the track (owner, 2026-10-07: the right-hand info pane "kind of ugly ... just be in the center of the
// page ... like Hydra slides in"): AgentHydra and the Dev servers page are its two layers. Opened from the desk, the
// track pushes the chat out and the page in; one page opened over the other pushes that one out within the side, the
// same 420ms push. The Dev servers page is mounted while it is open and through its slide out (it polls while mounted),
// and keeps the last selection while it leaves, so it never empties on its way.
type Page = 'hydra' | 'dev'
const devPage = computed(() => devServers.page.value)
const pageOpen = computed(() => hydraOpen.value || devPage.value)
const PAGE_SLIDE = 'transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none'
const PAGE_MS = 460
const slotPage = ref<Page>(devPage.value && !hydraOpen.value ? 'dev' : 'hydra')
const slotLeaving = ref<Page | null>(null)
let slotTimer: ReturnType<typeof setTimeout> | undefined
watch([hydraOpen, devPage], ([h, d], [wasH, wasD]) => {
  const next: Page | null = h && !wasH ? 'hydra' : d && !wasD ? 'dev' : null
  if (!next || next === slotPage.value) return
  clearTimeout(slotTimer)
  // Only a page on screen is pushed out; with the desk on screen the new one is simply there when the track slides.
  slotLeaving.value = wasH || wasD ? slotPage.value : null
  slotPage.value = next
  if (slotLeaving.value) slotTimer = setTimeout(() => (slotLeaving.value = null), PAGE_MS)
})
const layerAt = (p: Page) => (p === slotPage.value ? 'translateX(0)' : p === slotLeaving.value ? 'translateX(-100%)' : 'translateX(100%)')
const layerSlides = (p: Page) => !!slotLeaving.value && (p === slotPage.value || p === slotLeaving.value)
watch(devPage, (open) => {
  if (open && hydraOpen.value) toggleHydra(false)
  if (!props.demo) rememberScreen({ dev: open || undefined })
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
const asideOpen = computed(() => !tasks.value && !!pane.value && (pane.value === 'climayte' || !!chat.value || (pane.value === 'servers' && !!serversCwd.value)))
// A wide pane splits the stage: the chat keeps the width it was dragged to and the pane takes the rest, so resizing the
// window resizes the pane and leaves the chat as it is. The width is each chat's own, like whether its pane is open: a
// chat never dragged opens at the default. The divider on the pane's left edge drags the split, or arrow keys move it;
// each side keeps only enough room to stay usable.
const split = computed(() => wide.value && asideOpen.value)
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
// Background tasks (the inline row, a workflow card, desk.openBackgroundTasks()) takes the right pane's place.
// Open or closed (and expanded) is remembered per chat: switching chats shows each one's own state.
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
// The title bar's Background tasks button: the panel for the session on view, open or shut (a chat, or an outside session).
const tasksRunningCount = computed(
  () => panelLists({ workers: src.workers.value, items: tasksItems.value, sessionId: tasksSessionId.value, workerIds: tasksWorkerIds.value, cleared: cleared.value }).running.length
)
function toggleTasksPanel() {
  if (tasks.value) {
    tasks.value = null
    return
  }
  pane.value = null
  tasks.value = { focus: null, expanded: false }
}
function onOpenTasks(e: Event) {
  pane.value = null
  devServers.closePage()
  tasks.value = { focus: (e as CustomEvent<OpenTasksDetail>).detail?.taskId ?? null, expanded: tasks.value?.expanded ?? false }
}
watch(pane, (p) => {
  if (p) tasks.value = null
})

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

// The title bar's Account menu: a chat's next start, or where a stand-in continues.
function pickAccount(id: string) {
  const target = chat.value ?? standIn.value
  // floor-ok: a stand-in's change never fails; a chat whose PATCH fails keeps showing the account it has.
  if (target) void src.updateChat(target.id, { accountId: id }).catch(() => {})
}

// An outside session's unread mark clears the same way as a chat's, however it was opened (its row, a
// search hit, Back / Forward): on opening it, or when it turns unread while open in the focused window.
watch(
  () => [external.value?.id, external.value?.unread] as const,
  ([id, unread], before) => {
    if (!id || !unread) return
    // floor-ok: a failed read mark is retried on the next open or focus.
    if (id !== before?.[0] || document.hasFocus()) void src.updateSessionMeta(id, { unread: false }).catch(() => {})
  },
  { immediate: true }
)

// Coming back to the window reads what is open: a turn that ended while the owner was away keeps its
// unread mark until then.
function markOpenRead() {
  if (document.visibilityState === 'hidden') return
  // floor-ok: both are retried on the next open or focus.
  if (chat.value?.unread) void src.updateChat(chat.value.id, { unread: false }).catch(() => {})
  if (external.value?.unread) void src.updateSessionMeta(external.value.id, { unread: false }).catch(() => {})
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
  if (e.key === 'Escape' && peekOpen.value && !e.defaultPrevented && !overlayOpen()) {
    // Taken: a docked permission card must not read this Esc as a No.
    e.preventDefault()
    peek.close()
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
})
onBeforeUnmount(() => {
  saveWidth()
  window.removeEventListener('pagehide', saveWidth)
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
  clearTimeout(slotTimer)
  clearTimeout(devTimer)
  peek.dispose()
})

// With the sidebar hidden the title bar starts after the chrome bar's buttons (Dev servers, the last, ends at 242).
const CHROME_COLLAPSED = 250
const titlePad = computed(() => (sidebarOpen.value ? 9 : CHROME_COLLAPSED))
</script>

<template>
  <!-- DOM order is the tab order: chrome bar, sidebar, then the pane (title bar first); the grid places them. -->
  <div class="relative grid h-full w-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[41px_minmax(0,1fr)] overflow-hidden bg-bg-page text-text">
    <ChromeBar
      :sidebar-open="sidebarOpen"
      :width="sidebarWidth"
      :sliding="sliding"
      :hydra-open="hydraOpen"
      :cloud-on="cloud.on.value"
      :tasks-on="showTasks"
      :dev-on="devServers.on.value"
      :clean-on="cleanSidebar"
      :update="demo ? null : updateOffer"
      @restart="restartServer"
      @hydra="toggleHydra()"
      @cloud="toggleCloud"
      @tasks="toggleTasks"
      @dev="toggleDev"
      @clean="toggleClean"
      @new="src.select({ kind: 'new' })"
      @search="openSearch"
      @toggle-sidebar="toggleSidebar()"
      @settings="src.openSettings()"
    />

    <div
      class="col-start-1 row-span-2 row-start-1 h-full overflow-hidden"
      :class="sliding ? 'transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-snap)]' : ''"
      :style="{ width: sidebarOpen ? `${sidebarWidth}px` : '0px' }"
      :inert="!sidebarOpen && !peekOpen"
      data-testid="sidebar-slot"
    >
      <!-- Collapsed, this is the hover flyout: positioned on the window (not the 0-wide slot), under the chrome bar (z-21), below dialogs. -->
      <div
        class="h-full"
        :class="
          flyout && [
            'absolute left-0 top-0 z-20 shadow-(--shadow-popover)',
            !peekOpen && 'invisible -translate-x-full',
            peekLive && 'transition-[translate,visibility] duration-[var(--dur-slow)] ease-[var(--ease-snap)] motion-reduce:transition-none'
          ]
        "
        :data-peek-zone="flyout ? 'open' : undefined"
        :data-testid="flyout ? 'sidebar-flyout' : undefined"
        @transitionend.self="!peekOpen && (peekLive = false)"
        @focusin="onPeekFocusIn"
        @focusout="onPeekFocusOut"
      >
        <Sidebar ref="sidebar" :width="sidebarWidth" :accounts-open="props.accountsOpen" @resize="resizeSidebar" />
      </div>
    </div>
    <div v-if="flyout" data-peek-zone="open" aria-hidden="true" class="absolute left-0 top-0 z-[19] h-full w-1.5" />

    <!-- Hydra Desk 2: the chat side and the page side (AgentHydra or the Dev servers page) on one track; their buttons
         slide it (a push: one goes out to the left as the other comes in). The side out of view is inert. -->
    <!-- Never scrolled sideways: a focus or find-in-page landing near the edge would show half of each side. -->
    <div class="relative col-start-2 row-span-2 row-start-1 min-w-0 overflow-hidden" data-testid="stage" @scroll="(e: Event) => ((e.target as HTMLElement).scrollLeft = 0)">
      <div
        class="flex h-full w-[200%] transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
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
            class="col-start-1 row-start-1 flex min-w-0 items-start pt-0.5"
            :class="sliding ? 'transition-[padding] duration-[var(--dur-slow)] ease-[var(--ease-snap)]' : ''"
            :style="{ paddingLeft: `${titlePad}px` }"
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
              :tasks-open="!!tasks"
              :tasks-running="tasksRunningCount"
              :alert="actionError && (!sidebarOpen || cloud.on.value) ? actionError : ''"
              @toggle-tasks="toggleTasksPanel"
              @update:show-thinking="setShowThinking"
            />
          </div>

          <main class="col-start-1 row-start-2 flex min-h-0 min-w-0">
            <div v-show="!tasks?.expanded" class="flex min-w-0 flex-1 flex-col">
              <NewSessionScreen v-if="isNew" :name="greetingName" :chats="src.chats.value" />
              <div v-else-if="chat" class="min-h-0 flex-1 overflow-hidden">
                <TranscriptView :key="`${chat.id}:${showThinking}`" :chat-id="chat.id" :items="items" :chat="chat" :expanded-ids="openThinking" :loading="!src.itemsByChat.value.has(chat.id)" :load-error="src.itemsError?.value.get(chat.id) ?? null" />
              </div>
              <div v-else-if="view.kind === 'external'" class="min-h-0 flex-1 overflow-auto">
                <ExternalSessionView :key="view.id" :session-id="view.id" />
              </div>

              <div v-if="notice" role="status" data-testid="archived-notice" class="shrink-0 bg-[var(--bg-page)] px-4 pb-1.5 pt-1">
                <p class="mx-auto w-full max-w-[768px] text-center text-[13px] leading-[19px] text-text-muted">
                  This chat was archived.
                  <button type="button" class="rounded-[var(--radius-6)] text-text-2 underline-offset-2 transition-colors duration-[60ms] hover:text-[var(--accent-text)] hover:underline focus-visible:underline" @click="unarchive">Click here to unarchive.</button>
                </p>
              </div>

              <Composer
                ref="composer"
                v-if="chat || isNew"
                :chat="isNew ? null : chat"
                :demo="props.demo ? { cwd: view.kind === 'new' ? view.cwd : undefined } : undefined"
              />
            </div>
          </main>

          <!-- Servers and Changes-with-RepoYeti take the full height of the chat area, from the title bar row down, so the title bar's
               buttons end at the pane's left edge; plain Changes, Connections and CliMayte sit under the title bar. -->
          <aside
            v-if="asideOpen"
            class="relative col-start-2 flex min-h-0 min-w-0 shrink-0 border-l border-border"
            :class="split ? 'row-span-2 row-start-1' : 'row-start-2 w-[380px]'"
            :aria-label="pane === 'diff' ? 'Changes' : pane === 'servers' ? 'Servers' : pane === 'connections' ? 'Connections' : 'CliMayte'"
          >
            <div
              v-if="split"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the chat and the pane"
              tabindex="0"
              :aria-valuenow="chatAt"
              :aria-valuemin="CHAT_MIN"
              class="absolute -left-1.5 top-0 z-[22] h-full w-3 cursor-col-resize touch-none focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
              @pointerdown.prevent="onSplitDown"
              @keydown="onSplitKey"
            />
            <ChangesPane v-if="pane === 'diff' && chat" :key="chat.cwd" :cwd="chat.cwd" @close="pane = null" />
            <ServersPane v-else-if="pane === 'servers' && serversDir" :key="chat?.id ?? viewKey" :chat-id="chat?.id ?? viewKey" :cwd="serversDir" :focus="serversFocus" :ai-browser="aiBrowser" @close="pane = null" />
            <ConnectionsPane v-else-if="pane === 'connections' && chat" :key="chat.id" :chat="chat" />
            <CliMaytePanel v-else :origin-session-id="chat?.sessionId" :worker-ids="chat?.workerIds" />
          </aside>

          <!-- Docked, the panel is a full-height third column: the title bar's buttons end left of it instead of
               sitting over it. Expanded, it takes the pane under the title bar (the same cell as main, whose content hides). -->
          <aside
            v-if="tasks"
            class="flex min-w-0 pb-2 pr-2"
            :class="tasks.expanded ? 'col-start-1 row-start-2 pl-2 pt-0.5' : 'col-start-2 row-span-2 row-start-1 w-[440px] pt-2'"
          >
            <BackgroundTasksPanel
              :session-id="tasksSessionId"
              :worker-ids="tasksWorkerIds"
              :items="tasksItems"
              :chat-id="outsideId ? null : chat?.id"
              :climayte="!outsideId && chat?.workerId !== undefined"
              :focus-id="tasks.focus"
              :expanded="tasks.expanded"
              @close="tasks = null"
              @toggle-expand="tasks && (tasks = { ...tasks, expanded: !tasks.expanded })"
            />
          </aside>
        </div>
        <!-- The page side: AgentHydra and the Dev servers page are layers of it, the one on screen at 0, one being pushed
             out to the left, the other waiting on the right. -->
        <div class="relative h-full w-1/2 min-w-0 overflow-hidden" :inert="!pageOpen" :aria-hidden="!pageOpen || undefined" @scroll="(e: Event) => ((e.target as HTMLElement).scrollLeft = 0)">
          <div class="absolute inset-0" :class="layerSlides('hydra') && PAGE_SLIDE" :style="{ transform: layerAt('hydra') }" :inert="slotPage !== 'hydra'" :aria-hidden="slotPage !== 'hydra' || undefined">
            <HydraPane
              :open="hydraOpen"
              :pad-left="titlePad"
              @close="toggleHydra(false)"
              @open-session="(id: string) => src.select({ kind: 'external', id })"
              @show-sessions="showSessions"
              @open-settings="openSettingsOn"
            />
          </div>
          <div class="absolute inset-0 flex" :class="layerSlides('dev') && PAGE_SLIDE" :style="{ transform: layerAt('dev') }" :inert="slotPage !== 'dev'" :aria-hidden="slotPage !== 'dev' || undefined" data-testid="dev-page">
            <InfoPane v-if="devMounted" :sel="devShown" :active="devPage" :pad-left="titlePad" @close="devServers.closePage()" />
          </div>
        </div>
      </div>
    </div>

    <Dialog :open="settingsOpen" @update:open="(o: boolean) => !o && closeSettings()">
      <DialogContent
        flush
        :aria-describedby="undefined"
        @open-auto-focus="focusSettingsNav"
        class="flex h-[min(680px,calc(100vh_-_48px))] max-h-none w-[min(920px,calc(100vw_-_48px))] max-w-none flex-col overflow-hidden rounded-[var(--radius-12)] shadow-(--shadow-popover) ring-0 sm:max-w-none"
      >
        <DialogTitle class="sr-only">Settings</DialogTitle>
        <SettingsView />
      </DialogContent>
    </Dialog>
  </div>
</template>
