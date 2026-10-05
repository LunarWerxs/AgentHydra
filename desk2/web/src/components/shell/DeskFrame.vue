<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { accountFace, groupChoices, type RowMenuItem } from '@/components/sidebar/logic'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import Composer from '@/components/composer/Composer.vue'
import { OPEN_CLIMAYTE_EVENT, OPEN_DIFF_EVENT } from '@/components/composer/api'
import CliMaytePanel from '@/components/climayte/CliMaytePanel.vue'
import DiffPane from '@/components/panes/DiffPane.vue'
import ServersPane from '@/components/servers/ServersPane.vue'
import { clampPane, loadPaneWidth, PANE_KEY } from '@/components/servers/logic'
import SettingsView from '@/components/panes/SettingsView.vue'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import ExternalSessionView from '@/components/external/ExternalSessionView.vue'
import HydraPane from '@/components/hydra/HydraPane.vue'
import { OPEN_HYDRA_EVENT, hydraOpen, hydraSidebar } from '@/components/hydra/api'
import { useCloud } from '@/components/cloud/store'
import { showTasks } from '@/components/sidebar/tasks'
import BackgroundTasksPanel from '@/components/tasks/BackgroundTasksPanel.vue'
import { OPEN_TASKS_EVENT, cleared, outsideTasks, type OpenTasksDetail } from '@/components/tasks/api'
import { panelLists } from '@/components/tasks/logic'
import ChromeBar from './ChromeBar.vue'
import ShellHeader, { type RightPane } from './ShellHeader.vue'
import NewSessionScreen from './NewSessionScreen.vue'
import { NavHistory, SidebarPeek, matchShortcut, viewUnder, type View } from './logic'
import { useShellSource } from './source'
import { restartServer, updateOffer } from '@/lib/server-update'

// The whole window: sidebar (288, resizable), the chrome bar over its top, and the pane with the
// title bar, the view, the composer and an optional right pane.
const props = defineProps<{
  /** Gallery only: the composer renders from fixtures. */ demo?: boolean
  /** Gallery only: the account popup starts open. */ accountsOpen?: boolean
  /** Gallery only: the sidebar starts hidden. */ sidebarHidden?: boolean
  /** Gallery and parity only: views visited before the current one, so Back starts enabled. */ history?: View[]
}>()

const src = useShellSource()
// Settings is a dialog over the window: under it stays the last other view, and closing it (Esc, the X)
// selects that view again.
const under = ref<View>(src.selected.value.kind === 'settings' ? (props.history?.at(-1) ?? { kind: 'new' }) : src.selected.value)
watch(
  () => src.selected.value,
  (v) => {
    if (v.kind !== 'settings') under.value = v
  }
)
const view = computed<View>(() => viewUnder(src.selected.value, under.value))
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
const focusSettingsNav = (e: Event) => {
  e.preventDefault()
  ;(e.target as HTMLElement | null)?.querySelector<HTMLElement>('[data-section][aria-current="page"]')?.focus()
}
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
const sidebarWidth = ref(savedWidth >= 240 && savedWidth <= 420 ? savedWidth : 288)
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

