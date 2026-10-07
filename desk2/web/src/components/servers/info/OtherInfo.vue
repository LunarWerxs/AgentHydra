<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Check, Copy, Cpu, ExternalLink, Globe, Hash, Loader2, PlugZap } from '@lucide/vue'
import type { LocalServers } from '@shared/devwebui'
import { localhostServers } from '../api'
import { useDevServers } from '../store'
import { BTN, BTN_PRIMARY, CHIP, MONO } from './kit/kit'
import EmptyState from './kit/EmptyState.vue'
import Notice from './kit/Notice.vue'
import StatTile from './kit/StatTile.vue'

// A server no project lists: what the machine knows of the port, as a hero and fact tiles (owner, 2026-10-07: "a nice,
// like, card display", never a table). It is open-only; AgentHydra never starts or stops it.
const props = defineProps<{ port: number }>()
const servers = useDevServers()
const list = shallowRef<LocalServers | null>(null)
const error = ref<string | null>(null)
// The port scan is heavier than the store's poll: at most once per 8 s, but at once for a newly selected port.
let loadedAt = 0
async function load(now = false) {
  if (!now && Date.now() - loadedAt < 8000) return
  loadedAt = Date.now()
  try {
    list.value = await localhostServers()
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
watch(servers.answered, () => void load())
watch(() => props.port, () => void load(true), { immediate: true })
const s = computed(() => list.value?.servers.find((x) => x.port === props.port) ?? null)
const copied = ref(false)
async function copy() {
  if (!s.value) return
  await navigator.clipboard.writeText(s.value.url).catch(() => {}) // floor-ok: a blocked clipboard just copies nothing
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
// "HTTP 200" in success for a 2xx; "No web page" when it did not answer HTTP.
const answer = computed(() => {
  const h = s.value?.http ?? null
  return h === null ? { value: 'No web page', ok: false } : { value: `HTTP ${h}`, ok: h >= 200 && h < 300 }
})
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <Notice v-if="error" tone="danger" title="Could not read the ports on this PC">{{ error }}</Notice>
    <EmptyState v-else-if="!list" :icon="Loader2" title="Loading…" text="Reading what listens on this port." />
    <EmptyState v-else-if="!s" :icon="PlugZap" title="Nothing listening" :text="`Nothing is listening on port ${port} any more.`" />
    <template v-else>
      <section class="flex flex-col gap-2">
        <h2 class="break-words text-[16px] font-semibold leading-6 text-text">{{ s.title ?? `Port ${s.port}` }}</h2>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <a :href="s.url" target="_blank" rel="noopener" :class="MONO" class="min-w-0 truncate text-accent-text hover:underline">{{ s.url }}</a>
          <span :class="CHIP">Not managed by AgentHydra</span>
        </div>
        <p class="text-[12px] leading-[18px] text-text-muted">No project lists this server. AgentHydra did not start it and never starts or stops it.</p>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <a :href="s.url" target="_blank" rel="noopener" :class="BTN_PRIMARY" aria-label="Open in browser"><ExternalLink class="size-3.5" />Open in browser</a>
          <button type="button" :class="BTN" aria-label="Copy address" @click="copy">
            <component :is="copied ? Check : Copy" class="size-3.5" />{{ copied ? 'Copied' : 'Copy address' }}
          </button>
        </div>
      </section>
      <div class="grid grid-cols-2 gap-2.5 @lg:grid-cols-3">
        <StatTile label="Port" :value="String(s.port)" :icon="Hash" />
        <StatTile label="Program" :value="s.process ?? 'unknown'" :sub="`process ${s.pid}`" :icon="Cpu" />
        <StatTile label="Answers with" :value="answer.value" :tone="answer.ok ? 'success' : undefined" :icon="Globe" />
        <StatTile label="Address" :title="s.address">
          <span :class="MONO" class="truncate font-normal">{{ s.address }}</span>
        </StatTile>
      </div>
    </template>
  </div>
</template>
