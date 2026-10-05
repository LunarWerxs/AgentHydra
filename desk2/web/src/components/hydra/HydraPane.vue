<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import type { AhMessage } from '@shared/hydra-embed'
import { Tip } from '@/components/ui/tooltip'
import { agentHydraIcon } from '@/lib/icons'
import { attachHydraFrame, hydraReady, hydraSidebar, setHydraVisible } from './api'

// Hydra Desk 2: AgentHydra in the pane beside the sidebar (the chrome bar's AgentHydra button slides it in
// over the chat). It is Desk 2's own copy of AgentHydra's window (desk2/hydra), served by Desk 2 at /ah/
// and talking to the one AgentHydra daemon through it, so it can be changed here without touching
// AgentHydra. The copy has no Sessions tab: the sidebar's cloud list is the session list, and a chat the
// copy asks to open (ah:open-session) or its session tiles (ah:show-sessions) come back to Desk. A tab
// with a sidebar of its own hands it over (ah:sidebar) and Desk's sidebar draws it (shared/hydra-embed.ts).
// The frame loads the first time the pane opens and then stays, so going back and forth keeps AgentHydra
// where it was; out of view it is told so (desk:visible), and its polls rest until it comes back.
const props = defineProps<{ open: boolean; /** Left padding of the title strip (the chrome bar lies over it when the sidebar is hidden). */ padLeft: number }>()
const emit = defineEmits<{ close: []; 'open-session': [id: string]; 'show-sessions': [] }>()

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
watch(
  () => props.open,
  (open) => {
    setHydraVisible(open)
    if (!open) return
    started.value = true
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
  if (m?.type === 'ah:ready') hydraReady()
  else if (m?.type === 'ah:open-session' && typeof m.session_id === 'string' && m.session_id) emit('open-session', m.session_id)
  else if (m?.type === 'ah:show-sessions') emit('show-sessions')
  else if (m?.type === 'ah:sidebar') hydraSidebar.value = m.model && Array.isArray(m.model.sections) ? m.model : null
}
onMounted(() => {
  void readStatus()
  window.addEventListener('message', onMessage)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  attachHydraFrame(null)
})

function reload() {
  void readStatus()
  frameKey.value++
}

const BTN = 'flex h-[26px] shrink-0 items-center gap-1 rounded-[var(--radius-6)] px-1.5 text-[13px] text-text-2 hover:bg-fill-hover hover:text-text'
</script>

<template>
  <section class="flex h-full min-w-0 flex-col" aria-label="AgentHydra">
    <div class="flex h-[41px] shrink-0 items-center gap-1.5 pr-2 pt-0.5" :style="{ paddingLeft: `${padLeft}px` }">
      <component :is="agentHydraIcon" class="size-4 shrink-0 text-text" />
      <span class="min-w-0 truncate text-[13px] font-medium leading-[19.5px] text-text">AgentHydra</span>
      <Tip :label="`Hydra Desk 2's own copy of AgentHydra's window, on the AgentHydra at ${daemon ?? '…'}`">
        <span class="min-w-0 truncate text-[12px] text-text-muted">Desk 2's copy{{ daemon ? ` · ${daemon}` : '' }}</span>
      </Tip>
      <span class="flex-1" />
      <Tip label="Reload AgentHydra">
        <button type="button" :class="BTN" aria-label="Reload AgentHydra" @click="reload">
          <RefreshCw class="size-3.5" />
        </button>
      </Tip>
      <Tip label="Back to Hydra Desk">
        <button type="button" :class="BTN" aria-label="Back to Hydra Desk" @click="emit('close')">
          <ArrowLeft class="size-3.5" />
          <span>Desk</span>
        </button>
      </Tip>
    </div>
    <div class="relative min-h-0 flex-1 overflow-hidden border-t border-border bg-bg-page">
      <iframe v-if="started && up" ref="frame" :key="frameKey" :src="SRC" title="AgentHydra" class="absolute inset-0 size-full border-0" />
      <div v-else-if="started" class="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-text-2">
        <p>AgentHydra is not answering{{ daemon ? ` at ${daemon}` : '' }}.</p>
        <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="reload">
          Try again
        </button>
      </div>
    </div>
  </section>
</template>
