<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ArrowLeft, ArrowRight, ExternalLink, Play, RefreshCw, RotateCw, Square, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { processAddress, type DevWebProcess, type DevWebProject, type DevWebStatus } from '@shared/devwebui'
import { addFolder, devwebStart, devwebStatus, listProjects, processAction, processLogs, projectAction, RouteMissing } from './api'
import { clampPane, isUp, paneView, parseAddress, proxyAddress, statusDot, statusWord, tailLines, type Dot } from './logic'

// The right-hand servers pane (title bar's Browser button): this chat's localhost servers from DevWebUI, Start /
// Stop / Restart for each, and a small browser for the one picked. Opening it starts the server manager when it
// is not running; status is polled while the pane is open and the window is on screen.
const props = defineProps<{ cwd: string; width: number }>()
const emit = defineEmits<{ close: []; resize: [width: number] }>()

const status = ref<DevWebStatus | null>(null)
const statusMissing = ref(false)
const projects = shallowRef<DevWebProject[] | null>(null)
const projectsError = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const busy = ref(new Set<string>())
const actionError = ref<string | null>(null)
const logs = ref(new Map<string, string[]>())
const adding = ref(false)
const addNothing = ref<string | null>(null)

const view = computed(() => paneView({ status: status.value, statusMissing: statusMissing.value, projects: projects.value, projectsError: projectsError.value, cwd: props.cwd }))
const project = computed(() => (view.value.kind === 'project' ? view.value.project : null))
const selected = computed(() => project.value?.processes.find((p) => p.id === selectedId.value) ?? null)
const daemonUrl = computed(() => status.value?.url ?? null)

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

watch(
  () => props.cwd,
  () => {
    selectedId.value = null
    history.value = []
    at.value = -1
    address.value = ''
    viaManager.value = false
    addNothing.value = null
    actionError.value = null
    void refresh()
  }
)

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
    if (!selectedId.value) selectedId.value = project.value?.processes.find((p) => p.status === 'running' && processAddress(p))?.id ?? null
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
const toggle = (p: DevWebProcess) => run(p.id, () => processAction(p.id, isUp(p.status) ? 'stop' : 'start'))
const restart = (p: DevWebProcess) => run(p.id, () => processAction(p.id, 'restart'))
const all = (action: 'start' | 'stop') => project.value && run('all', () => projectAction(project.value!.id, action))
async function add() {
  adding.value = true
  addNothing.value = null
  try {
    const r = await addFolder(props.cwd)
    if ('nothing' in r) addNothing.value = r.nothing
    await refresh()
  } catch (err) {
    addNothing.value = err instanceof Error ? err.message : String(err)
  } finally {
    adding.value = false
  }
}
async function tryAgain() {
  started = false
  status.value = { state: 'stopped', url: null }
  await refresh()
}

// ---- the small browser ----
const history = ref<string[]>([])
const at = ref(-1)
const address = ref('')
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
const back = () => at.value > 0 && ((at.value -= 1), (address.value = current.value ?? ''), (viaManager.value = false))
const forward = () => at.value < history.value.length - 1 && ((at.value += 1), (address.value = current.value ?? ''), (viaManager.value = false))
watch(
  () => (selected.value && selected.value.status === 'running' ? processAddress(selected.value) : null),
  (url) => {
    if (url && url !== current.value) {
      go(url)
      // A dev server reports running a moment before it listens: look once more so the frame is not left on a refused page.
      setTimeout(() => current.value === url && reloads.value++, 2500)
    }
  },
  { immediate: true }
)
function pick(p: DevWebProcess) {
  selectedId.value = p.id
}

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

    <div class="flex h-8 shrink-0 items-center gap-1 pl-3 pr-2">
      <span class="font-medium">Servers</span>
      <span v-if="project" class="ml-1 truncate text-[12px] text-[var(--text-muted)]">{{ project.name }}</span>
      <span class="flex-1" />
      <template v-if="project && project.processes.length > 1">
        <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="all('start')"><Play class="size-3" />Start all</button>
        <button type="button" :class="TEXT_BTN" :disabled="busy.has('all')" @click="all('stop')"><Square class="size-3" />Stop all</button>
      </template>
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
    </div>

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

    <div v-else-if="view.kind === 'not-a-project'" class="flex flex-col gap-2 px-3 pt-2">
      <div class="font-medium">No servers set up for this folder</div>
      <div class="break-all text-[var(--text-muted)]">{{ cwd }}</div>
      <button type="button" :class="TEXT_BTN" class="self-start" :disabled="adding" @click="add">{{ adding ? 'Looking…' : 'Add this folder to the server manager' }}</button>
      <div class="text-[12px] text-[var(--text-muted)]">It reads a .devwebui file here, or builds one from the dev scripts in package.json.</div>
      <div v-if="addNothing" class="rounded-[var(--radius-10)] bg-[var(--fill-secondary)] px-3 py-2" role="status">{{ addNothing }}</div>
    </div>

    <div v-else-if="project" class="max-h-[45%] shrink-0 overflow-y-auto px-2 pb-1">
      <div v-if="project.processes.length === 0" class="px-1 py-2 text-[var(--text-muted)]">This project has no servers.</div>
      <ul v-else class="flex flex-col gap-0.5">
        <li
          v-for="p in project.processes"
          :key="p.id"
          class="flex flex-col rounded-[var(--radius-6)] px-1 py-0.5"
          :class="p.id === selectedId ? 'bg-[var(--fill-selected)]' : 'hover:bg-[var(--fill-hover)]'"
        >
          <div class="flex min-h-[26px] items-center gap-1.5">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
              :aria-pressed="p.id === selectedId"
              :aria-label="`${p.name}, ${statusWord(p)}${p.port ? `, port ${p.port}` : ''}`"
              @click="pick(p)"
            >
              <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" />
              <span class="truncate font-medium">{{ p.name }}</span>
              <span v-if="p.port" class="tnum shrink-0 text-[12px] text-[var(--text-muted)]">:{{ p.port }}</span>
              <span class="shrink-0 text-[12px] text-[var(--text-muted)]">{{ statusWord(p) }}</span>
            </button>
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
      <div v-if="actionError" class="mt-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
    </div>

    <template v-if="project">
      <form class="flex h-8 shrink-0 items-center gap-1 border-t border-border px-2" @submit.prevent="submitAddress">
        <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="at <= 0" @click="back"><ArrowLeft class="size-4" /></button></Tip>
        <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="at >= history.length - 1" @click="forward"><ArrowRight class="size-4" /></button></Tip>
        <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" :disabled="!current" @click="reloads++"><RotateCw class="size-4" /></button></Tip>
        <input
          v-model="address"
          type="text"
          spellcheck="false"
          aria-label="Address"
          placeholder="http://localhost:3000"
          class="h-6 min-w-0 flex-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        />
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
        <div v-else class="flex size-full items-center justify-center bg-[var(--bg-page)] px-6 text-center text-[var(--text-muted)]">
          Start a server and pick it to see it here.
        </div>
        <button
          v-if="frameSrc && selected && daemonUrl"
          type="button"
          class="absolute bottom-2 right-2 flex h-6 items-center rounded-[var(--radius-6)] bg-[var(--bg-popover)] px-2 text-[12px] text-[var(--text)] opacity-80 shadow-(--shadow-menu-ringed) transition-opacity duration-[60ms] hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
          :aria-pressed="viaManager"
          @click="viaManager = !viaManager"
        >{{ viaManager ? 'Show directly' : 'Blank? Show through the server manager' }}</button>
      </div>
    </template>
    <div v-else class="flex-1" />
  </section>
</template>
