<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Play, RefreshCw, RotateCw, Square, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { processAddress, type DevWebProcess, type DevWebProject, type DevWebStatus } from '@shared/devwebui'
import { devwebStart, devwebStatus, listProjects, processAction, processLogs, projectAction, RouteMissing, setUpFolder } from './api'
import { clampPane, type FolderSetup, isUp, needsSetup, otherRunning, paneView, parseAddress, proxyAddress, statusDot, statusWord, tailLines, type Dot } from './logic'

// The right-hand servers pane (title bar's Browser button), like Claude Code Desktop's: first the list of this
// chat's localhost servers from DevWebUI (Start / Stop / Restart, Open for one that runs), and the browser only once
// a server is opened; starting one opens it as soon as it answers. A folder that is not a project yet is set up by
// itself (POST /dw/folder): from Claude Code's .claude/launch.json or package.json's dev scripts, every server
// stopped. Opening the pane starts the server manager when it is not running; status is polled while the pane is
// open and the window is on screen.
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
  try {
    status.value = await devwebStatus()
    statusMissing.value = false
  } catch (err) {
    if (err instanceof RouteMissing) statusMissing.value = true
    return
  }
  const s = status.value
  if (s.state === 'stopped' && !started) {
    started = true
    status.value = await devwebStart().catch((err) => ({ state: 'failed', url: null, reason: err instanceof Error ? err.message : String(err) }) as DevWebStatus)
  }
  if (status.value.state !== 'running') {
    projects.value = null
    return
  }
  try {
    projects.value = await listProjects()
    projectsError.value = null
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
  if (!up) pendingOpen.value = p.id
  else if (pendingOpen.value === p.id) pendingOpen.value = null
  await run(p.id, () => processAction(p.id, up ? 'stop' : 'start'))
  if (actionError.value && pendingOpen.value === p.id) pendingOpen.value = null
}
const restart = (p: DevWebProcess) => run(p.id, () => processAction(p.id, 'restart'))
const all = (action: 'start' | 'stop') => project.value && run('all', () => projectAction(project.value!.id, action))
async function tryAgain() {
  started = false
  status.value = { state: 'stopped', url: null }
  await refresh()
}

// ---- the browser: hidden until a server (or an address) is opened ----
const mode = ref<'list' | 'browser'>('list')
const openId = ref<string | null>(null)
/** The server just started from the list: it opens once it answers. */
const pendingOpen = ref<string | null>(null)
const selected = computed(() => findProc(openId.value))
const history = ref<string[]>([])
const at = ref(-1)
const address = ref('')
const goTo = ref('')
const reloads = ref(0)
const viaManager = ref(false)
const current = computed(() => history.value[at.value] ?? null)
const frameSrc = computed(() => {
  const cur = current.value
  if (!cur) return null
  if (viaManager.value && selected.value && daemonUrl.value) return proxyAddress(daemonUrl.value, selected.value)
  return cur
})
function go(url: string) {
  history.value = [...history.value.slice(0, at.value + 1), url]
  at.value = history.value.length - 1
  address.value = url
  viaManager.value = false
}
function submitAddress() {
  const url = parseAddress(address.value)
  if (url) go(url)
}
function openAddress() {
  const url = parseAddress(goTo.value)
  if (!url) return
  openId.value = null
  go(url)
  goTo.value = ''
  mode.value = 'browser'
}
const back = () => at.value > 0 && ((at.value -= 1), (address.value = current.value ?? ''), (viaManager.value = false))
const forward = () => at.value < history.value.length - 1 && ((at.value += 1), (address.value = current.value ?? ''), (viaManager.value = false))
function open(p: DevWebProcess, justStarted = false) {
  const url = processAddress(p)
  if (!url) return
  openId.value = p.id
  mode.value = 'browser'
  if (url !== current.value) go(url)
  // A dev server reports running a moment before it listens: look once more so the frame is not left on a refused page.
  if (justStarted) setTimeout(() => current.value === url && reloads.value++, 2500)
}
watch(
  () => {
    const p = findProc(pendingOpen.value)
    return p ? `${p.status}|${processAddress(p) ?? ''}` : null
  },
  () => {
    const p = findProc(pendingOpen.value)
    if (!p) return
    // Not 'stopped': that is what the list still says the moment Start is clicked.
    if (p.status === 'running') {
      pendingOpen.value = null
      open(p, true)
    } else if (p.status === 'crashed') pendingOpen.value = null
  }
)

