<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { AppWindow, Globe, Plus, RefreshCw, Search, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { BROWSER_CLOSED_EVENT, type BrowserOpenRequest, type BrowserProfiles } from '@shared/browser'
import { processAddress, type DevWebProcess, type LocalServers } from '@shared/devwebui'
import { browserClose, browserProfiles, localhostServers, processLogs, setUpFolder } from './api'
import { activateTab, closeTab, findServer, focusPlan, type FolderSetup, loadTabs, NEW_TAB, needsSetup, openPlan, openTab, otherRunning, type PaneTab, pageTitle, paneView, profileRows, requestTab, retargetTab, REUSED_NOTE, saveTabs, startBlock, statusDot, tailLines, type TabsState, type TabSpec, isUp } from './logic'
import { type ServerFocus, useDevServers } from './store'
import { browserRequest, claimBrowserRequest } from './browser-request'
import { backgroundViews } from './background-views'
import NewTab from './NewTab.vue'
import PageTab from './PageTab.vue'
import SavedBrowsers from './SavedBrowsers.vue'
import { DOT, ICON_BTN } from './styles'

// The right-hand pane (title bar's Browser button): a browser's tab strip over the active tab. A New tab lists this
// chat's localhost servers (Start / Stop / Restart; a click or Start opens one in the tab) and the workspace's
// saved browsers, narrowed by its address bar; a page tab shows a server or an address in a frame; a saved tab is a
// saved browser, live. Each chat has tabs of its own, remembered, starting on the browser its AI last used, else on a
// New tab. A folder that is not a project yet is set up by itself
// (POST /dw/folder): from Claude Code's .claude/launch.json or package.json's dev scripts, every server stopped.
// Nothing is started by hand: Desk starts the dev-servers service for the first request that needs it (the pane shows
// 'starting' meanwhile), and the status and the project list come from the window's one client (store.ts), which the
// sidebar's Dev servers list reads too and which polls while either is on screen and the window is. `focus` is that list's
// request: show this server (its folder is `cwd`). A Start that finds the server already up (Desk's, or one run outside)
// opens the running copy and says so in a small notice. After them the New tab lists "Other localhost servers": what
// listens on this machine that no project lists (GET /dw/localhost), open-only, scanned at most every 8 s.
/** aiBrowser: the browser this chat's AI last used, which a chat with no tabs yet starts on. */
const props = defineProps<{ chatId: string; cwd: string; focus?: ServerFocus | null; aiBrowser: BrowserOpenRequest | null }>()
const emit = defineEmits<{ close: [] }>()

const servers = useDevServers()
const { status, statusMissing, projects, projectsError, busy, actionError } = servers
const setup = ref<FolderSetup | null>(null)
const logs = ref(new Map<string, string[]>())

const input = computed(() => ({ status: status.value, statusMissing: statusMissing.value, projects: projects.value, projectsError: projectsError.value, cwd: props.cwd, setup: setup.value }))
const view = computed(() => paneView(input.value))
const project = computed(() => (view.value.kind === 'project' ? view.value.project : null))
const elsewhere = computed(() => otherRunning(projects.value, project.value))
const findProc = (id: string | null): DevWebProcess | null => (id ? ((projects.value ?? []).flatMap((p) => p.processes).find((p) => p.id === id) ?? null) : null)

// ---- polling: the store's loop runs while this pane is mounted; what only the pane keeps is loaded on each answer ----
const refresh = () => servers.refresh()
let release: (() => void) | null = null
onMounted(() => {
  release = servers.use()
  void loadLocal()
})
onBeforeUnmount(() => release?.())
watch(servers.answered, () => {
  void loadLocal()
  if (status.value?.state === 'running' && projects.value) void loadProfiles()
})

// ---- the chat's folder, set up without an Add step ----
async function setUp(cwd: string) {
  setup.value = { cwd, nothing: null }
  try {
    const r = await setUpFolder(cwd)
    if (props.cwd !== cwd) return
    if ('nothing' in r) setup.value = { cwd, nothing: r.nothing }
    else await refresh()
  } catch (err) {
    if (props.cwd === cwd) setup.value = { cwd, nothing: err instanceof Error ? err.message : String(err) }
  }
}
watch(
  () => needsSetup(input.value),
  (need) => {
    if (need) void setUp(props.cwd)
  },
  { immediate: true }
)
const lookAgain = () => (setup.value = null)

// A server that failed shows what it last printed.
watch(
  () => project.value?.processes.map((p) => `${p.id}:${p.status}`).join(),
  async () => {
    for (const p of project.value?.processes ?? []) {
      if (p.status === 'crashed' && !logs.value.has(`${p.id}:${p.exitCode}`)) {
        const key = `${p.id}:${p.exitCode}`
        logs.value = new Map(logs.value).set(key, tailLines(await processLogs(p.id).catch(() => [])))
      }
    }
  },
  { immediate: true }
)
const logOf = (p: DevWebProcess): string[] => (p.status === 'crashed' ? (logs.value.get(`${p.id}:${p.exitCode}`) ?? []) : [])

// ---- a small notice for what an action did, gone after a few seconds ----
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null
function say(text: string) {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), 3500)
}
watch(servers.reused, () => say(REUSED_NOTE))
onBeforeUnmount(() => noticeTimer && clearTimeout(noticeTimer))

