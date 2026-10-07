<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ArrowLeft, ArrowRight, RefreshCw, RotateCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { isRealPage, type BrowserLiveIn, type BrowserLiveOut, type BrowserProfiles, type BrowserTab } from '@shared/browser'
import { browserOpen, browserProfiles } from './api'
import { clipboardAction, fitFrame, keyMessage, liveSocketUrl, mapPoint, modifiersOf, mouseButton, normalizeAddress, profileRows } from './logic'
import { ICON_BTN, INPUT, TEXT_BTN } from './styles'

// A saved-browser tab: one saved Chrome browser of this chat's workspace (shared/browser.ts), watched live on a canvas
// and driven with the person's mouse and keyboard (to sign in, say). One that is not open is opened here, or opened to
// log in: that Chrome has no live view until it is closed. The list of saved browsers is the New tab's.
// With `pageId` it shows that one page (the pane gives every real page its own tab); without, the Chrome's first page.
const props = defineProps<{ cwd: string; profile: string; url?: string; pageId?: string }>()

const list = shallowRef<BrowserProfiles | null>(null)
const listError = ref<string | null>(null)
const rows = computed(() => profileRows(list.value))
const selected = computed(() => props.profile)
const note = computed(() => rows.value.find((r) => r.name === props.profile)?.note ?? null)
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
const address = ref('')
const canvas = ref<HTMLCanvasElement | null>(null)
const stage = ref<HTMLElement | null>(null)
/** What takes the keys and the paste event: an editable box (a canvas gets no paste event) outside the stage, so a hidden stage never costs it focus. */
const keys = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)
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
  queueViewport()
}
// The page is laid out at the canvas box's size, so it fills the pane instead of being letterboxed.
let sentSize: { width: number; height: number } | null = null
let viewportTimer: ReturnType<typeof setTimeout> | null = null
function queueViewport(now = false) {
  if (viewportTimer) clearTimeout(viewportTimer)
  const go = () => {
    viewportTimer = null
    const s = stage.value
    if (!s || socket?.readyState !== WebSocket.OPEN) return
    const width = Math.round(s.clientWidth)
    const height = Math.round(s.clientHeight)
    if (width < 1 || height < 1) return
    if (sentSize && Math.abs(sentSize.width - width) < 2 && Math.abs(sentSize.height - height) < 2) return
    sentSize = { width, height }
    send({ type: 'viewport', width, height })
  }
  if (now) go()
  else viewportTimer = setTimeout(go, 150)
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

/** The person's clipboard gets the page's selection; a webview that refuses the async API gets the copy command's way. */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // falls through to the copy command
  }
  const box = document.createElement('textarea')
  box.value = text
  box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.append(box)
  box.select()
  document.execCommand('copy')
  box.remove()
  keys.value?.focus()
}

function disconnect() {
  const s = socket
  socket = null
  s?.close()
  frame = null
  decoding++
  page.value = null
  draw()
}
function connect(name: string, tabId?: string) {
  const had = focused.value
  disconnect()
  phase.value = 'connecting'
  closedWhy.value = ''
  const ws = new WebSocket(liveSocketUrl(window.location, props.cwd, name, tabId))
  socket = ws
  sentSize = null
  ws.onopen = () => queueViewport(true)
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
    } else if (m.type === 'clipboard') {
      if (m.text) void writeClipboard(m.text)
    } else if (m.type === 'closed') {
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
  void nextTick(() => {
    sizeCanvas()
    if (had) keys.value?.focus()
  })
}
const send = (m: BrowserLiveIn) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(m))

function select(name: string) {
  actionError.value = null
  loginFor.value = null
  const row = rows.value.find((r) => r.name === name)
  if (row?.open) connect(name, props.pageId)
  else {
    disconnect()
    phase.value = 'idle'
  }
}