watch(
  () => props.cwd,
  () => {
    mode.value = 'list'
    openId.value = null
    pendingOpen.value = null
    history.value = []
    at.value = -1
    address.value = ''
    viaManager.value = false
    actionError.value = null
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

const DOT: Record<Dot, string> = {
  run: 'bg-[var(--success)]',
  wait: 'bg-[var(--warning)] animate-pulse',
  bad: 'bg-[var(--danger)]',
  off: 'bg-[var(--text-muted)] opacity-50'
}
const ICON_BTN =
  'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
const TEXT_BTN =
  'flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
const INPUT =
  'h-6 min-w-0 flex-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none'
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

    <template v-if="mode === 'list'">
      <div class="flex h-8 shrink-0 items-center gap-1 pl-3 pr-2">
        <span class="font-medium">Servers</span>
        <span v-if="project" class="ml-1 truncate text-[12px] text-[var(--text-muted)]">{{ project.name }}</span>
        <span class="flex-1" />
        <template v-if="project && project.processes.length > 1">
          <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="all('start')"><Play class="size-3" />Start all</button>
          <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="all('stop')"><Square class="size-3" />Stop all</button>
        </template>
        <Tip v-if="current" label="Back to the browser">
          <button type="button" :class="ICON_BTN" aria-label="Back to the browser" @click="mode = 'browser'"><Globe class="size-4" /></button>
        </Tip>
        <Tip label="Refresh">
          <button type="button" :class="ICON_BTN" aria-label="Refresh servers" @click="refresh"><RefreshCw class="size-4" /></button>
        </Tip>
        <Tip label="Close">
          <button type="button" :class="ICON_BTN" aria-label="Close servers" @click="emit('close')"><X class="size-4" /></button>
        </Tip>
      </div>

      <div role="status" aria-live="polite" class="shrink-0 px-3">
        <template v-if="view.kind === 'loading'"><span class="text-[var(--text-muted)]">Loading…</span></template>
        <template v-else-if="view.kind === 'starting'"><span class="text-[var(--text-muted)]">Starting the server manager</span></template>
        <template v-else-if="view.kind === 'looking'"><span class="text-[var(--text-muted)]">Looking for servers in this folder</span></template>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="view.kind === 'restart-desk'" class="mx-3 mt-1 rounded-[var(--radius-10)] bg-[var(--warning-bg)] px-3 py-2 text-[var(--warning-text)]">
          Restart Hydra Desk 2 to turn on servers.
        </div>

        <div v-else-if="view.kind === 'failed'" class="mx-3 mt-1 flex flex-col gap-2 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">
          <div>The server manager did not start.</div>
          <div class="break-words font-mono text-[12px]">{{ view.reason }}</div>
          <button type="button" :class="TEXT_BTN" class="self-start" @click="tryAgain">Try again</button>
        </div>

        <div v-else-if="view.kind === 'stopped'" class="mx-3 mt-1 flex flex-col gap-2 rounded-[var(--radius-10)] bg-[var(--fill-secondary)] px-3 py-2">
          <div>The server manager stopped.</div>
          <button type="button" :class="TEXT_BTN" class="self-start" @click="tryAgain">Start it</button>
        </div>

        <div v-else-if="view.kind === 'unreachable'" class="mx-3 mt-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">
          The server manager is running but did not answer: {{ view.reason }}
        </div>

        <div v-else-if="view.kind === 'looking'" class="break-all px-3 pt-1 text-[var(--text-muted)]">{{ cwd }}</div>

        <div v-else-if="view.kind === 'nothing'" class="flex flex-col gap-2 px-3 pt-2">
          <div class="font-medium">No servers in this folder</div>
          <div class="break-all text-[var(--text-muted)]">{{ cwd }}</div>
          <div class="rounded-[var(--radius-10)] bg-[var(--fill-secondary)] px-3 py-2" role="status">{{ view.reason }}</div>
          <div class="text-[12px] text-[var(--text-muted)]">Servers come from Claude Code's .claude/launch.json, or the dev scripts in package.json.</div>
          <button type="button" :class="TEXT_BTN" class="self-start" @click="lookAgain">Look again</button>
        </div>

        <div v-else-if="project" class="px-2 pb-1">
          <div v-if="project.processes.length === 0" class="px-1 py-2 text-[var(--text-muted)]">This project has no servers.</div>
          <ul v-else class="flex flex-col gap-0.5" aria-label="This folder's servers">
            <li v-for="p in project.processes" :key="p.id" class="flex flex-col rounded-[var(--radius-6)] px-1 py-0.5 hover:bg-[var(--fill-hover)]">
              <div class="flex min-h-[28px] items-center gap-1.5">
                <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" />
                <span class="truncate font-medium">{{ p.name }}</span>
                <span v-if="p.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ p.port }}</span>
                <span class="shrink-0 text-[12px] text-[var(--text-muted)]">{{ pendingOpen === p.id && (p.status === 'starting' || p.status === 'waiting') ? 'starting, opens when it answers' : statusWord(p) }}</span>
                <span class="flex-1" />
                <button v-if="p.status === 'running' && processAddress(p)" type="button" :class="TEXT_BTN" :aria-label="`Open ${p.name}`" @click="open(p)">Open</button>
                <Tip :label="isUp(p.status) ? 'Stop' : 'Start'">
                  <button type="button" :class="ICON_BTN" :disabled="busy.has(p.id)" :aria-label="`${isUp(p.status) ? 'Stop' : 'Start'} ${p.name}`" @click="toggle(p)">
                    <Square v-if="isUp(p.status)" class="size-3.5" />
                    <Play v-else class="size-3.5" />
                  </button>
                </Tip>
                <Tip label="Restart">
                  <button type="button" :class="ICON_BTN" :disabled="busy.has(p.id)" :aria-label="`Restart ${p.name}`" @click="restart(p)"><RotateCw class="size-3.5" /></button>
                </Tip>
              </div>
              <pre v-if="logOf(p).length" class="mx-1 mb-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 py-1 font-mono text-[11px] leading-4 text-[var(--text-2)]" :aria-label="`Last output of ${p.name}`">{{ logOf(p).join('\n') }}</pre>
            </li>
          </ul>
        </div>

        <div v-if="elsewhere.length" class="px-2 pb-1 pt-2">
          <div class="px-1 pb-0.5 text-[12px] font-medium text-[var(--text-muted)]">Also running</div>
          <ul class="flex flex-col gap-0.5" aria-label="Servers running for other folders">
            <li v-for="r in elsewhere" :key="r.proc.id" class="flex min-h-[28px] items-center gap-1.5 rounded-[var(--radius-6)] px-1 hover:bg-[var(--fill-hover)]">
              <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(r.proc.status)]" aria-hidden="true" />
              <span class="truncate font-medium">{{ r.proc.name }}</span>
              <span class="truncate text-[12px] text-[var(--text-muted)]">{{ r.project.name }}</span>
              <span v-if="r.proc.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ r.proc.port }}</span>
              <span class="flex-1" />
              <button type="button" :class="TEXT_BTN" :aria-label="`Open ${r.proc.name}`" @click="open(r.proc)">Open</button>
              <Tip label="Stop">
                <button type="button" :class="ICON_BTN" :disabled="busy.has(r.proc.id)" :aria-label="`Stop ${r.proc.name}`" @click="toggle(r.proc)"><Square class="size-3.5" /></button>
              </Tip>
            </li>
          </ul>
        </div>

        <div v-if="actionError" class="mx-2 mt-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
      </div>

      <form class="flex h-9 shrink-0 items-center gap-1 border-t border-border px-2" @submit.prevent="openAddress">
        <input v-model="goTo" type="text" spellcheck="false" aria-label="Open an address" placeholder="Open an address, or a port" :class="INPUT" />
      </form>
    </template>

    <!-- Kept mounted while the list shows, so going back to the list does not reload the page. -->
    <div v-show="mode === 'browser'" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-1 pl-1 pr-2">
        <button type="button" :class="TEXT_BTN" class="bg-transparent" aria-label="Back to the servers" @click="mode = 'list'"><ArrowLeft class="size-3.5" />Servers</button>
        <template v-if="selected">
          <span class="ml-1 size-2 shrink-0 rounded-full" :class="DOT[statusDot(selected.status)]" aria-hidden="true" />
          <span class="truncate font-medium">{{ selected.name }}</span>
          <span v-if="selected.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ selected.port }}</span>
        </template>
        <span class="flex-1" />
        <Tip v-if="selected && isUp(selected.status)" label="Stop">
          <button type="button" :class="ICON_BTN" :disabled="busy.has(selected.id)" :aria-label="`Stop ${selected.name}`" @click="toggle(selected)"><Square class="size-3.5" /></button>
        </Tip>
        <Tip label="Close">
          <button type="button" :class="ICON_BTN" aria-label="Close servers" @click="emit('close')"><X class="size-4" /></button>
        </Tip>
      </div>
      <form class="flex h-8 shrink-0 items-center gap-1 border-t border-border px-2" @submit.prevent="submitAddress">
        <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="at <= 0" @click="back"><ArrowLeft class="size-4" /></button></Tip>
        <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="at >= history.length - 1" @click="forward"><ArrowRight class="size-4" /></button></Tip>
        <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" :disabled="!current" @click="reloads++"><RotateCw class="size-4" /></button></Tip>
        <input v-model="address" type="text" spellcheck="false" aria-label="Address" placeholder="http://localhost:3000" :class="INPUT" />
        <Tip label="Open in the system browser">
          <a v-if="current" :href="current" target="_blank" rel="noopener noreferrer" :class="ICON_BTN" aria-label="Open in the system browser"><ExternalLink class="size-4" /></a>
          <span v-else :class="ICON_BTN" class="opacity-40" aria-hidden="true"><ExternalLink class="size-4" /></span>
        </Tip>
      </form>
      <div class="relative min-h-0 flex-1 border-t border-border bg-white">
        <iframe
          v-if="frameSrc"
          :key="`${frameSrc}#${reloads}`"
          :src="frameSrc"
          :title="selected ? `${selected.name} preview` : 'Preview'"
          class="size-full border-0"
          referrerpolicy="no-referrer"
        />
        <div v-if="selected && !isUp(selected.status)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center">
          <div class="text-[var(--text-muted)]">{{ selected.name }} is {{ statusWord(selected) }}.</div>
          <button type="button" :class="TEXT_BTN" :disabled="busy.has(selected.id)" @click="toggle(selected)"><Play class="size-3" />Start</button>
        </div>
        <button
          v-else-if="frameSrc && selected && daemonUrl"
          type="button"
          class="absolute bottom-2 right-2 flex h-6 items-center rounded-[var(--radius-6)] bg-[var(--bg-popover)] px-2 text-[12px] text-[var(--text)] opacity-80 shadow-(--shadow-menu-ringed) transition-opacity duration-[60ms] hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
          :aria-pressed="viaManager"
          @click="viaManager = !viaManager"
        >{{ viaManager ? 'Show directly' : 'Blank? Show through the server manager' }}</button>
      </div>
    </div>
  </section>
</template>
