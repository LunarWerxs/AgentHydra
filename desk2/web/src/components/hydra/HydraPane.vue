<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AH_SETTINGS_PAGES, type AhMessage, type AhSettingsPage } from '@shared/hydra-embed'
import { attachHydraFrame, hydraReady, setAhUpdateWaiting, setHydraSidebar, setHydraVisible } from './api'
import { CAPTION_W, ownFrame } from '@/lib/host-window'

// Hydra Desk 2: AgentHydra in the pane beside the sidebar (the chrome bar's AgentHydra button slides it in
// over the chat). It is Desk 2's own copy of AgentHydra's window (desk2/hydra), served by Desk 2 at /ah/
// and talking to the one AgentHydra daemon through it, so it can be changed here without touching
// AgentHydra. The copy has no Sessions tab: the sidebar's cloud list is the session list, and a chat the
// copy asks to open (ah:open-session) or its session tiles (ah:show-sessions) come back to Desk. A tab
// with a sidebar of its own hands it over (ah:sidebar) and Desk's sidebar draws it (shared/hydra-embed.ts).
// The frame is created in the background once Desk's sidebar has loaded (browser idle), so opening the
// pane shows AgentHydra at once, and then stays, so going back and forth keeps it where it was. There is no
// header strip: the copy's own top bar fills the pane, and Escape (or the chrome bar's AgentHydra button)
// closes it. Out of view the copy is told so (desk:visible) and its polls rest until it comes back.
// The copy gets the room the chrome bar covers on the left as --desk-pad-left, and the room the window's own buttons
// cover on the right (lib/host-window.ts) as --desk-pad-right.
const props = defineProps<{
  open: boolean
  /** Room the chrome bar covers at the pane's top left when the sidebar is hidden. */ padLeft: number
  /** Desk's sidebar has its first lists: the frame may preload when the browser is idle. */ preload?: boolean
  /** The AgentHydra button was pointed at or focused: start the frame now. */ intent?: boolean
}>()
const emit = defineEmits<{ close: []; 'open-session': [id: string]; 'show-sessions': []; 'open-settings': [section?: AhSettingsPage] }>()
const settingsPage = (v: unknown) => (AH_SETTINGS_PAGES as readonly unknown[]).includes(v) ? (v as AhSettingsPage) : undefined

const SRC = '/ah/?embed=desk'
const daemon = ref<string | null>(null)
const up = ref(true)
const started = ref(false)
const frameKey = ref(0)
const frame = ref<HTMLIFrameElement | null>(null)
async function readStatus(): Promise<void> {
  try {
    const res = await fetch('/api/bridge/status')
    const s = (await res.json()) as { up: boolean; url: string }
    daemon.value = s.url.replace(/\/+$/, '').replace(/^https?:\/\//, '')
    up.value = s.up
  } catch {
    up.value = false
  }
}
function frameWindow(): Window | null {
  return frame.value?.contentWindow ?? null
}
function syncPad() {
  try {
    const root = frameWindow()?.document.documentElement
    root?.style.setProperty('--desk-pad-left', `${props.padLeft}px`)
    root?.style.setProperty('--desk-pad-right', `${ownFrame.value ? CAPTION_W : 0}px`)
  } catch {
    /* not same-origin yet */
  }
}
watch([() => props.padLeft, ownFrame], syncPad)
watch(
  () => props.open,
  (open) => {
    setHydraVisible(open)
    if (!open) return
    started.value = true
    // The copy refreshes what it shows right as the pane comes back.
    try {
      frameWindow()?.dispatchEvent(new Event('hydra:pane-open'))
    } catch {
      /* frame not ready */
    }
    // Coming back to a pane that found AgentHydra down asks again.
    if (!up.value) void readStatus().then(() => up.value && reload())
  },
  { immediate: true }
)
// A new frame (first open, Reload) starts unheard: what Desk says is held until it is ready.
watch(frame, (f) => attachHydraFrame(f?.contentWindow ?? null), { flush: 'post' })

function onMessage(e: MessageEvent) {
  if (e.origin !== window.location.origin || !frame.value || e.source !== frame.value.contentWindow) return
  const m = e.data as AhMessage | null
  if (m?.type === 'ah:ready') hydraReady(e.source as Window)
  else if (m?.type === 'ah:open-session' && typeof m.session_id === 'string' && m.session_id) emit('open-session', m.session_id)
  else if (m?.type === 'ah:show-sessions') emit('show-sessions')
  else if (m?.type === 'ah:open-settings') emit('open-settings', settingsPage(m.section))
  else if (m?.type === 'ah:update-dot') setAhUpdateWaiting(m.on === true)
  else if (m?.type === 'ah:sidebar') setHydraSidebar(m.model && Array.isArray(m.model.sections) ? m.model : null)
}
// An Escape that closes a pop-up over the pane (Settings, which a table's gear opens, or a menu) is the
// pop-up's: the window hears it after the document, while the pop-up is still there.
function onKey(e: KeyboardEvent) {
  if (props.open && e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) emit('close')
}
// The copy asks to close when Escape is pressed inside its own frame (keys do not cross frames).
const onCloseAsk = () => props.open && emit('close')
// Preload: once Desk's sidebar has its first lists, start the frame when the browser is next idle (no forced
// timeout, so it never competes with the sidebar's reads); intent (the button pointed at or focused) starts it at once.
let idleHandle: number | undefined
const cancelIdle = () => {
  if (idleHandle === undefined) return
  if ('cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
  else clearTimeout(idleHandle)
}
const start = () => {
  cancelIdle()
  started.value = true
}
watch(
  () => props.preload,
  (ready) => {
    if (!ready || started.value || idleHandle !== undefined) return
    if ('requestIdleCallback' in window) idleHandle = window.requestIdleCallback(start)
    else idleHandle = setTimeout(start, 0) as unknown as number
  },
  { immediate: true }
)
watch(
  () => props.intent,
  (on) => on && start(),
  { immediate: true }
)
onMounted(() => {
  void readStatus()
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKey)
  window.addEventListener('hydra-desk:close-hydra', onCloseAsk)
})
onBeforeUnmount(() => {
  cancelIdle()
  window.removeEventListener('message', onMessage)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('hydra-desk:close-hydra', onCloseAsk)
  attachHydraFrame(null)
})

const checking = ref(false)
function reload() {
  checking.value = true
  void readStatus().finally(() => (checking.value = false))
  frameKey.value++
}

</script>

<template>
  <section class="flex h-full min-w-0 flex-col" aria-label="AgentHydra">
    <div class="relative min-h-0 flex-1 overflow-hidden bg-bg-page">
      <iframe
        v-if="started && up"
        ref="frame"
        :key="frameKey"
        :src="SRC"
        title="AgentHydra"
        class="absolute inset-0 size-full border-0"
        @load="syncPad"
      />
      <div v-else-if="started" class="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-text-2">
        <p>AgentHydra is not answering{{ daemon ? ` at ${daemon}` : '' }}.</p>
        <button type="button" class="h-7 rounded-(--radius-6) bg-(--fill-secondary) px-3 text-[13px] text-text hover:bg-(--fill-secondary-hover) disabled:opacity-60" :disabled="checking" :aria-busy="checking" @click="reload">
          Try again
        </button>
      </div>
    </div>
  </section>
</template>