// ---- actions ----
async function toggle(p: DevWebProcess) {
  const up = isUp(p.status)
  if (up) dropPending(p.id)
  else if (startBlock(p)) return
  await servers.act(p, up ? 'stop' : 'start')
}
const restart = (p: DevWebProcess) => servers.act(p, 'restart')
const all = (action: 'start' | 'stop') => project.value && servers.actAll(project.value, action)
const tryAgain = () => servers.tryAgain()

// ---- saved browsers, for the New tab page ----
const profiles = shallowRef<BrowserProfiles | null>(null)
const profilesError = ref<string | null>(null)
const profileList = computed(() => (profiles.value ? profileRows(profiles.value) : null))
let profilesAt = 0
async function loadProfiles(force = false) {
  if (!force && Date.now() - profilesAt < 6000) return
  profilesAt = Date.now()
  const cwd = props.cwd
  try {
    const r = await browserProfiles(cwd)
    if (cwd !== props.cwd) return
    profiles.value = r
    profilesError.value = r.error ?? null
  } catch (err) {
    if (cwd === props.cwd) profilesError.value = err instanceof Error ? err.message : String(err)
  }
}

// ---- other localhost servers, for the New tab page ----
const localList = shallowRef<LocalServers | null>(null)
const localError = ref<string | null>(null)
const allPorts = ref(false)
let localAt = 0
async function loadLocal(force = false) {
  if (!force && Date.now() - localAt < 8000) return
  localAt = Date.now()
  const all = allPorts.value
  try {
    const r = await localhostServers(all)
    if (all !== allPorts.value) return
    localList.value = r
    localError.value = r.error
  } catch (err) {
    if (all === allPorts.value) localError.value = err instanceof Error ? err.message : String(err)
  }
}
function setAllPorts(on: boolean) {
  allPorts.value = on
  void loadLocal(true)
}

// ---- the tabs: each chat's own, remembered ----
const state = ref<TabsState>(loadTabs(props.chatId, props.aiBrowser))
const activeTab = computed(() => state.value.tabs.find((t) => t.id === state.value.active) ?? state.value.tabs[0]!)
watch(state, (s) => saveTabs(props.chatId, s), { deep: true })
// Opened before the chat's transcript loaded, the pane learns its AI's browser late: still untouched, it goes there.
const opened = props.aiBrowser ? null : state.value
watch(
  () => props.aiBrowser,
  (r) => {
    if (r && opened && state.value === opened) state.value = loadTabs(props.chatId, r)
  }
)
/** Server id -> the New tab that clicked it while it was stopped: that tab opens it once it answers. */
const pending = ref(new Map<string, string>())
/** Tabs just pointed at a server that was starting: their frame looks again once. */
const justStarted = ref(new Set<string>())

