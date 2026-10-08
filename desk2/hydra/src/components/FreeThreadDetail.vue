<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Copy, RefreshCw, Send, ShieldCheck } from '@lucide/vue'
import type { FreeMessage, FreeResult } from '@desk/shared/free-instances'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useFreeInstances } from '@/composables/useFreeInstances'

const props = defineProps<{ instanceId: string; chatId?: string }>()
const emit = defineEmits<{ identified: [id: string] }>()
const { instances, threads, jobs, errors, busy, run, recover } = useFreeInstances()
const instance = computed(() => instances.value.find(i => i.id === props.instanceId))
const currentId = ref(props.chatId ?? '')
const name = ref('')
const prompt = ref('')
const webSearch = ref(false)
const messages = ref<FreeMessage[]>([])
const incomplete = ref(false)
const warnings = ref<string[]>([])
const confirmed = ref(false)
const reading = ref(false)
const attemptedRead = ref(false)
const trackId = ref('')
const trackName = ref('')
const thread = computed(() => threads.value.find(t => t.instanceId === props.instanceId && t.chatId === currentId.value))
const blocked = computed(() => busy(props.instanceId))
const validTrack = computed(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trackId.value.trim()) && trackName.value.trim())

function apply(result: FreeResult | null, sent?: string) {
  const id = result?.chat_id ?? result?.error?.chat_id
  if (id) { currentId.value = id; emit('identified', id) }
  if (!result?.ok) return
  if (result.is_temporary === true) confirmed.value = true
  if (result.messages) {
    if (sent && result.messages.every(m => m.role === 'assistant')) messages.value.push({ id: crypto.randomUUID(), role: 'user', text: sent, code_blocks: [], citations: [] }, ...result.messages)
    else messages.value = result.messages
  }
  incomplete.value = result.incomplete ?? false
  warnings.value = result.warnings ?? []
}
async function read() {
  if (!instance.value || !currentId.value || blocked.value || reading.value) return
  attemptedRead.value = true
  reading.value = true
  try { apply(await run(instance.value, 'read', { chatId: currentId.value })) }
  finally { reading.value = false }
}
async function send() {
  if (!instance.value || blocked.value || !prompt.value.trim() || (currentId.value && !confirmed.value)) return
  const sent = prompt.value
  const result = await run(instance.value, currentId.value ? 'resume' : 'chat', { prompt: sent,
    ...(currentId.value ? { chatId: currentId.value } : name.value.trim() ? { name: name.value.trim() } : {}),
    ...(instance.value.provider === 'claude' ? { webSearch: webSearch.value } : {}) })
  apply(result, sent)
  if (result?.ok && prompt.value === sent) prompt.value = ''
}
async function track() {
  if (!instance.value || !validTrack.value || blocked.value) return
  apply(await run(instance.value, 'track', { chatId: trackId.value.trim(), name: trackName.value.trim() }))
  await read()
}
async function checkOperation() { apply(await recover(props.instanceId)); await read() }
async function copy(value: string) { await navigator.clipboard.writeText(value).catch(() => {}) }
// Reads are safe to repeat when an account finishes another operation; sends are never replayed.
watch([instance, blocked], () => { if (currentId.value && !attemptedRead.value && !blocked.value) void read() }, { immediate: true })
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border bg-card p-3">
    <template v-if="instance">
      <header class="flex shrink-0 flex-wrap items-center gap-2">
        <ShieldCheck class="size-4 text-muted-foreground" />
        <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ $pii(thread?.title || instance.name) }}</h3>
        <span class="text-xs text-muted-foreground">{{ $t(instance.provider === 'claude' ? 'freeInstances.incognito' : 'freeInstances.temporary') }}</span>
        <Button v-if="currentId" size="sm" variant="outline" :disabled="blocked" @click="read"><RefreshCw :class="reading ? 'animate-spin' : ''" />{{ $t('freeInstances.read') }}</Button>
      </header>
      <div v-if="currentId" class="flex shrink-0 flex-col gap-1 text-2xs text-muted-foreground">
        <div class="flex min-w-0 items-center gap-2"><span>{{ $t('freeInstances.uuid') }}</span><code class="break-all select-all">{{ currentId }}</code><Button size="icon-sm" variant="ghost" :aria-label="$t('freeInstances.copy')" @click="copy(currentId)"><Copy /></Button></div>
        <div v-if="thread?.serverId && thread.serverId !== currentId" class="flex min-w-0 items-center gap-2"><span>{{ $t('freeInstances.serverUuid') }}</span><code class="break-all select-all">{{ thread.serverId }}</code><Button size="icon-sm" variant="ghost" :aria-label="$t('freeInstances.copy')" @click="copy(thread.serverId)"><Copy /></Button></div>
      </div>
      <div v-if="!currentId" class="shrink-0"><Input v-model="name" maxlength="100" :placeholder="$t('freeInstances.name')" :aria-label="$t('freeInstances.name')" /></div>
      <div class="scroll-slim flex min-h-24 flex-1 flex-col gap-3 overflow-y-auto" aria-live="polite" :aria-busy="blocked">
        <p v-if="!messages.length" class="py-6 text-center text-xs text-muted-foreground">{{ $t(blocked ? 'freeInstances.working' : 'freeInstances.empty') }}</p>
        <article v-for="(message, index) in messages" :key="message.id || index" class="flex flex-col gap-1.5 rounded-md border p-3">
          <span class="text-2xs font-medium text-muted-foreground">{{ $t(message.role === 'user' ? 'freeInstances.user' : 'freeInstances.assistant') }}</span>
          <pre class="whitespace-pre-wrap wrap-break-word font-sans text-sm">{{ message.text }}</pre>
          <details v-if="message.code_blocks.length" class="mt-1"><summary class="cursor-pointer text-xs text-muted-foreground">{{ $t('freeInstances.code') }}</summary>
            <div v-for="(block, i) in message.code_blocks" :key="i" class="mt-2 rounded-md bg-muted p-2">
              <div class="flex items-center justify-between text-2xs"><span>{{ block.language }}</span><Button size="icon-sm" variant="ghost" :aria-label="$t('freeInstances.copyCode')" @click="copy(block.code)"><Copy /></Button></div>
              <pre class="scroll-slim overflow-x-auto text-xs"><code>{{ block.code }}</code></pre>
            </div>
          </details>
          <div v-if="message.citations.length" class="flex flex-wrap gap-2 text-xs"><span class="text-muted-foreground">{{ $t('freeInstances.sources') }}</span><a v-for="source in message.citations" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ source.title }}</a></div>
        </article>
      </div>
      <p v-if="incomplete" role="status" class="text-xs text-warning">{{ $t('freeInstances.incomplete') }}</p>
      <p v-for="warning in warnings" :key="warning" class="text-xs text-warning">{{ warning }}</p>
      <div v-if="errors[instanceId]" role="alert" class="flex shrink-0 items-center gap-2 text-xs text-destructive"><span>{{ errors[instanceId] }}</span><Button v-if="blocked" size="xs" variant="outline" @click="checkOperation">{{ $t('freeInstances.recover') }}</Button></div>
      <form class="flex shrink-0 flex-col gap-2" @submit.prevent="send">
        <label class="sr-only" :for="`free-prompt-${instanceId}`">{{ $t('freeInstances.prompt') }}</label>
        <Textarea :id="`free-prompt-${instanceId}`" v-model="prompt" :disabled="blocked" :placeholder="$t('freeInstances.promptHint')" maxlength="100000" class="min-h-20" @keydown.ctrl.enter.prevent="send" />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <label v-if="instance.provider === 'claude'" class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="webSearch" type="checkbox" :disabled="blocked" />{{ $t('freeInstances.webSearch') }}</label>
          <span class="text-2xs text-muted-foreground" :title="$t('freeInstances.historyHint')">{{ $t('freeInstances.privateHint') }}</span>
          <Button type="submit" size="sm" :disabled="blocked || !prompt.trim() || (!!currentId && !confirmed)"><Send />{{ $t('freeInstances.send') }}</Button>
        </div>
      </form>
      <details v-if="!currentId" class="shrink-0 text-xs text-muted-foreground"><summary class="cursor-pointer">{{ $t('freeInstances.track') }}</summary>
        <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="track"><Input v-model="trackId" class="min-w-64 flex-1" :placeholder="$t('freeInstances.uuid')" :aria-label="$t('freeInstances.uuid')" /><Input v-model="trackName" class="flex-1" :placeholder="$t('freeInstances.trackName')" :aria-label="$t('freeInstances.trackName')" /><Button size="sm" variant="outline" :disabled="blocked || !validTrack">{{ $t('freeInstances.trackAction') }}</Button></form>
      </details>
    </template>
    <p v-else role="alert" class="text-xs text-destructive">{{ $t('freeInstances.accountMissing') }}</p>
  </section>
</template>
