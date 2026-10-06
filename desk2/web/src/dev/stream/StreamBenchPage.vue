<script setup lang="ts">
import { nextTick, ref } from 'vue'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import { chatFixtures } from '@/dev/fixtures'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { streamChunks } from './fixture'

// '#/stream-bench': the transcript alone with one streaming assistant reply. window.__streamBench =
// { ready, total, push(), grow() } for e2e/stream-frames.e2e.ts: push() appends the next chunk, as an item.delta would,
// and resolves after Vue has patched the DOM; it returns false when the reply is complete. grow() (e2e/scroll-follow.e2e.ts)
// never runs out: past the end of a reply it adds a new question and starts the reply again as new items.
const chunks = streamChunks()
const chat: ChatSummary = { ...chatFixtures[0]!, id: 'stream-bench', status: 'idle' }
const t0 = Date.parse('2026-01-01T00:00:00Z')
const items = ref<TranscriptItem[]>([
  { id: 'u1', ts: t0, kind: 'user', text: 'Why does a refresh freeze the window, and how do I fix it?' },
  { id: 'a1', ts: t0 + 1, kind: 'assistant_text', text: '', streaming: true },
])
let next = 0

;(window as unknown as { __streamBench: unknown }).__streamBench = {
  ready: true,
  total: chunks.length,
  async push() {
    if (next >= chunks.length) return false
    const cur = items.value[1] as TranscriptItem & { kind: 'assistant_text' }
    items.value = [items.value[0]!, { ...cur, text: cur.text + chunks[next++], streaming: next < chunks.length }]
    await nextTick()
    return true
  },
  async grow() {
    if (next >= chunks.length) {
      next = 0
      const n = items.value.length
      const ts = t0 + n
      items.value = [...items.value, { id: `u${n}`, ts, kind: 'user', text: 'And the next one?' }, { id: `a${n}`, ts: ts + 1, kind: 'assistant_text', text: '', streaming: true }]
    }
    const last = items.value.length - 1
    const cur = items.value[last] as TranscriptItem & { kind: 'assistant_text' }
    items.value = [...items.value.slice(0, last), { ...cur, text: cur.text + chunks[next++], streaming: next < chunks.length }]
    await nextTick()
    return true
  },
}
</script>

<template>
  <div style="height: 100vh; width: 100vw; display: flex; flex-direction: column">
    <TranscriptView chat-id="stream-bench" :items="items" :chat="chat" read-only />
  </div>
</template>