function dropPending(procId: string) {
  if (!pending.value.has(procId)) return
  const next = new Map(pending.value)
  next.delete(procId)
  pending.value = next
}
const newTab = () => (state.value = openTab(state.value))
const pick = (id: string) => (state.value = activateTab(state.value, id))
/** A page tab is closed or pointed elsewhere: its view must not outlive it in the background. */
function forget(id: string) {
  const t = state.value.tabs.find((x) => x.id === id)
  if (t?.kind === 'page' && t.target) backgroundViews.tabClosing(props.chatId, t.target)
}
function close(id: string) {
  forget(id)
  const next = new Map(pending.value)
  for (const [proc, tab] of next) if (tab === id) next.delete(proc)
  pending.value = next
  const gone = state.value.tabs.find((t) => t.id === id)
  const only = !!gone && state.value.tabs.length === 1
  state.value = closeTab(state.value, id)
  if (gone?.kind === 'saved' && gone.target) void closeSaved(gone.target)
  if (!only) return
  // Closing the only tab closes the browser, like a browser window's last tab; it opens again on a New tab. Saved here:
  // the pane unmounts before the deep watch would write it.
  saveTabs(props.chatId, state.value)
  emit('close')
}
/** Closing a saved browser's tab closes its Chrome (not only the tab), so the transcript's Browser cards read it as closed. */
async function closeSaved(profile: string) {
  const cwd = props.cwd
  try {
    if ((await browserClose(cwd, profile)).closed) window.dispatchEvent(new CustomEvent(BROWSER_CLOSED_EVENT, { detail: { cwd, profile } }))
  } catch {
    // floor-ok: the browser stays as it was; the cards keep reading its real state
  }
}
const aim = (id: string, spec: TabSpec) => {
  // A page tab pointed at a saved browser or a New tab unmounts its PageTab; one pointed at another page stays (its address bar moves it).
  if (spec.kind !== 'page') forget(id)
  state.value = retargetTab(state.value, id, spec)
}
function openAddress(id: string, url: string) {
  aim(id, { kind: 'page', target: url, proc: null })
}
function openSaved(id: string, name: string) {
  aim(id, { kind: 'saved', target: name, proc: null })
}
function showServer(id: string, p: DevWebProcess, fresh = false) {
  const url = processAddress(p)
  if (!url) return
  if (fresh) justStarted.value = new Set(justStarted.value).add(id)
  aim(id, { kind: 'page', target: url, proc: p.id })
}
/** A server clicked on a New tab, or its Start: the tab goes to it at once, and a stopped one is started; the page says
 *  it is starting until it answers. A server with no address until it runs opens once it answers. */
async function openServer(id: string, p: DevWebProcess) {
  const plan = openPlan(p)
  // A port held by a program that is not a dev server: nothing is started, and the New tab says why.
  const blocked = plan.start ? startBlock(p) : null
  if (blocked) {
    actionError.value = blocked
    return
  }
  if (plan.show) showServer(id, p, p.status !== 'running')
  else pending.value = new Map(pending.value).set(p.id, id)
  if (!plan.start) return
  await servers.act(p, 'start')
  if (!actionError.value) return
  dropPending(p.id)
  // A start that failed puts the New tab back, where its error shows.
  const t = state.value.tabs.find((x) => x.id === id)
  if (t?.kind === 'page' && t.proc === p.id && t.target === plan.show) aim(id, NEW_TAB)
}
watch(
  () => [...pending.value.keys()].map((id) => `${id}:${findProc(id)?.status}|${processAddress(findProc(id) ?? ({} as DevWebProcess)) ?? ''}`).join(),
  () => {
    for (const [procId, tabId] of pending.value) {
      const p = findProc(procId)
      if (!p) continue
      // Not 'stopped': that is what the list still says the moment Start is clicked.
      if (p.status !== 'running' && p.status !== 'crashed') continue
      const next = new Map(pending.value)
      next.delete(procId)
      pending.value = next
      if (p.status === 'running' && state.value.tabs.find((t) => t.id === tabId)?.kind === 'new') showServer(tabId, p, true)
    }
  }
)
/** A page tab went somewhere else (a link, the address bar, back): the tab remembers where, and drops a server it no longer shows. */
function navigated(id: string, url: string) {
  const t = state.value.tabs.find((x) => x.id === id)
  if (!t || t.target === url) return
  const p = findProc(t.proc)
  aim(id, { kind: 'page', target: url, proc: p && processAddress(p) === url ? p.id : null })
}