// Back / Forward
const history = new NavHistory()
for (const v of props.history ?? []) history.visit(v)
const canBack = ref(false)
const canForward = ref(false)
function syncNav() {
  canBack.value = history.canBack
  canForward.value = history.canForward
}
function travel(dir: 'back' | 'forward') {
  let next = dir === 'back' ? history.back() : history.forward()
  // Skip chats that were deleted since.
  while (next && next.kind === 'chat' && !src.chats.value.some((c) => c.id === (next as { id: string }).id)) {
    history.forget(next.id)
    next = dir === 'back' ? history.back() : history.forward()
  }
  if (next) src.select(next)
  syncNav()
}
watch(
  view,
  (v) => {
    history.visit(v.kind === 'chat' && !chat.value ? { kind: 'new' } : v)
    syncNav()
  },
  { immediate: true }
)

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
// sidebar is the list of AgentHydra's current tab where it has one (CliMayte's tasks, HSwarm's tree:
// components/hydra/HydraSidebar.vue), else AgentHydra's session list (the cloud list, turned on for it
// and off again after unless it was already on); a session clicked there opens on Desk's side. Picking anything of Desk's own in
// the sidebar slides the chat back. The cloud button turns the sidebar's list into every session of
// both PCs on its own too (components/cloud).
const cloud = useCloud()
let cloudForHydra = false
function toggleHydra(open = !hydraOpen.value) {
  if (open === hydraOpen.value) return
  hydraOpen.value = open
  if (open) {
    cloudForHydra = !cloud.on.value
    cloud.on.value = true
    toggleSidebar(true)
  } else if (cloudForHydra) {
    cloudForHydra = false
    cloud.on.value = false
  }
}
const onOpenHydra = () => toggleHydra(true)
// Picking anything slides the chat back; an outside session came from the cloud list, which stays.
watch(
  () => src.selected.value,
  (v) => {
    if (!hydraOpen.value) return
    if (v.kind === 'external') cloudForHydra = false
    toggleHydra(false)
  }
)
function showSessions() {
  cloudForHydra = false
  cloud.on.value = true
  toggleHydra(false)
}
function toggleCloud() {
  cloud.on.value = !cloud.on.value
  cloudForHydra = false
  if (cloud.on.value) toggleSidebar(true)
}
function toggleTasks() {
  showTasks.value = !showTasks.value
  if (!showTasks.value) return
  toggleSidebar(true)
  // An AgentHydra tab with a list of its own (CliMayte, HSwarm) has the sidebar while it is open, so the
  // tasks would not show: slide back to the desk, as showSessions does (Michael, 2026-10-04: "toggling ...
  // does nothing in the sidebar").
  if (hydraOpen.value && hydraSidebar.value) toggleHydra(false)
}

// Right pane
const pane = ref<RightPane | null>(null)
function togglePane(p: RightPane) {
  pane.value = pane.value === p ? null : p
}
// The servers pane is wider than Changes (a browser needs room); its width is dragged and remembered.
const serversWidth = ref(loadPaneWidth())
function resizeServers(w: number) {
  serversWidth.value = clampPane(w, window.innerWidth * 0.7)
  storage?.setItem(PANE_KEY, String(serversWidth.value))
}
const onOpenDiff = () => (pane.value = 'diff')
const onOpenCliMayte = () => (pane.value = 'climayte')
// Background tasks (the inline row, a workflow card, desk.openBackgroundTasks()) takes the right pane's place.
// Open or closed (and expanded) is remembered per chat: switching chats shows each one's own state.
type TasksState = { focus: string | null; expanded: boolean }
const viewKey = computed(() => {
  const v = view.value
  return v.kind === 'chat' || v.kind === 'external' ? `${v.kind}:${v.id}` : v.kind
})
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
  window.addEventListener('keydown', onKey)
  window.addEventListener(OPEN_DIFF_EVENT, onOpenDiff)
  window.addEventListener(OPEN_CLIMAYTE_EVENT, onOpenCliMayte)
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
  window.removeEventListener(OPEN_TASKS_EVENT, onOpenTasks)
  window.removeEventListener(OPEN_HYDRA_EVENT, onOpenHydra)
  document.removeEventListener('pointermove', onPeekPointer)
  document.removeEventListener('pointerout', onPeekPointerOut)
  window.removeEventListener('focus', markOpenRead)
  document.removeEventListener('visibilitychange', onVisibility)
  if (slideTimer) clearTimeout(slideTimer)
  peek.dispose()
})

// With the sidebar hidden the title bar starts after the chrome bar's buttons (CliMayte, after Forward,
// AgentHydra and Cloud, ends at 230).
const CHROME_COLLAPSED = 238
const titlePad = computed(() => (sidebarOpen.value ? 9 : CHROME_COLLAPSED))
</script>

