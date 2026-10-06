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

// Browser cards: one saved browser's calls around a command row are one card ("4 calls"), its picture an invented page
// drawn here; a second chat's card has no picture (no full-screen button). The chats have a folder, so the gallery can
// fire BROWSER_CLOSED_EVENT for BROWSER_CWD to show Closed.
const BROWSER_CWD = 'C:/Users/me/example'
const BROWSER_PROFILE = 'company-1f2e3d4c-0000-4000-8000-000000000001'
function inventedPage(): string {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 400
  const g = c.getContext('2d')!
  g.fillStyle = '#f6f7f9'
  g.fillRect(0, 0, 640, 400)
  g.fillStyle = '#1f6feb'
  g.fillRect(0, 0, 640, 52)
  g.fillStyle = '#fff'
  g.font = 'bold 20px sans-serif'
  g.fillText('Example Shop · Orders', 20, 33)
  g.fillStyle = '#222'
  g.font = '15px sans-serif'
  ;['#1042  Blue mug       paid', '#1041  Desk lamp      shipped', '#1040  Notebook set   paid'].forEach((t, i) => {
    g.fillStyle = '#fff'
    g.fillRect(20, 76 + i * 64, 600, 50)
    g.fillStyle = '#222'
    g.fillText(t, 36, 106 + i * 64)
  })
  return c.toDataURL('image/png').split(',')[1]
}
const call = (id: string, tool: string, params: Record<string, unknown>, result: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id, ts: Date.now(), kind: 'tool_use', name: 'mcp__connections__connections_execute', input: { local: true, tool_name: tool, params }, status: 'done', startedAt: Date.now(), result: { text: result, isError: false }, ...extra }) as TranscriptItem
// A ReDesign card: four options of an invented brief. The pictures are /api/redesign/image/gallery-run/option-N.png (served
// by the Desk server from its design-options folder).
const redesignOptions = [1, 2, 3, 4].map((option) => ({ option, name: ['Card stack', 'Minimal list', 'Split panel', 'Hero banner'][option - 1], image: `option-${option}.png` }))
const redesignItems: TranscriptItem[] = [
  { id: 'rdu', ts: Date.now(), kind: 'user', text: 'Make a landing page for the example shop.' },
  {
    id: 'rd1',
    ts: Date.now(),
    kind: 'tool_use',
    name: 'mcp__desk_redesign__design_options',
    input: { brief: 'A landing page for an example shop that sells handmade mugs, with a calm look and one clear call to action.', ask_owner: true },
    status: 'done',
    startedAt: Date.now(),
    result: { text: `The options are shown.
${JSON.stringify({ run: 'gallery-run', options: redesignOptions })}`, isError: false },
  } as TranscriptItem,
]
const redesignBrief = 'A landing page for an example shop that sells handmade mugs, with a calm look and one clear call to action.'
// The same call while it runs (two of four options landed) and after the person asked for more.
const redesignRunning: TranscriptItem[] = [
  { id: 'rdr', ts: Date.now(), kind: 'user', text: 'Make a landing page for the example shop.' },
  { id: 'rd2', ts: Date.now(), kind: 'tool_use', name: 'mcp__desk_redesign__design_options', input: { brief: redesignBrief, ask_owner: true }, status: 'running', startedAt: Date.now(), progress: 'Option 2 of 4 is ready · Card stack · Minimal list' } as TranscriptItem,
]
const redesignMore: TranscriptItem[] = [...redesignItems, { id: 'rdm', ts: Date.now(), kind: 'user', text: 'ReDesign: more options please.' }]
const browserItems: TranscriptItem[] = [
  { id: 'bu', ts: Date.now(), kind: 'user', text: 'Check the shop admin for unpaid orders.' },
  call('bn1', 'browser_navigate', { url: 'https://example.com/admin', profile: BROWSER_PROFILE }, 'Opened https://example.com/admin'),
  call('bn2', 'browser_click', { selector: 'a[href="/admin/orders"]', profile: BROWSER_PROFILE }, 'Clicked Orders'),
  { id: 'bb', ts: Date.now(), kind: 'tool_use', name: 'Bash', input: { command: 'ls exports' }, status: 'done', startedAt: Date.now(), result: { text: 'orders.csv', isError: false } } as TranscriptItem,
  call('bn3', 'browser_get_text', { profile: BROWSER_PROFILE }, '#1042 Blue mug paid\n#1041 Desk lamp shipped\n#1040 Notebook set paid'),
  call('bn4', 'browser_take_screenshot', { url: 'https://example.com/admin/orders', profile: BROWSER_PROFILE }, '[image]', {
    result: { text: '[image]', isError: false, images: [{ mediaType: 'image/png', name: 'orders.png', dataBase64: inventedPage() }] },
  } as Partial<TranscriptItem>),
  { id: 'bt', ts: Date.now(), kind: 'assistant_text', text: 'Every order on the first page is paid or shipped.' },
]
const browserNoShot: TranscriptItem[] = [
  { id: 'cu', ts: Date.now(), kind: 'user', text: 'Open the status page.' },
  call('cn1', 'browser_navigate', { url: 'https://status.example.com/', profile: BROWSER_PROFILE }, 'Opened https://status.example.com/'),
]
const browserChat = { ...transcriptChat, id: 'gallery-browser', cwd: BROWSER_CWD, status: 'idle' } as typeof transcriptChat
const browserChat2 = { ...browserChat, id: 'gallery-browser-2' }

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
      <h3 class="mb-2 text-[13px] text-text-muted">A ReDesign card asking the owner to pick (4 options)</h3>
      <div class="h-[900px] overflow-hidden rounded-lg border border-border" data-gallery-redesign>
        <TranscriptView chat-id="gallery-redesign" :items="redesignItems" :chat="null" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">The same card while it runs, and after More options was sent</h3>
      <div class="h-[560px] overflow-hidden rounded-lg border border-border" data-gallery-redesign-running>
        <TranscriptView chat-id="gallery-redesign-running" :items="redesignRunning" :chat="null" />
      </div>
      <div class="mt-2 h-[900px] overflow-hidden rounded-lg border border-border" data-gallery-redesign-more>
        <TranscriptView chat-id="gallery-redesign-more" :items="redesignMore" :chat="null" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-[13px] text-text-muted">A program's note (an AgentHydra ping), closed</h3>
      <div class="h-[260px] overflow-hidden rounded-lg border border-border" data-gallery-note>
        <TranscriptView chat-id="gallery-note" :items="pingItems" :chat="null" />
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <h3 class="mb-2 text-[13px] text-text-muted">A saved browser's calls in one turn: one Browser card</h3>
        <div class="h-[460px] overflow-hidden rounded-lg border border-border" data-gallery-browser>
          <TranscriptView chat-id="gallery-browser" :items="browserItems" :chat="browserChat" />
        </div>
      </div>
      <div>
        <h3 class="mb-2 text-[13px] text-text-muted">A Browser card with no picture</h3>
        <div class="h-[460px] overflow-hidden rounded-lg border border-border" data-gallery-browser-noshot>
          <TranscriptView chat-id="gallery-browser-2" :items="browserNoShot" :chat="browserChat2" />
        </div>
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
