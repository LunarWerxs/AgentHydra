<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ArrowLeft, ArrowRight, ChevronLeft, RefreshCw, RotateCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { BrowserLiveIn, BrowserLiveOut, BrowserOpenRequest, BrowserProfiles, BrowserTab } from '@shared/browser'
import { browserOpen, browserProfiles } from './api'
import { fitFrame, isPasteKey, keyMessage, liveSocketUrl, mapPoint, modifiersOf, mouseButton, normalizeAddress, profileRows, resolveRequest } from './logic'
import { DOT, ICON_BTN, INPUT, TEXT_BTN, tab } from './styles'

// Browser mode's second source: the saved Chrome browsers of this chat's workspace (shared/browser.ts). The list shows
// what each holds; an open one is watched live on a canvas and driven with the person's mouse and keyboard (to sign in,
// say). One that is not open is opened here, or opened to log in: that Chrome has no live view until it is closed.
const props = defineProps<{ cwd: string; request: BrowserOpenRequest | null }>()

const list = shallowRef<BrowserProfiles | null>(null)
const listError = ref<string | null>(null)
const rows = computed(() => profileRows(list.value))
const selected = ref<string | null>(null)
const selectedRow = computed(() => rows.value.find((r) => r.name === selected.value) ?? null)
/** A card's request the list could not satisfy: the address, and that the browser is not running. */
const missing = ref<{ profile: string | null; url: string | null } | null>(null)
const busy = ref(false)
const actionError = ref<string | null>(null)
/** The profile opened for sign-in: its Chrome window is the person's, until they close it. */
const loginFor = ref<string | null>(null)

async function load() {
  const cwd = props.cwd
  try {
    const r = await browserProfiles(cwd)
    if (cwd !== props.cwd) return
    list.value = r
    listError.value = null
  } catch (err) {
    if (cwd === props.cwd) listError.value = err instanceof Error ? err.message : String(err)
  }
}

// ---- the live view ----
type Phase = 'idle' | 'connecting' | 'live' | 'closed'
const phase = ref<Phase>('idle')
const closedWhy = ref('')
const page = ref<{ tab: BrowserTab; canGoBack: boolean; canGoForward: boolean } | null>(null)
const tabs = ref<BrowserTab[]>([])
const address = ref('')
const canvas = ref<HTMLCanvasElement | null>(null)
const stage = ref<HTMLElement | null>(null)
let socket: WebSocket | null = null
let frame: { image: HTMLImageElement; width: number; height: number } | null = null
let decoding = 0
let resizer: ResizeObserver | null = null

function draw() {
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  ctx.clearRect(0, 0, c.width, c.height)
  if (!frame) return
  const fit = fitFrame(c.width, c.height, frame)
  ctx.drawImage(frame.image, fit.x, fit.y, fit.width, fit.height)
}
function sizeCanvas() {
  const c = canvas.value
  const s = stage.value
  if (!c || !s) return
  const dpr = window.devicePixelRatio || 1
  c.width = Math.max(1, Math.round(s.clientWidth * dpr))
  c.height = Math.max(1, Math.round(s.clientHeight * dpr))
  draw()
}
function showFrame(m: Extract<BrowserLiveOut, { type: 'frame' }>) {
  const token = ++decoding
  const image = new Image()
  image.onload = () => {
    if (token !== decoding) return
    frame = { image, width: m.width, height: m.height }
    draw()
  }
  image.src = `data:image/jpeg;base64,${m.data}`
}