/** Open the profile's Chrome. With `login`, visible and with nothing attached; otherwise then watch it here. */
async function openProfile(name: string, login = false, url?: string) {
  busy.value = true
  actionError.value = null
  try {
    await browserOpen(props.cwd, name, { login, ...(url ? { url } : {}) })
    if (login) {
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

// ---- the person's input, forwarded ----
const addressEl = ref<HTMLInputElement | null>(null)
function submitAddress() {
  const url = normalizeAddress(address.value)
  if (url) send({ type: 'navigate', url })
  keys.value?.focus()
}
const history = (go: 'back' | 'forward' | 'reload') => send({ type: 'history', go })

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
  keys.value?.focus()
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
  const action = clipboardAction(e)
  // Paste is the textarea's own paste event; copy and cut read the selection from the page (a synthesized Ctrl+C does not reach the clipboard).
  if (action === 'paste') return
  e.preventDefault()
  if (action) {
    if (e.type === 'keydown') send({ type: 'copy', cut: action === 'cut' })
    return
  }
  send(keyMessage(e))
}
function onPaste(e: ClipboardEvent) {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain')
  if (text) send({ type: 'text', text })
}

onMounted(() => {
  window.addEventListener('focus', onFocus)
  void load().then(() => select(props.profile))
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
  if (viewportTimer) clearTimeout(viewportTimer)
  disconnect()
})
defineExpose({ refresh })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <template v-if="selected">
      <form class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" @submit.prevent="submitAddress">
        <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="!page?.canGoBack" @click="history('back')"><ArrowLeft class="size-4" /></button></Tip>
        <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="!page?.canGoForward" @click="history('forward')"><ArrowRight class="size-4" /></button></Tip>
        <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" :disabled="!page" @click="history('reload')"><RotateCw class="size-4" /></button></Tip>
        <input ref="addressEl" v-model="address" type="text" spellcheck="false" aria-label="Address" placeholder="An address" :class="INPUT" />
      </form>
      <div v-if="note" class="truncate border-b border-border px-3 py-1 text-[12px] text-[var(--text-muted)]" data-testid="browser-note" :title="note">{{ note }}</div>
      <div class="relative min-h-0 flex-1 bg-[var(--bg-page)]">
        <div ref="stage" class="absolute inset-0" :class="phase === 'live' || phase === 'connecting' ? '' : 'invisible'">
          <canvas
            ref="canvas"
            tabindex="0"
            class="size-full outline-none"
            :class="focused ? 'shadow-[var(--focus-ring)]' : ''"
            aria-label="The browser, live"
            @mousedown="onDown"
            @mousemove="onMove"
            @wheel.prevent="onWheel"
            @contextmenu.prevent
            @focus="keys?.focus()"
          />
        </div>
        <textarea
          ref="keys"
          class="pointer-events-none absolute left-0 top-0 size-px resize-none opacity-0"
          aria-label="Keyboard input for the browser"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKey"
          @keyup="onKey"
          @paste="onPaste"
          @focus="focused = true"
          @blur="focused = false"
        />
        <div v-if="phase === 'live' && page && !isRealPage(page.tab.url)" class="pointer-events-none absolute inset-x-0 top-3 flex justify-center" role="status" data-testid="page-blank">
          <span class="rounded-[var(--radius-10)] bg-[var(--bg-popover)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] shadow-(--shadow-menu-ringed)">This page is blank.</span>
        </div>
        <div v-if="phase === 'connecting'" class="pointer-events-none absolute inset-0 flex items-center justify-center text-[var(--text-muted)]" role="status">Connecting…</div>
        <div v-else-if="phase === 'closed'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center" role="status">
          <div class="text-[var(--text-muted)]">{{ closedWhy || 'The browser closed.' }}</div>
          <div v-if="!pageId" class="flex gap-1">
            <button type="button" :class="TEXT_BTN" :disabled="busy" @click="openProfile(selected, false, url)">Open</button>
            <button type="button" :class="TEXT_BTN" class="font-medium" :disabled="busy" data-testid="browser-login" @click="openProfile(selected, true)">Log in</button>
          </div>
        </div>
        <div v-else-if="phase === 'idle'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center">
          <template v-if="loginFor">
            <div role="status">Sign in in the Chrome window that opened, then close it.</div>
            <button type="button" :class="TEXT_BTN" @click="refresh"><RefreshCw class="size-3" />Refresh</button>
          </template>
          <template v-else>
            <div class="font-medium">{{ selected }}</div>
            <div class="text-[var(--text-muted)]">This browser is not open. Log in to sign in to it here, or just open it.</div>
            <div class="flex gap-1">
              <button type="button" :class="TEXT_BTN" class="font-medium" :disabled="busy" data-testid="browser-login" @click="openProfile(selected, true)">Log in</button>
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="openProfile(selected, false, url)">Open</button>
            </div>
          </template>
          <div v-if="actionError" class="rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--danger-text)]" role="alert">{{ actionError }}</div>
        </div>
      </div>
    </template>
  </div>
</template>
