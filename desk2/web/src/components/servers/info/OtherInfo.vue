<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Copy, ExternalLink } from '@lucide/vue'
import type { LocalServers } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { localhostServers } from '../api'
import { useDevServers } from '../store'
import { TEXT_BTN } from '../styles'

// A server no project lists: what the machine knows of the port. It is open-only; AgentHydra never starts or stops it.
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
const rows = computed(() => {
  const x = s.value
  return x
    ? ([
        ['Port', String(x.port)],
        ['Address', x.address],
        ['Process id', String(x.pid)],
        ['Program', x.process ?? 'unknown'],
        ['Page title', x.title ?? '–'],
        ['Answers with', x.http === null ? 'no web page' : `HTTP ${x.http}`]
      ] as const)
    : []
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="error" role="alert" class="text-danger-text">{{ error }}</p>
    <p v-else-if="!list" class="text-text-muted">Loading…</p>
    <p v-else-if="!s" class="text-text-muted">Nothing is listening on port {{ port }} any more.</p>
    <template v-else>
      <p class="text-text-2">No project lists this server. AgentHydra did not start it and does not manage it.</p>
      <div class="flex gap-1.5">
        <a :href="s.url" target="_blank" rel="noopener" :class="TEXT_BTN" aria-label="Open in browser"><ExternalLink class="size-3.5" />Open in browser</a>
        <Tip :label="copied ? 'Copied' : 'Copy the address'">
          <button type="button" :class="TEXT_BTN" aria-label="Copy address" @click="copy"><Copy class="size-3.5" />{{ copied ? 'Copied' : 'Copy address' }}</button>
        </Tip>
      </div>
      <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <template v-for="[k, v] in rows" :key="k">
          <dt class="text-text-muted">{{ k }}</dt>
          <dd class="min-w-0 break-words">{{ v }}</dd>
        </template>
      </dl>
    </template>
  </div>
</template>