function disconnect() {
  const s = socket
  socket = null
  s?.close()
  frame = null
  decoding++
  page.value = null
  tabs.value = []
  draw()
}
function connect(name: string, tabId?: string) {
  disconnect()
  phase.value = 'connecting'
  closedWhy.value = ''
  const ws = new WebSocket(liveSocketUrl(window.location, props.cwd, name, tabId))
  socket = ws
  ws.onmessage = (ev) => {
    if (socket !== ws) return
    let m: BrowserLiveOut
    try {
      m = JSON.parse(String(ev.data)) as BrowserLiveOut
    } catch {
      return
    }
    if (m.type === 'frame') {
      phase.value = 'live'
      showFrame(m)
    } else if (m.type === 'page') {
      page.value = m
      if (document.activeElement !== addressEl.value) address.value = m.tab.url
    } else if (m.type === 'tabs') tabs.value = m.tabs
    else if (m.type === 'closed') {
      closedWhy.value = m.reason
      phase.value = 'closed'
      void load()
    }
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (phase.value !== 'closed') {
      closedWhy.value = 'The connection to the browser dropped.'
      phase.value = 'closed'
    }
  }
  void nextTick(sizeCanvas)
}
const send = (m: BrowserLiveIn) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(m))

function select(name: string) {
  selected.value = name
  missing.value = null
  actionError.value = null
  loginFor.value = null
  const row = rows.value.find((r) => r.name === name)
  if (row?.open) connect(name)
  else {
    disconnect()
    phase.value = 'idle'
  }
}
function unselect() {
  disconnect()
  selected.value = null
  missing.value = null
  loginFor.value = null
  phase.value = 'idle'
  void load()
}

