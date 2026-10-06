<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AhMessage } from '@shared/hydra-embed'
import { attachHydraFrame, hydraReady, setHydraSidebar, setHydraVisible } from './api'

// Hydra Desk 2: AgentHydra in the pane beside the sidebar (the chrome bar's AgentHydra button slides it in
// over the chat). It is Desk 2's own copy of AgentHydra's window (desk2/hydra), served by Desk 2 at /ah/
// and talking to the one AgentHydra daemon through it, so it can be changed here without touching
// AgentHydra. The copy has no Sessions tab: the sidebar's cloud list is the session list, and a chat the
// copy asks to open (ah:open-session) or its session tiles (ah:show-sessions) come back to Desk. A tab
// with a sidebar of its own hands it over (ah:sidebar) and Desk's sidebar draws it (shared/hydra-embed.ts).
// The frame is created in the background shortly after Desk's first paint (browser idle), so opening the
// pane shows AgentHydra at once, and then stays, so going back and forth keeps it where it was. There is no
// header strip: the copy's own top bar fills the pane, and Escape (or the chrome bar's AgentHydra button)
// closes it. Out of view the copy is told so (desk:visible) and its polls rest until it comes back.
// The copy gets the room the chrome bar covers on the left as --desk-pad-left.
const props = defineProps<{ open: boolean; /** Room the chrome bar covers at the pane's top left when the sidebar is hidden. */ padLeft: number }>()
const emit = defineEmits<{ close: []; 'open-session': [id: string]; 'show-sessions': []; 'open-settings': [section?: 'updates'] }>()

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
    frameWindow()?.document.documentElement.style.setProperty('--desk-pad-left', `${props.padLeft}px`)
  } catch {
    /* not same-origin yet */
  }
}
watch(() => props.padLeft, syncPad)
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
  else if (m?.type === 'ah:open-settings') emit('open-settings', m.section === 'updates' ? 'updates' : undefined)
  else if (m?.type === 'ah:sidebar') setHydraSidebar(m.model && Array.isArray(m.model.sections) ? m.model : null)
}
function onKey(e: KeyboardEvent) {
  if (props.open && e.key === 'Escape' && !e.defaultPrevented) emit('close')
}
// The copy asks to close when Escape is pressed inside its own frame (keys do not cross frames).
const onCloseAsk = () => props.open && emit('close')
let idleHandle: number | undefined
onMounted(() => {
  void readStatus()
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKey)
  window.addEventListener('hydra-desk:close-hydra', onCloseAsk)
  // Preload: start the frame once Desk has painted and the browser is idle.
  const start = () => {
    started.value = true
  }
  if ('requestIdleCallback' in window) idleHandle = window.requestIdleCallback(start, { timeout: 4000 })
  else idleHandle = setTimeout(start, 3000) as unknown as number
})
onBeforeUnmount(() => {
  if (idleHandle !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
  window.removeEventListener('message', onMessage)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('hydra-desk:close-hydra', onCloseAsk)
  attachHydraFrame(null)
})

function reload() {
  void readStatus()
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
        <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="reload">
          Try again
        </button>
      </div>
    </div>
  </section>
</template>