const procOf = (t: PaneTab): DevWebProcess | null => (t.kind === 'page' ? findProc(t.proc) : null)
const titleOf = (t: PaneTab): string => (t.kind === 'new' ? 'New tab' : t.kind === 'saved' ? (t.target ?? 'Saved browser') : pageTitle(t.target, procOf(t)))

// The transcript card's request: the tab for that browser comes forward, else it opens in a new one. A request that
// fired before this pane mounted waits in browser-request.ts; one that fires later changes the ref.
function applyRequest(r: BrowserOpenRequest) {
  const spec = requestTab(r)
  if (!spec) return
  const have = state.value.tabs.find((t) => t.kind === spec.kind && t.target === spec.target)
  if (have) return pick(have.id)
  state.value = openTab(state.value, spec)
}
watch(
  browserRequest,
  () => {
    const r = claimBrowserRequest()
    if (r) applyRequest(r)
  },
  { immediate: true }
)

const savedEl = ref<{ refresh: () => Promise<void> } | null>(null)
async function refreshAll() {
  void loadProfiles(true)
  void loadLocal(true)
  await refresh()
  if (activeTab.value.kind === 'saved') await savedEl.value?.refresh()
}

watch(
  () => props.cwd,
  () => {
    pending.value = new Map()
    profiles.value = null
    profilesError.value = null
    actionError.value = null
    void loadProfiles(true)
    void refresh()
  }
)

// The sidebar's Dev servers list asked for a server: its tab comes forward, or it opens in a new one (started first when
// it is stopped). Each request is acted on once, when the project list holds its server.
let handledFocus = 0
watch(
  () => [props.focus, projects.value] as const,
  ([f, list]) => {
    if (!f || f.seq <= handledFocus || !list) return
    handledFocus = f.seq
    const hit = findServer(list, f.procId)
    if (!hit) return
    const plan = focusPlan(hit.proc, state.value.tabs)
    if (plan.kind === 'pick') state.value = activateTab(state.value, plan.tab)
    else if (plan.kind === 'open') state.value = openTab(state.value, { kind: 'page', target: plan.url, proc: hit.proc.id })
    else {
      state.value = openTab(state.value)
      void openServer(state.value.active, hit.proc)
    }
  },
  { immediate: true }
)

</script>