<template>
  <!-- DOM order is the tab order: chrome bar, sidebar, then the pane (title bar first); the grid places them. -->
  <div class="relative grid h-full w-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[41px_minmax(0,1fr)] overflow-hidden bg-bg-page text-text">
    <ChromeBar
      :sidebar-open="sidebarOpen"
      :width="sidebarWidth"
      :can-back="canBack"
      :can-forward="canForward"
      :hydra-open="hydraOpen"
      :cloud-on="cloud.on.value"
      :tasks-on="showTasks"
      :update="demo ? null : updateOffer"
      @restart="restartServer"
      @hydra="toggleHydra()"
      @cloud="toggleCloud"
      @tasks="toggleTasks"
      @new="src.select({ kind: 'new' })"
      @search="openSearch"
      @toggle-sidebar="toggleSidebar()"
      @back="travel('back')"
      @forward="travel('forward')"
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

    <!-- Hydra Desk 2: the chat side and AgentHydra side by side on one track; the AgentHydra button slides it
         (a push: one goes out to the left as the other comes in). The side out of view is inert. -->
    <!-- Never scrolled sideways: a focus or find-in-page landing near the edge would show half of each side. -->
    <div class="relative col-start-2 row-span-2 row-start-1 min-w-0 overflow-hidden" data-testid="stage" @scroll="(e: Event) => ((e.target as HTMLElement).scrollLeft = 0)">
      <div
        class="flex h-full w-[200%] transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        :style="{ transform: hydraOpen ? 'translateX(-50%)' : 'translateX(0)' }"
      >
        <div class="grid h-full w-1/2 min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[41px_minmax(0,1fr)]" :inert="hydraOpen" :aria-hidden="hydraOpen || undefined">
          <div
            class="col-start-1 row-start-1 min-w-0 pt-0.5"
            :class="sliding ? 'transition-[padding] duration-[var(--dur-slow)] ease-[var(--ease-snap)]' : ''"
            :style="{ paddingLeft: `${titlePad}px` }"
          >
            <ShellHeader
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

              <Composer
                ref="composer"
                v-if="chat || isNew"
                :chat="isNew ? null : chat"
                :demo="props.demo ? { cwd: view.kind === 'new' ? view.cwd : undefined } : undefined"
              />
            </div>

            <aside
              v-if="!tasks && pane && (pane === 'climayte' || chat)"
              class="flex shrink-0 border-l border-border"
              :class="pane === 'servers' ? '' : 'w-[380px]'"
              :style="pane === 'servers' ? { width: `${serversWidth}px` } : undefined"
              :aria-label="pane === 'diff' ? 'Changes' : pane === 'servers' ? 'Servers' : 'CliMayte'"
            >
              <DiffPane v-if="pane === 'diff' && chat" :key="chat.cwd" :cwd="chat.cwd" />
              <ServersPane v-else-if="pane === 'servers' && chat" :cwd="chat.cwd" :width="serversWidth" @close="pane = null" @resize="resizeServers" />
              <CliMaytePanel v-else :origin-session-id="chat?.sessionId" :worker-ids="chat?.workerIds" />
            </aside>
          </main>

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
              :focus-id="tasks.focus"
              :expanded="tasks.expanded"
              @close="tasks = null"
              @toggle-expand="tasks && (tasks = { ...tasks, expanded: !tasks.expanded })"
            />
          </aside>
        </div>
        <div class="h-full w-1/2 min-w-0" :inert="!hydraOpen" :aria-hidden="!hydraOpen || undefined">
          <HydraPane
            :open="hydraOpen"
            :pad-left="titlePad"
            @close="toggleHydra(false)"
            @open-session="(id: string) => src.select({ kind: 'external', id })"
            @show-sessions="showSessions"
          />
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
