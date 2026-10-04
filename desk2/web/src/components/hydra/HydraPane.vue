<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'

// Hydra Desk 2: AgentHydra itself, in the pane beside the sidebar (the chrome bar's AgentHydra button
// slides it in over the chat). Its own window in a frame: the address is the one the server's bridge
// talks to (GET /api/bridge/status), so a daemon on another port or host still shows. The frame loads the
// first time the pane opens and then stays, so going back and forth keeps AgentHydra where it was.
const props = defineProps<{ open: boolean; /** Left padding of the title strip (the chrome bar lies over it when the sidebar is hidden). */ padLeft: number }>()
const emit = defineEmits<{ close: [] }>()

const url = ref<string | null>(null)
const up = ref(true)
const started = ref(false)
const frameKey = ref(0)

async function readStatus(): Promise<void> {
  try {
    const res = await fetch('/api/bridge/status')
    const s = (await res.json()) as { up: boolean; url: string }
    url.value = s.url.replace(/\/+$/, '')
    up.value = s.up
  } catch {
    up.value = false
  }
}
onMounted(readStatus)
watch(
  () => props.open,
  (open) => {
    if (!open) return
    started.value = true
    // Coming back to a pane that found AgentHydra down asks again.
    if (!up.value) void readStatus().then(() => up.value && frameKey.value++)
  },
  { immediate: true }
)

function reload() {
  void readStatus()
  frameKey.value++
}

const BTN = 'flex h-[26px] shrink-0 items-center gap-1 rounded-[var(--radius-6)] px-1.5 text-[13px] text-text-2 hover:bg-fill-hover hover:text-text'
</script>

<template>
  <section class="flex h-full min-w-0 flex-col" aria-label="AgentHydra">
    <div class="flex h-[41px] shrink-0 items-center gap-1.5 pr-2 pt-0.5" :style="{ paddingLeft: `${padLeft}px` }">
      <img src="/agenthydra.svg" alt="" class="size-4 shrink-0 rounded-[3px]" />
      <span class="min-w-0 truncate text-[13px] font-medium leading-[19.5px] text-text">AgentHydra</span>
      <span v-if="url" class="min-w-0 truncate text-[12px] text-text-muted">{{ url.replace(/^https?:\/\//, '') }}</span>
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
      <iframe
        v-if="started && url && up"
        :key="frameKey"
        :src="`${url}/`"
        title="AgentHydra"
        class="absolute inset-0 size-full border-0"
      />
      <div v-else-if="started" class="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-text-2">
        <p>AgentHydra is not answering{{ url ? ` at ${url}` : '' }}.</p>
        <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="reload">
          Try again
        </button>
      </div>
    </div>
  </section>
</template>