<template>
  <section class="relative flex h-full w-full min-w-0 flex-col bg-[var(--bg-page)] text-[13px] leading-[19.5px] text-[var(--text)]" aria-label="Servers">
    <!-- The tab strip, like a browser's: tabs, a + after the last, and the pane's own buttons at the right end. -->
    <div class="flex h-[41px] shrink-0 items-end gap-1 border-b border-border bg-[var(--bg-sidebar)] pl-2 pr-1.5 pt-[9px]">
      <div role="tablist" aria-label="Tabs" class="flex min-w-0 items-end gap-px">
        <div
          v-for="t in state.tabs"
          :key="t.id"
          role="tab"
          tabindex="0"
          :aria-selected="t.id === activeTab.id"
          :title="titleOf(t)"
          class="group relative flex h-8 w-[170px] min-w-[44px] max-w-[190px] flex-[0_1_170px] cursor-default items-center gap-1.5 rounded-t-[8px] pl-2.5 pr-1 transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
          :class="t.id === activeTab.id ? 'z-10 -mb-px h-[33px] bg-[var(--bg-page)] text-[var(--text)]' : 'text-[var(--text-2)] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]'"
          @click="pick(t.id)"
          @keydown.enter.prevent="pick(t.id)"
          @mousedown.middle.prevent
          @auxclick.middle.prevent="close(t.id)"
        >
          <span v-if="procOf(t)" class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(procOf(t)!.status)]" aria-hidden="true" />
          <Globe v-else-if="t.kind === 'page'" class="size-3.5 shrink-0" aria-hidden="true" />
          <AppWindow v-else-if="t.kind === 'saved'" class="size-3.5 shrink-0" aria-hidden="true" />
          <Search v-else class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-[12px]">{{ titleOf(t) }}</span>
          <button
            type="button"
            class="size-5 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] hover:bg-[var(--fill-selected)] hover:text-[var(--text)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none group-hover:flex"
            :class="t.id === activeTab.id ? 'flex' : 'hidden'"
            :aria-label="`Close ${titleOf(t)}`"
            @click.stop="close(t.id)"
          ><X class="size-3" /></button>
        </div>
      </div>
      <Tip label="New tab">
        <button type="button" :class="ICON_BTN" class="mb-1" aria-label="New tab" @click="newTab"><Plus class="size-4" /></button>
      </Tip>
      <span class="flex-1" />
      <div class="mb-1 flex shrink-0 items-center gap-0.5">
        <Tip label="Refresh">
          <button type="button" :class="ICON_BTN" aria-label="Refresh servers" @click="refreshAll"><RefreshCw class="size-4" /></button>
        </Tip>
        <Tip label="Close">
          <button type="button" :class="ICON_BTN" aria-label="Close servers" @click="emit('close')"><X class="size-4" /></button>
        </Tip>
      </div>
    </div>

    <!-- Every New tab and page tab stays mounted while another shows, so going back does not reload a page or lose a filter. -->
    <template v-for="t in state.tabs" :key="t.id">
      <NewTab
        v-if="t.kind === 'new'"
        v-show="t.id === activeTab.id"
        :active="t.id === activeTab.id"
        :cwd="cwd"
        :view="view"
        :project="project"
        :elsewhere="elsewhere"
        :busy="busy"
        :pending="[...pending.keys()]"
        :log-of="logOf"
        :profiles="profileList"
        :profiles-error="profilesError"
        :action-error="actionError"
        :local="localList"
        :local-error="localError"
        :all-ports="allPorts"
        @all-ports="setAllPorts"
        @server="openServer(t.id, $event)"
        @toggle="toggle"
        @restart="restart"
        @all="all"
        @saved="openSaved(t.id, $event)"
        @address="openAddress(t.id, $event)"
        @look-again="lookAgain"
        @try-again="tryAgain"
      />
      <PageTab
        v-else-if="t.kind === 'page' && t.target"
        v-show="t.id === activeTab.id"
        :chat-id="chatId"
        :url="t.target"
        :proc="procOf(t)"
        :busy="!!procOf(t) && busy.has(procOf(t)!.id)"
        :just-started="justStarted.has(t.id)"
        @navigated="navigated(t.id, $event)"
        @toggle="toggle"
      />
    </template>
    <div v-if="notice" role="status" aria-live="polite" class="pointer-events-none absolute bottom-3 left-1/2 z-[30] max-w-[90%] -translate-x-1/2 rounded-[var(--radius-10)] bg-[var(--bg-popover)] px-3 py-1.5 text-[12px] text-[var(--text)] shadow-(--shadow-menu-ringed)">{{ notice }}</div>
    <SavedBrowsers v-if="activeTab.kind === 'saved' && activeTab.target" ref="savedEl" :key="`${cwd}|${activeTab.id}|${activeTab.target}`" :cwd="cwd" :profile="activeTab.target" :url="activeTab.url" />
  </section>
</template>