/** Open the profile's Chrome. With `login`, visible and with nothing attached; otherwise then watch it here. */
async function openProfile(name: string, login = false, url?: string) {
  busy.value = true
  actionError.value = null
  try {
    await browserOpen(props.cwd, name, { login, ...(url ? { url } : {}) })
    if (login) {
      selected.value = name
      missing.value = null
      loginFor.value = name
      disconnect()
      phase.value = 'idle'
    } else {
      await load()
      select(name)
    }
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function refresh() {
  await load()
  if (loginFor.value && rows.value.find((r) => r.name === loginFor.value)) {
    // The sign-in window was closed (or is still open): either way the list shows what the profile holds now.
    const name = loginFor.value
    loginFor.value = null
    select(name)
  }
}
/** Back in this window after signing in elsewhere: look again. */
function onFocus() {
  if (loginFor.value) void load()
}

// ---- the transcript card's request ----
async function apply(req: BrowserOpenRequest) {
  await load()
  const t = resolveRequest(req, list.value)
  if (t.kind === 'profile') select(t.profile)
  else {
    disconnect()
    selected.value = null
    loginFor.value = null
    phase.value = 'idle'
    missing.value = { profile: t.profile, url: t.url }
  }
}
watch(
  () => props.request,
  (r) => {
    if (r) void apply(r)
  }
)

// ---- the person's input, forwarded ----
const addressEl = ref<HTMLInputElement | null>(null)
function submitAddress() {
  const url = normalizeAddress(address.value)
  if (url) send({ type: 'navigate', url })
  canvas.value?.focus()
}
const history = (go: 'back' | 'forward' | 'reload') => send({ type: 'history', go })
const pickTab = (id: string) => send({ type: 'tab', id })

const box = () => canvas.value!.getBoundingClientRect()
// The canvas is drawn in device pixels but sized by CSS, and the frame's letterbox is in the same box.
const frameSize = () => (frame ? { width: frame.width, height: frame.height } : null)
let dragging = false
function mouse(e: MouseEvent, event: 'down' | 'up' | 'move') {
  const f = frameSize()
  if (!f || !canvas.value) return
  const p = mapPoint(box(), f, e.clientX, e.clientY, event !== 'down')
  if (!p) return
  send({ type: 'mouse', event, x: p.x, y: p.y, button: mouseButton(e), clickCount: event === 'move' ? 0 : Math.max(1, e.detail), modifiers: modifiersOf(e) })
}
function onDown(e: MouseEvent) {
  e.preventDefault()
  canvas.value?.focus()
  dragging = true
  window.addEventListener('mouseup', onWindowUp)
  mouse(e, 'down')
}
function onWindowUp(e: MouseEvent) {
  window.removeEventListener('mouseup', onWindowUp)
  if (!dragging) return
  dragging = false
  mouse(e, 'up')
}
let moveEvent: MouseEvent | null = null
let moveFrame = 0
function onMove(e: MouseEvent) {
  moveEvent = e
  if (moveFrame) return
  moveFrame = requestAnimationFrame(() => {
    moveFrame = 0
    if (moveEvent) mouse(moveEvent, 'move')
    moveEvent = null
  })
}
function onWheel(e: WheelEvent) {
  const f = frameSize()
  const p = f && canvas.value ? mapPoint(box(), f, e.clientX, e.clientY) : null
  if (p) send({ type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY })
}
function onKey(e: KeyboardEvent) {
  if (isPasteKey(e)) return
  e.preventDefault()
  send(keyMessage(e))
}
function onPaste(e: ClipboardEvent) {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain')
  if (text) send({ type: 'text', text })
}

onMounted(() => {
  window.addEventListener('focus', onFocus)
  if (props.request) void apply(props.request)
  else void load()
})
// The stage exists only while one browser is shown.
watch(stage, (el, old) => {
  resizer ??= new ResizeObserver(sizeCanvas)
  if (old) resizer.unobserve(old)
  if (el) resizer.observe(el)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('mouseup', onWindowUp)
  if (moveFrame) cancelAnimationFrame(moveFrame)
  resizer?.disconnect()
  disconnect()
})
watch(
  () => props.cwd,
  () => {
    unselect()
    list.value = null
  }
)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- the list -->
    <div v-if="!selected && !missing" class="min-h-0 flex-1 overflow-y-auto" data-testid="saved-browsers">
      <div class="mx-auto flex min-h-full w-full max-w-[480px] flex-col justify-center gap-1 px-2 py-2">
        <div v-if="listError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ listError }}</div>
        <div v-else-if="list?.error" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ list.error }}</div>
        <div v-if="!list && !listError" class="text-center text-[var(--text-muted)]" role="status">Loading…</div>
        <div v-else-if="list && !rows.length && !list.error" class="px-3 text-center text-[var(--text-muted)]" role="status">The AI creates saved browsers as it works, and they appear here.</div>
        <ul v-if="rows.length" class="flex flex-col gap-0.5" aria-label="Saved browsers">
          <li v-for="r in rows" :key="r.name">
            <button type="button" class="flex w-full flex-col gap-0.5 rounded-[var(--radius-6)] px-2 py-1.5 text-left transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" :aria-label="`Show ${r.name}`" @click="select(r.name)">
              <span class="flex items-center gap-1.5">
                <span class="size-2 shrink-0 rounded-full" :class="r.open ? DOT.run : DOT.off" :title="r.open ? 'Open' : 'Not open'" aria-hidden="true" />
                <span class="truncate font-medium">{{ r.name }}</span>
                <span class="flex-1" />
                <span class="shrink-0 text-[12px] text-[var(--text-muted)]">{{ r.open ? 'open · ' : '' }}{{ r.lastUsed }}</span>
              </span>
              <span class="truncate text-[12px]" :class="r.note ? 'text-[var(--text-2)]' : 'text-[var(--text-muted)]'">{{ r.note ?? 'no note' }}</span>
              <span class="flex flex-wrap gap-1">
                <span v-for="h in r.hosts" :key="h" class="rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[11px] text-[var(--text-2)]">{{ h }}</span>
                <span v-if="!r.hosts.length" class="text-[11px] text-[var(--text-muted)]">not signed in anywhere</span>
              </span>
            </button>
          </li>
        </ul>
        <button type="button" :class="TEXT_BTN" class="mt-1 self-center" @click="load"><RefreshCw class="size-3" />Refresh</button>
      </div>
    </div>

    <!-- a card's request the list has no live answer for -->
    <div v-else-if="missing" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center" role="status">
      <div v-if="missing.url" class="max-w-full break-all font-mono text-[12px]">{{ missing.url }}</div>
      <div class="text-[var(--text-muted)]">{{ missing.profile ? `${missing.profile} is not running now.` : 'That browser is not running now.' }}</div>
      <div class="flex gap-1">
        <button v-if="missing.profile" type="button" :class="TEXT_BTN" :disabled="busy" @click="openProfile(missing.profile, false, missing.url ?? undefined)">Open</button>
        <button type="button" :class="TEXT_BTN" @click="unselect">Saved browsers</button>
      </div>
      <div v-if="actionError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
    </div>

    <!-- one browser -->
    <template v-else>
      <div class="flex h-8 shrink-0 items-center gap-1 border-t border-border px-2">
        <Tip label="Saved browsers"><button type="button" :class="ICON_BTN" aria-label="Saved browsers" @click="unselect"><ChevronLeft class="size-4" /></button></Tip>
        <span class="size-2 shrink-0 rounded-full" :class="selectedRow?.open ? DOT.run : DOT.off" aria-hidden="true" />
        <span class="truncate font-medium">{{ selected }}</span>
        <span class="flex-1" />
        <Tip label="Refresh"><button type="button" :class="ICON_BTN" aria-label="Refresh saved browsers" @click="refresh"><RefreshCw class="size-4" /></button></Tip>
      </div>
      <form v-show="phase === 'live' || phase === 'connecting'" class="flex h-8 shrink-0 items-center gap-1 border-t border-border px-2" @submit.prevent="submitAddress">
        <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="!page?.canGoBack" @click="history('back')"><ArrowLeft class="size-4" /></button></Tip>
        <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="!page?.canGoForward" @click="history('forward')"><ArrowRight class="size-4" /></button></Tip>
        <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" :disabled="!page" @click="history('reload')"><RotateCw class="size-4" /></button></Tip>
        <input ref="addressEl" v-model="address" type="text" spellcheck="false" aria-label="Address" placeholder="An address" :class="INPUT" />
      </form>
      <div v-if="tabs.length > 1 && (phase === 'live' || phase === 'connecting')" role="tablist" aria-label="Pages" class="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border px-2">
        <button v-for="t in tabs" :key="t.id" type="button" role="tab" :aria-selected="t.id === page?.tab.id" :class="tab(t.id === page?.tab.id)" class="max-w-[160px]" :title="t.url" @click="pickTab(t.id)">
          <span class="truncate">{{ t.title || t.url }}</span>
        </button>
      </div>

      <div class="relative min-h-0 flex-1 border-t border-border bg-[var(--bg-page)]">
        <div ref="stage" class="absolute inset-0" :class="phase === 'live' || phase === 'connecting' ? '' : 'invisible'">
          <canvas
            ref="canvas"
            tabindex="0"
            class="size-full outline-none focus-visible:shadow-[var(--focus-ring)]"
            aria-label="The browser, live"
            @mousedown="onDown"
            @mousemove="onMove"
            @wheel.prevent="onWheel"
            @contextmenu.prevent
            @keydown="onKey"
            @keyup="onKey"
            @paste="onPaste"
          />
        </div>
        <div v-if="phase === 'connecting'" class="pointer-events-none absolute inset-0 flex items-center justify-center text-[var(--text-muted)]" role="status">Connecting…</div>
        <div v-else-if="phase === 'closed'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center" role="status">
          <div class="text-[var(--text-muted)]">{{ closedWhy || 'The browser closed.' }}</div>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="selected && openProfile(selected)">Open</button>
        </div>
        <div v-else-if="phase === 'idle'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center">
          <template v-if="loginFor">
            <div role="status">Sign in in the Chrome window that opened, then close it.</div>
            <button type="button" :class="TEXT_BTN" @click="refresh"><RefreshCw class="size-3" />Refresh</button>
          </template>
          <template v-else>
            <div class="text-[var(--text-muted)]">{{ selected }} is not open.</div>
            <div class="flex gap-1">
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="selected && openProfile(selected)">Open</button>
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="selected && openProfile(selected, true)">Open to log in</button>
            </div>
          </template>
          <div v-if="actionError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
        </div>
      </div>
    </template>
  </div>
</template>
