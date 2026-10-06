<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { AppWindow, Globe, Plus, RefreshCw, Search, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { BrowserOpenRequest, BrowserProfiles } from '@shared/browser'
import { processAddress, type DevWebProcess, type DevWebProject, type DevWebStatus } from '@shared/devwebui'
import { browserProfiles, devwebStart, devwebStatus, listProjects, processAction, processLogs, projectAction, RouteMissing, setUpFolder } from './api'
import { activateTab, clampPane, closeTab, type FolderSetup, loadTabs, needsSetup, openTab, otherRunning, type PaneTab, pageTitle, paneView, profileRows, retargetTab, saveTabs, statusDot, tailLines, type TabsState, type TabSpec, isUp } from './logic'
import { browserRequest, claimBrowserRequest } from './browser-request'
import NewTab from './NewTab.vue'
import PageTab from './PageTab.vue'
import SavedBrowsers from './SavedBrowsers.vue'
import { DOT, ICON_BTN } from './styles'

// The right-hand pane (title bar's Browser button): a browser's tab strip over the active tab. A New tab lists this
// chat's localhost servers from DevWebUI (Start / Stop / Restart, click one to open it in the tab) and the workspace's
// saved browsers, narrowed by its address bar; a page tab shows a server or an address in a frame; a saved tab is a
// saved browser, live. Tabs are remembered per chat folder. A folder that is not a project yet is set up by itself
// (POST /dw/folder): from Claude Code's .claude/launch.json or package.json's dev scripts, every server stopped.
// Opening the pane starts the server manager when it is not running; status is polled while the pane is open and the
// window is on screen.
const props = defineProps<{ cwd: string; width: number }>()
const emit = defineEmits<{ close: []; resize: [width: number] }>()

const status = ref<DevWebStatus | null>(null)
const statusMissing = ref(false)
const projects = shallowRef<DevWebProject[] | null>(null)
const projectsError = ref<string | null>(null)
const setup = ref<FolderSetup | null>(null)
const busy = ref(new Set<string>())
const actionError = ref<string | null>(null)
const logs = ref(new Map<string, string[]>())

const input = computed(() => ({ status: status.value, statusMissing: statusMissing.value, projects: projects.value, projectsError: projectsError.value, cwd: props.cwd, setup: setup.value }))
const view = computed(() => paneView(input.value))
const project = computed(() => (view.value.kind === 'project' ? view.value.project : null))
const elsewhere = computed(() => otherRunning(projects.value, project.value))
const daemonUrl = computed(() => status.value?.url ?? null)
const findProc = (id: string | null): DevWebProcess | null => (id ? ((projects.value ?? []).flatMap((p) => p.processes).find((p) => p.id === id) ?? null) : null)

// ---- polling ----
let timer: ReturnType<typeof setTimeout> | null = null
let alive = true
let started = false

async function refresh() {
  let s: DevWebStatus
  try {
    s = await devwebStatus()
    statusMissing.value = false
  } catch (err) {
    if (err instanceof RouteMissing) statusMissing.value = true
    return
  }
  if (s.state === 'stopped' && !started) {
    // Show 'starting' while the automatic start runs, so the stopped card only appears once a start has failed.
    started = true
    status.value = { state: 'starting', url: null }
    status.value = await devwebStart().catch((err) => ({ state: 'failed', url: null, reason: err instanceof Error ? err.message : String(err) }) as DevWebStatus)
  } else status.value = s
  if (status.value.state !== 'running') {
    projects.value = null
    return
  }
  try {
    projects.value = await listProjects()
    projectsError.value = null
    void loadProfiles()
  } catch (err) {
    projectsError.value = err instanceof Error ? err.message : String(err)
  }
}

// One polling loop at a time: stopTimer and onVisibility move `loop` on, so a refresh that was already running
// when the window was hidden does not schedule a second loop behind the new one.
let loop = 0
function schedule(gen = loop) {
  if (!alive || document.hidden || gen !== loop) return
  timer = setTimeout(async () => {
    await refresh()
    schedule(gen)
  }, status.value?.state === 'starting' ? 1000 : 2000)
}
function stopTimer() {
  loop++
  if (timer) clearTimeout(timer)
  timer = null
}
function onVisibility() {
  stopTimer()
  if (document.hidden) return
  const gen = loop
  void refresh().then(() => schedule(gen))
}
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  const gen = loop
  void refresh().then(() => schedule(gen))
})
onBeforeUnmount(() => {
  alive = false
  stopTimer()
  document.removeEventListener('visibilitychange', onVisibility)
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

// ---- actions ----
async function run(key: string, fn: () => Promise<unknown>) {
  actionError.value = null
  busy.value = new Set(busy.value).add(key)
  try {
    await fn()
    await refresh()
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    const next = new Set(busy.value)
    next.delete(key)
    busy.value = next
  }
}
async function toggle(p: DevWebProcess) {
  const up = isUp(p.status)
  if (up) dropPending(p.id)
  await run(p.id, () => processAction(p.id, up ? 'stop' : 'start'))
}
const restart = (p: DevWebProcess) => run(p.id, () => processAction(p.id, 'restart'))
const all = (action: 'start' | 'stop') => project.value && run('all', () => projectAction(project.value!.id, action))
async function tryAgain() {
  started = false
  const pending: DevWebStatus = { state: 'starting', url: null }
  status.value = pending
  await refresh()
  // A status error that refresh returned on leaves the pane as on first open (loading, polling goes on), not starting for good.
  if (status.value === pending) status.value = null
}

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

// ---- the tabs, remembered per chat folder ----
const state = ref<TabsState>(loadTabs(props.cwd))
const activeTab = computed(() => state.value.tabs.find((t) => t.id === state.value.active) ?? state.value.tabs[0]!)
watch(state, (s) => saveTabs(props.cwd, s), { deep: true })
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
function close(id: string) {
  const next = new Map(pending.value)
  for (const [proc, tab] of next) if (tab === id) next.delete(proc)
  pending.value = next
  state.value = closeTab(state.value, id)
}
const aim = (id: string, spec: TabSpec) => (state.value = retargetTab(state.value, id, spec))
function openAddress(id: string, url: string) {
  aim(id, { kind: 'page', target: url, proc: null })
}
function openSaved(id: string, name: string) {
  aim(id, { kind: 'saved', target: name, proc: null })
}
function openRunning(id: string, p: DevWebProcess, fresh = false) {
  const url = processAddress(p)
  if (!url) return
  if (fresh) justStarted.value = new Set(justStarted.value).add(id)
  aim(id, { kind: 'page', target: url, proc: p.id })
}
/** A server clicked on a New tab: it opens in that tab, starting it first when it is stopped. */
async function openServer(id: string, p: DevWebProcess) {
  if (p.status === 'running' && processAddress(p)) return openRunning(id, p)
  if (p.status === 'crashed' || p.status === 'stopped') {
    pending.value = new Map(pending.value).set(p.id, id)
    await run(p.id, () => processAction(p.id, 'start'))
    if (actionError.value) dropPending(p.id)
  } else pending.value = new Map(pending.value).set(p.id, id)
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
      if (p.status === 'running' && state.value.tabs.find((t) => t.id === tabId)?.kind === 'new') openRunning(tabId, p, true)
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
  if (r.profile) {
    const have = state.value.tabs.find((t) => t.kind === 'saved' && t.target === r.profile)
    if (have) return pick(have.id)
    state.value = openTab(state.value, { kind: 'saved', target: r.profile, proc: null, ...(r.url ? { url: r.url } : {}) })
  } else if (r.url) state.value = openTab(state.value, { kind: 'page', target: r.url, proc: null })
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
  await refresh()
  if (activeTab.value.kind === 'saved') await savedEl.value?.refresh()
}

watch(
  () => props.cwd,
  () => {
    state.value = loadTabs(props.cwd)
    pending.value = new Map()
    profiles.value = null
    profilesError.value = null
    actionError.value = null
    void loadProfiles(true)
    void refresh()
  }
)

// ---- width: drag the left edge, or arrow keys ----
function onResizeDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const right = el.parentElement?.getBoundingClientRect().right ?? window.innerWidth
  const move = (ev: PointerEvent) => emit('resize', clampPane(right - ev.clientX, window.innerWidth * 0.7))
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onResizeKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') emit('resize', clampPane(props.width + 16, window.innerWidth * 0.7))
  else if (e.key === 'ArrowRight') emit('resize', clampPane(props.width - 16, window.innerWidth * 0.7))
}

</script>

<template>
  <section class="relative flex h-full w-full min-w-0 flex-col bg-[var(--bg-page)] text-[13px] leading-[19.5px] text-[var(--text)]" aria-label="Servers">
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the servers pane"
      tabindex="0"
      :aria-valuenow="width"
      class="absolute -left-1.5 top-0 z-[22] h-full w-3 cursor-col-resize touch-none focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      @pointerdown.prevent="onResizeDown"
      @keydown="onResizeKey"
    />

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
        :url="t.target"
        :proc="procOf(t)"
        :daemon-url="daemonUrl"
        :busy="!!procOf(t) && busy.has(procOf(t)!.id)"
        :just-started="justStarted.has(t.id)"
        @navigated="navigated(t.id, $event)"
        @toggle="toggle"
      />
    </template>
    <SavedBrowsers v-if="activeTab.kind === 'saved' && activeTab.target" ref="savedEl" :key="`${cwd}|${activeTab.id}|${activeTab.target}`" :cwd="cwd" :profile="activeTab.target" :url="activeTab.url" />
  </section>
</template>
