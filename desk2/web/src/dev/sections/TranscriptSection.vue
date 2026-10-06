<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import { transcriptFixtures, chatFixtures } from '../fixtures'
import { makeStressItems, transcriptChat, transcriptStates } from '@/components/transcript/fixtures'
import { markdownGalleryItems } from '@/dev/parity/markdown'

// Finished work in one box (no Working row), the open cards and the running turn in another.
const split = transcriptStates.findIndex((i) => i.id === 'u2')
const finished = transcriptStates.slice(0, split)
const live = transcriptStates.slice(split)
// Tool runs fold into one status row with id `tools:<first id>`; the ids after it open rows inside it.
const open = ['th1', 'tools:r1', 'r1', 'b-ok', 'b-err', 'cm1', 'mcp1', 'tw1', 'plan-done']
const markdownItems = markdownGalleryItems()
// An AgentHydra ping as its note card: one closed line, the whole text under Show more.
const pingItems: TranscriptItem[] = [
  { id: 'gu', ts: Date.now() - 120_000, kind: 'user', text: 'Send the docs and the events fix to CliMayte.' },
  { id: 'ga', ts: Date.now() - 110_000, kind: 'assistant_text', text: 'Both are dispatched.' },
  {
    id: 'gn',
    ts: Date.now(),
    kind: 'note',
    from: 'AgentHydra · CliMayte',
    text: 'Ping 3-4, 2 updates since 09:00:\n• w-1a2b3c4d "Docs": done on #84, check passed.\n• w-5e6f7a8b "Fix events rows": done on #102, needs your verdict.\nGroup g-1f2e3d: 2 done, 0 failed, 1 running, 0 waiting.\nNext: climayte_status {group:"g-1f2e3d", report:true}, then climayte_verdict.',
  },
  { id: 'gr', ts: Date.now(), kind: 'assistant_text', text: 'Two results are in and one task still runs.' },
]

// The windowing check: 3,000 items, mount time, rows in the DOM, cost of each scroll step.
const STRESS_N = 3000
const stressItems = ref<ReturnType<typeof makeStressItems>>([])
const stressBox = ref<HTMLElement | null>(null)
const stats = ref<string>('measuring…')

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

onMounted(async () => {
  const tBuild = performance.now()
  const items = makeStressItems(STRESS_N)
  const buildMs = performance.now() - tBuild
  const t0 = performance.now()
  stressItems.value = items
  await nextTick()
  const box = stressBox.value!
  const el = box.querySelector<HTMLElement>('[data-transcript-scroller]')!
  void el.scrollHeight // force layout
  const mountMs = performance.now() - t0
  await frame()
  await frame()
  const domRows = box.querySelectorAll('[data-id]').length

  // Sweep bottom -> top in 150 steps; each step: scroll, Vue update, layout.
  const steps: number[] = []
  let maxRows = domRows
  const total = el.scrollHeight
  for (let k = 0; k <= 150; k++) {
    const y = total - (total * k) / 150
    const s = performance.now()
    el.scrollTop = y
    el.dispatchEvent(new Event('scroll'))
    await nextTick()
    void el.scrollHeight
    steps.push(performance.now() - s)
    maxRows = Math.max(maxRows, box.querySelectorAll('[data-id]').length)
    await frame()
  }
  steps.sort((a, b) => a - b)
  const avg = steps.reduce((a, b) => a + b, 0) / steps.length
  const p95 = steps[Math.floor(steps.length * 0.95)]
  const max = steps[steps.length - 1]
  stats.value =
    `${STRESS_N} items · fixture ${buildMs.toFixed(1)}ms · mount+layout ${mountMs.toFixed(1)}ms · ` +
    `rows in DOM ${domRows} (max ${maxRows} while scrolling) · scroll step avg ${avg.toFixed(2)}ms, ` +
    `p95 ${p95.toFixed(2)}ms, max ${max.toFixed(2)}ms over ${steps.length} steps · content ${Math.round(total)}px`
  console.log('[transcript-stress]', stats.value)
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">A program's note (an AgentHydra ping), closed</h3>
      <div class="h-[260px] overflow-hidden rounded-lg border border-border" data-gallery-note>
        <TranscriptView chat-id="gallery-note" :items="pingItems" :chat="null" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">Every row, finished turn (some rows opened)</h3>
      <div class="h-[1900px] overflow-hidden rounded-lg border border-border">
        <TranscriptView chat-id="gallery-done" :items="finished" :chat="null" :expanded-ids="open" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">Pending cards, streaming, Working row</h3>
      <div class="h-[1150px] overflow-hidden rounded-lg border border-border">
        <TranscriptView chat-id="gallery-transcript" :items="live" :chat="transcriptChat" />
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <h3 class="mb-2 text-[13px] text-text-muted">Shell fixtures, read-only (buttons hidden)</h3>
        <div class="h-[520px] overflow-hidden rounded-lg border border-border">
          <TranscriptView chat-id="gallery-readonly" :items="transcriptFixtures" :chat="chatFixtures[1]" read-only />
        </div>
      </div>
      <div>
        <h3 class="mb-2 text-[13px] text-text-muted">Windowed: {{ STRESS_N }} items</h3>
        <div ref="stressBox" class="h-[520px] overflow-hidden rounded-lg border border-border">
          <TranscriptView chat-id="gallery-stress" :items="stressItems" :chat="null" />
        </div>
        <p class="mt-2 font-mono text-[11px] text-text-muted" data-stress-stats>{{ stats }}</p>
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">Markdown and code, pictures, files and background tasks (one place to check the look)</h3>
      <div class="h-[2600px] overflow-hidden rounded-lg border border-border" data-gallery-markdown>
        <TranscriptView chat-id="gallery-markdown" :items="markdownItems" :chat="null" />
      </div>
    </div>
  </div>
</template>
