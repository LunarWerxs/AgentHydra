<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Copy, Eraser } from '@lucide/vue'
import type { DevWebLogLine } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { logPage, processLogs } from '../api'
import { matchesFilter } from '../logic'
import { ICON_BTN, INPUT } from '../styles'

// A server's log: the newest 300 lines from its log on disk, then a poll every ~1.5 s of the service's in-memory tail (no
// disk read) merged in by seq while the pane is open. It sticks to the bottom until the person scrolls up, "Load older"
// pages back from the oldest seq, and Clear only empties this view (the log on disk stays). A line without a seq (an
// outside server's note) is kept once.
const props = defineProps<{ processId: string }>()
const lines = ref<DevWebLogLine[]>([])
const more = ref(false)
const filter = ref('')
const stick = ref(true)
const box = ref<HTMLElement | null>(null)
const error = ref<string | null>(null)
// Lines at or before this seq were cleared from the view.
let clearedTo = 0

const keyOf = (l: DevWebLogLine): string => (l.seq !== undefined ? `#${l.seq}` : `${l.ts}:${l.stream}:${l.line}`)
function merge(into: DevWebLogLine[], add: DevWebLogLine[]): DevWebLogLine[] {
  const seen = new Set(into.map(keyOf))
  const fresh = add.filter((l) => !seen.has(keyOf(l)) && (l.seq === undefined || l.seq > clearedTo))
  return [...into, ...fresh].sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.ts - b.ts))
}

// The view keeps the newest MAX_LINES; trimmed lines stay on disk and Load older fetches them again.
const MAX_LINES = 2000
let timer: ReturnType<typeof setTimeout> | null = null
let gen = 0
// A hidden window schedules no poll; the loop waits here until the window is shown again.
let paused = false
async function poll(g: number, first: boolean) {
  try {
    const page = first ? await logPage(props.processId, { limit: 300, start: false }) : { lines: await processLogs(props.processId, { start: false }), more: more.value }
    if (g !== gen) return
    if (first) more.value = page.more
    const next = merge(lines.value, page.lines)
    if (next.length > MAX_LINES) more.value = true
    lines.value = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
    error.value = null
  } catch (err) {
    if (g === gen) error.value = err instanceof Error ? err.message : String(err)
  }
  if (g !== gen) return
  if (document.hidden) paused = true
  else timer = setTimeout(() => void poll(g, false), 1500)
}
function onVisibility() {
  if (document.hidden || !paused) return
  paused = false
  void poll(gen, false)
}
document.addEventListener('visibilitychange', onVisibility)
function start() {
  gen++
  if (timer) clearTimeout(timer)
  paused = false
  lines.value = []
  clearedTo = 0
  more.value = false
  stick.value = true
  void poll(gen, true)
}
onMounted(start)
watch(() => props.processId, start)
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  gen++
  if (timer) clearTimeout(timer)
})

async function older() {
  const first = lines.value.find((l) => l.seq !== undefined)
  if (!first) return
  try {
    const page = await logPage(props.processId, { before: first.seq, limit: 300, start: false })
    const el = box.value
    const h = el?.scrollHeight ?? 0
    more.value = page.more
    lines.value = merge(lines.value, page.lines)
    await nextTick()
    if (el) el.scrollTop += el.scrollHeight - h
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
function clear() {
  clearedTo = Math.max(0, ...lines.value.map((l) => l.seq ?? 0))
  lines.value = []
  more.value = false
}
const text = computed(() => lines.value.filter((l) => !filter.value.trim() || matchesFilter(l.line, filter.value)))
async function copy() {
  await navigator.clipboard.writeText(text.value.map((l) => l.line).join('\n')).catch(() => {}) // floor-ok: a blocked clipboard copies nothing
}
function onScroll() {
  const el = box.value
  if (el) stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}
watch(
  () => text.value.length,
  async () => {
    if (!stick.value) return
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-1">
      <h3 class="text-[12px] font-medium text-text-2">Logs</h3>
      <span class="flex-1" />
      <input v-model="filter" type="search" :class="[INPUT, 'max-w-[160px] flex-none']" placeholder="Filter lines" aria-label="Filter log lines" />
      <Tip label="Copy the lines shown">
        <button type="button" :class="ICON_BTN" aria-label="Copy the lines shown" @click="copy"><Copy class="size-3.5" /></button>
      </Tip>
      <Tip label="Clear this view (the log file is kept)">
        <button type="button" :class="ICON_BTN" aria-label="Clear this view" @click="clear"><Eraser class="size-3.5" /></button>
      </Tip>
    </div>
    <p v-if="error" role="alert" class="text-[12px] text-danger-text">{{ error }}</p>
    <div ref="box" class="max-h-[320px] min-h-[120px] overflow-auto rounded-[var(--radius-6)] bg-[var(--fill-secondary)] p-2 font-mono text-[11px] leading-4" role="log" aria-label="Server log" @scroll="onScroll">
      <button v-if="more" type="button" class="mb-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="older">Load older</button>
      <p v-if="!text.length" class="text-text-muted">{{ lines.length ? 'No line matches.' : 'Nothing logged yet.' }}</p>
      <div v-for="(l, i) in text" :key="l.seq ?? `t${l.ts}-${i}`" class="whitespace-pre-wrap break-all" :class="l.stream === 'stderr' ? 'text-danger-text' : 'text-text-2'">{{ l.line }}</div>
    </div>
  </div>
</template>
