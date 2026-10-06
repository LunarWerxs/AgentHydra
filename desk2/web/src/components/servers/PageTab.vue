<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ExternalLink, Play, RotateCw } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { DevWebProcess } from '@shared/devwebui'
import { addressOrSearch, isUp, proxyAddress, statusWord } from './logic'
import { ICON_BTN, INPUT, TEXT_BTN } from './styles'

// A page tab: a dev server or an address in a frame, with back / forward / reload and the address bar on top.
// Every page tab stays mounted while another is shown, so switching tabs does not reload a page.
const props = defineProps<{ url: string; proc: DevWebProcess | null; daemonUrl: string | null; busy: boolean; justStarted: boolean }>()
const emit = defineEmits<{ navigated: [url: string]; toggle: [proc: DevWebProcess] }>()

const history = ref<string[]>([props.url])
const at = ref(0)
const address = ref(props.url)
const reloads = ref(0)
const viaManager = ref(false)
const current = computed(() => history.value[at.value] ?? null)
const frameSrc = computed(() => {
  const cur = current.value
  if (!cur) return null
  if (viaManager.value && props.proc && props.daemonUrl) return proxyAddress(props.daemonUrl, props.proc)
  return cur
})

function go(url: string) {
  history.value = [...history.value.slice(0, at.value + 1), url]
  at.value = history.value.length - 1
  address.value = url
  viaManager.value = false
  emit('navigated', url)
}
function move(to: number) {
  at.value = to
  address.value = current.value ?? ''
  viaManager.value = false
  if (current.value) emit('navigated', current.value)
}
function submit() {
  const url = addressOrSearch(address.value)
  if (url && url !== current.value) go(url)
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
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <form class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" @submit.prevent="submit">
      <Tip label="Back"><button type="button" :class="ICON_BTN" aria-label="Back" :disabled="at <= 0" @click="move(at - 1)"><ArrowLeft class="size-4" /></button></Tip>
      <Tip label="Forward"><button type="button" :class="ICON_BTN" aria-label="Forward" :disabled="at >= history.length - 1" @click="move(at + 1)"><ArrowRight class="size-4" /></button></Tip>
      <Tip label="Reload"><button type="button" :class="ICON_BTN" aria-label="Reload" @click="reloads++"><RotateCw class="size-4" /></button></Tip>
      <input v-model="address" type="text" spellcheck="false" aria-label="Address" placeholder="An address, a port, or a search" :class="INPUT" />
      <Tip label="Open in the system browser">
        <a v-if="current" :href="current" target="_blank" rel="noopener noreferrer" :class="ICON_BTN" aria-label="Open in the system browser"><ExternalLink class="size-4" /></a>
      </Tip>
    </form>
    <div class="relative min-h-0 flex-1 bg-white bg-clip-padding">
      <!-- A server's page loads once it runs: a frame opened while it starts would sit on a refused-connection page. -->
      <iframe v-if="frameSrc && (!proc || proc.status === 'running')" :key="`${frameSrc}#${reloads}`" :src="frameSrc" :title="proc ? `${proc.name} preview` : 'Preview'" class="size-full border-0" referrerpolicy="no-referrer" />
      <div v-if="proc && proc.status !== 'running'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-page)] px-6 text-center" role="status">
        <div class="text-[var(--text-muted)]">{{ proc.name }} is {{ statusWord(proc) }}{{ isUp(proc.status) ? ', opens when it answers' : '' }}.</div>
        <button v-if="!isUp(proc.status)" type="button" :class="TEXT_BTN" :disabled="busy" @click="emit('toggle', proc)"><Play class="size-3" />Start</button>
      </div>
      <button
        v-else-if="frameSrc && proc && daemonUrl"
        type="button"
        class="absolute bottom-2 right-2 flex h-6 items-center rounded-[var(--radius-6)] bg-[var(--bg-popover)] px-2 text-[12px] text-[var(--text)] opacity-80 shadow-(--shadow-menu-ringed) transition-opacity duration-[60ms] hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        :aria-pressed="viaManager"
        @click="viaManager = !viaManager"
      >{{ viaManager ? 'Show directly' : 'Blank? Show through the server manager' }}</button>
    </div>
  </div>
</template>
