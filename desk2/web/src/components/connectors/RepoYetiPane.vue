<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ExternalLink, RotateCw, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { ICON_BTN, TEXT_BTN } from '@/components/servers/styles'
import { repoYetiView } from './logic'
import { repoYeti, repoYetiAction, watchRepoYeti } from './repoyeti-state'

// The right pane for RepoYeti (the git app Desk hooks in as a connector): its own page in a frame of its loopback
// address, under a slim header. RepoYeti sends no frame-blocking header, so its page is shown as it is. Not
// running: a Start button; not on this machine: Install, with the install's progress line.
const emit = defineEmits<{ close: [] }>()

const view = computed(() => repoYetiView(repoYeti.value))
const error = ref<string | null>(null)
const pending = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

let stop: (() => void) | null = null
onMounted(() => (stop = watchRepoYeti()))
onBeforeUnmount(() => stop?.())

async function act(action: 'start' | 'install') {
  error.value = null
  pending.value = true
  try {
    await repoYetiAction(action)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    pending.value = false
  }
}

const reload = () => frame.value?.contentWindow?.location.reload()
const openOutside = () => view.value.kind === 'frame' && window.open(view.value.url, '_blank', 'noopener')
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col bg-[var(--bg)]" aria-label="RepoYeti">
    <header class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <span class="flex-1 truncate text-[12px] font-medium text-[var(--text)]">RepoYeti</span>
      <template v-if="view.kind === 'frame'">
        <Tip label="Reload">
          <button type="button" :class="ICON_BTN" aria-label="Reload RepoYeti" @click="reload"><RotateCw class="size-3.5" /></button>
        </Tip>
        <Tip label="Open in its own window">
          <button type="button" :class="ICON_BTN" aria-label="Open RepoYeti in its own window" @click="openOutside"><ExternalLink class="size-3.5" /></button>
        </Tip>
      </template>
      <Tip label="Close">
        <button type="button" :class="ICON_BTN" aria-label="Close RepoYeti" @click="emit('close')"><X class="size-3.5" /></button>
      </Tip>
    </header>

    <iframe v-if="view.kind === 'frame'" ref="frame" :src="view.url" title="RepoYeti" class="min-h-0 w-full flex-1 border-0 bg-white" />

    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[12px] text-[var(--text-2)]">
      <template v-if="view.kind === 'loading'"><p>Looking for RepoYeti</p></template>
      <template v-else-if="view.kind === 'start'">
        <p>RepoYeti is installed and not running.</p>
        <button type="button" :class="TEXT_BTN" :disabled="pending" @click="act('start')">Start RepoYeti</button>
      </template>
      <template v-else-if="view.kind === 'install'">
        <p>RepoYeti is not on this machine.</p>
        <button type="button" :class="TEXT_BTN" :disabled="pending" @click="act('install')">Install RepoYeti</button>
      </template>
      <template v-else-if="view.kind === 'busy'"><p role="status">{{ view.line }}</p></template>
      <template v-else>
        <p class="text-[var(--danger-text)]">{{ view.reason }}</p>
        <button type="button" :class="TEXT_BTN" :disabled="pending" @click="act('start')">Try again</button>
      </template>
      <p v-if="error" role="alert" class="text-[var(--danger-text)]">{{ error }}</p>
    </div>
  </section>
</template>
