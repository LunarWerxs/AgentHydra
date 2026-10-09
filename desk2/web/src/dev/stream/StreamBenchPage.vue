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
// A remount as DeskFrame does it: the key changes, so the transcript is made again with another chat and maybe no items yet.
const view = ref({ key: 0, chatId: 'stream-bench', loading: false })
const reply = chunks.join('')
/** Rows of varied height: a short question, a reply of 200 to 3,200 characters (prose and a code fence), and every third turn a tool run. */
function sample(n: number, base: number): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (let i = 0; i < n; i++) {
    const ts = base + i * 4
    out.push({ id: `${base}-u${i}`, ts, kind: 'user', text: `Question ${i}: ${'why does it freeze? '.repeat(1 + ((i * 7) % 9))}` })
    if (i % 3 === 1) out.push({ id: `${base}-t${i}`, ts: ts + 1, kind: 'tool_use', name: 'Bash', input: { command: `npm test -- run ${i}` }, status: 'done', startedAt: ts + 1, endedAt: ts + 2 })
    out.push({ id: `${base}-a${i}`, ts: ts + 3, kind: 'assistant_text', text: reply.slice(0, 200 + ((i * 437) % 3000)) })
  }
  return out
}

;(window as unknown as { __streamBench: unknown }).__streamBench = {
  ready: true,
  total: chunks.length,
  sample,
  mount(chatId: string, list: TranscriptItem[], loading = false) {
    view.value = { key: view.value.key + 1, chatId, loading }
    items.value = list
  },
  arrive(list: TranscriptItem[]) {
    items.value = list
    view.value = { ...view.value, loading: false }
  },
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
    <TranscriptView :key="view.key" :chat-id="view.chatId" :items="items" :loading="view.loading" :chat="chat" read-only />
  </div>
</template>
