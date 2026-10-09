<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ExternalLink, Play, RotateCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { DevWebProcess } from '@shared/devwebui'
import { addressOrSearch, isLocalPage, isUp, proxyAddress, statusWord } from './logic'
import { coveredByPage, hasHostBrowser, type HostBrowserOut, type HostRect, HostView, hostRect } from './native-browser'
import { registerView, viewAudio } from '@/lib/chat-audio'
import { audioKey } from './background-policy'
import { backgroundViews } from './background-views'
import { ICON_BTN, INPUT, TEXT_BTN } from './styles'

// A page tab: a dev server or an address, with back / forward / reload and the address bar on top. In AgentHydra's own
// window the page is a browser view of the window's, placed over the tab (native-browser.ts), so a site that refuses to
// be framed still shows; in a plain browser it is a frame (the 'through AgentHydra' view is Desk's own same-origin
// /dw/proxy). Every page tab stays mounted while another is shown, so switching tabs does not reload a page.
const props = defineProps<{ chatId: string; url: string; proc: DevWebProcess | null; busy: boolean; justStarted: boolean }>()
const emit = defineEmits<{ navigated: [url: string]; toggle: [proc: DevWebProcess] }>()

const native = hasHostBrowser()
const history = ref<string[]>([props.url])
const at = ref(0)
const address = ref(props.url)
const reloads = ref(0)
const viaManager = ref(false)
const current = computed(() => history.value[at.value] ?? null)
const frameSrc = computed(() => {
  const cur = current.value
  if (!cur) return null
  if (viaManager.value && props.proc) return proxyAddress(props.proc)
  return cur
})
/** Where the host's view is now (a link it followed included); the frame's own page cannot be read. */
const live = ref<string | null>(null)
const shown = computed(() => (native && live.value) || current.value)
const wanted = computed(() => !!frameSrc.value && (!props.proc || props.proc.status === 'running'))
const localPage = computed(() => isLocalPage(frameSrc.value ?? ''))
const addressEl = ref<HTMLInputElement | null>(null)
const slot = ref<HTMLElement | null>(null)

function go(url: string) {
  history.value = [...history.value.slice(0, at.value + 1), url]
  at.value = history.value.length - 1
  address.value = url
  viaManager.value = false
  view?.open(url, measure())
  emit('navigated', url)
}
function move(to: number) {
  at.value = to
  address.value = current.value ?? ''
  viaManager.value = false
  if (current.value) emit('navigated', current.value)
}
/** The host's view keeps its own history, links followed included. */
const back = () => (view ? view.act('back') : move(at.value - 1))
const forward = () => (view ? view.act('forward') : move(at.value + 1))
function submit() {
  const url = addressOrSearch(address.value)
  if (url && url !== shown.value) go(url)
  else if (url) reloads.value++
}

// A dev server reports running a moment before it listens: look once more so the frame is not left on a refused page.
onMounted(() => {
  if (props.justStarted) setTimeout(() => reloads.value++, 2500)
})
watch(
  () => props.proc?.status,
  (now, was) => {
    if (now === 'running' && was && was !== 'running') setTimeout(() => reloads.value++, 2500)
  }
)

// ---- the host's view: open once wanted, kept over the tab's box, hidden while the tab is hidden or covered ----
const onHostEvent = (e: HostBrowserOut) => {
  if (e.type === 'audio') return viewAudio(e.id, e.playing)
  live.value = e.url || live.value
  if (e.url && document.activeElement !== addressEl.value) address.value = e.url
}
// A view that kept playing in the background after the person left this chat is taken back, same page and position.
const adopted = native ? backgroundViews.adopt(props.chatId, props.url) : null
const view = native ? (adopted ?? new HostView(onHostEvent)) : null
adopted?.listen(onHostEvent)
/** The address the view was opened at: how a later visit to this chat finds it. */
const openedAt = props.url

// The chat's mute reaches this view through the store; a view of a muted chat is muted as it opens (HostView.mute).
const unregister = view ? registerView(audioKey(props.chatId), view.id, (m) => view.mute(m)) : null

function measure(): HostRect | null {
  const el = slot.value
  if (!el || !wanted.value) return null
  const box = el.getBoundingClientRect()
  const rect = hostRect(box, window.devicePixelRatio || 1)
  return rect && !coveredByPage(el, box) ? rect : null
}
function sync() {
  if (!view) return
  if (view.isOpen) view.place(measure())
  else if (wanted.value && frameSrc.value) view.open(frameSrc.value, measure())
}
let frame = 0
function soon() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    sync()
  })
}
watch(wanted, soon)
watch(reloads, () => view?.act('reload'))

if (view) {
  // The box moves with the window, the divider, the sidebar and a tab switch; a menu or dialog opens in body. A slow
  // look catches what fires nothing (a page zoom, a move to a monitor of another scale).
  let resized: ResizeObserver | null = null
  let opened: MutationObserver | null = null
  let slow = 0
  // The slow look (a forced layout each tick) rests while the window is hidden and looks at once when it is shown.
  const pace = () => {
    window.clearInterval(slow)
    slow = 0
    if (document.hidden) return
    slow = window.setInterval(sync, 250)
    sync()
  }
  onMounted(() => {
    resized = new ResizeObserver(soon)
    if (slot.value) resized.observe(slot.value)
    opened = new MutationObserver(soon)
    opened.observe(document.body, { childList: true })
    window.addEventListener('resize', soon)
    document.addEventListener('visibilitychange', pace)
    pace()
  })
  onBeforeUnmount(() => {
    resized?.disconnect()
    opened?.disconnect()
    window.removeEventListener('resize', soon)
    document.removeEventListener('visibilitychange', pace)
    window.clearInterval(slow)
    if (frame) cancelAnimationFrame(frame)
    // A view that plays sound stays, hidden, while its chat is off screen (background-views.ts); else it closes with the tab.
    if (backgroundViews.leave(props.chatId, openedAt, view, unregister)) return
    unregister?.()
    view.close()
  })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <form class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" @submit.prevent="submit">
      <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="!view && at <= 0" @click="back"><ArrowLeft class="size-4" /></button></Tip>
      <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="!view && at >= history.length - 1" @click="forward"><ArrowRight class="size-4" /></button></Tip>
      <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" @click="reloads++"><RotateCw class="size-4" /></button></Tip>
      <input ref="addressEl" v-model="address" type="text" spellcheck="false" aria-label="Address" placeholder="An address, a port, or a search" :class="INPUT" />
      <Tip label="Open in the system browser">
        <a v-if="shown" :href="shown" target="_blank" rel="noopener noreferrer" :class="ICON_BTN" aria-label="Open in the system browser"><ExternalLink class="size-4" /></a>
      </Tip>
    </form>
    <div class="relative min-h-0 flex-1 bg-white bg-clip-padding">
      <!-- In AgentHydra's window the host's view covers this box; it stays empty here. -->
      <div v-if="view" ref="slot" class="size-full" data-testid="page-host-slot" />
      <!-- A server's page loads once it runs: a frame opened while it starts would sit on a refused-connection page. -->
      <div v-else-if="wanted && localPage" class="flex size-full items-center justify-center px-6 text-center text-(--text-muted)" role="status">A local page opens in AgentHydra's window or in the system browser (the button above).</div>
      <iframe v-else-if="wanted && frameSrc" :key="`${frameSrc}#${reloads}`" :src="frameSrc" :title="proc ? `${proc.name} preview` : 'Preview'" class="size-full border-0" referrerpolicy="no-referrer" />
      <div v-if="proc && proc.status !== 'running'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-(--bg-page) px-6 text-center" role="status">
        <div class="text-(--text-muted)">{{ proc.name }} is {{ statusWord(proc) }}{{ isUp(proc.status) ? ', opens when it answers' : '' }}.</div>
        <button v-if="!isUp(proc.status)" type="button" :class="TEXT_BTN" :disabled="busy" @click="emit('toggle', proc)"><Play class="size-3" />Start</button>
      </div>
      <button
        v-else-if="!view && frameSrc && proc"
        type="button"
        class="absolute bottom-2 right-2 flex h-6 items-center rounded-(--radius-6) bg-(--bg-popover) px-2 text-[12px] text-(--text) opacity-80 shadow-(--shadow-menu-ringed) transition-opacity duration-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
        :aria-pressed="viaManager"
        @click="viaManager = !viaManager"
      >{{ viaManager ? 'Show directly' : 'Blank? Show through the server manager' }}</button>
    </div>
  </div>
</template>
