<script lang="ts">
import type { DevWebLogLine as Line } from '@shared/devwebui'
import { memo } from './nav'
// Module level, so it outlives a remount (another tab and back): the lines last shown per server id.
const cache = memo<Line[]>()
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDownToLine, Check, Copy, Eraser, Search } from '@lucide/vue'
import type { DevWebLogLine } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { logPage, processLogs } from '../api'
import { matchesFilter } from '../logic'
import { BTN_GHOST, ICON_BTN, ICON_BTN_ON, INPUT } from './kit/kit'
import Segmented from './kit/Segmented.vue'

// The Logs tab of a server: the newest 300 lines from its log on disk, then a poll every ~1.5 s of the service's
// in-memory tail (no disk read) merged in by seq while it is on screen. It follows the bottom until the person scrolls
// up (or turns Follow off), "Load older" pages back from the oldest seq, and Clear only empties this view (the log on
// disk stays). A line without a seq (an outside server's note) is kept once. The tab draws a toolbar, not a heading.
const props = defineProps<{ processId: string }>()
const lines = ref<DevWebLogLine[]>([])
const more = ref(false)
const filter = ref('')
const only = ref<'all' | 'stderr'>('all')
const stick = ref(true)
const box = ref<HTMLElement | null>(null)
const error = ref<string | null>(null)
const copied = ref(false)
/** The first read of this server's log has answered (or a cached copy is shown). */
const loaded = ref(false)
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
  // The first read also asks for the service's in-memory tail, which answers long before the log on disk on a busy PC:
  // its lines show at once, and the page from disk merges in under them.
  if (first)
    void processLogs(props.processId, { start: false })
      .then((tail) => {
        if (g !== gen || !tail.length) return
        lines.value = merge(lines.value, tail).slice(-MAX_LINES)
        loaded.value = true
      })
      .catch(() => {}) // floor-ok: the page from disk still comes
  try {
    const page = first ? await logPage(props.processId, { limit: 300, start: false }) : { lines: await processLogs(props.processId, { start: false }), more: more.value }
    if (g !== gen) return
    if (first) more.value = page.more
    const next = merge(lines.value, page.lines)
    if (next.length > MAX_LINES) more.value = true
    lines.value = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
    cache.set(props.processId, lines.value)
    error.value = null
  } catch (err) {
    if (g === gen) error.value = err instanceof Error ? err.message : String(err)
  }
  if (g !== gen) return
  loaded.value = true
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
  const cached = cache.get(props.processId)
  lines.value = cached ?? []
  loaded.value = !!cached
  clearedTo = 0
  more.value = false
  stick.value = true
  void poll(gen, true)
}
onMounted(start)
watch(() => props.processId, start)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  gen++
  if (timer) clearTimeout(timer)
  if (copiedTimer) clearTimeout(copiedTimer)
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
  cache.set(props.processId, [])
}
// "Errors only" keeps the stderr lines; the word filter applies on top.
const text = computed(() =>
  lines.value.filter((l) => (only.value === 'all' || l.stream === 'stderr') && (!filter.value.trim() || matchesFilter(l.line, filter.value)))
)
const stderrCount = computed(() => text.value.filter((l) => l.stream === 'stderr').length)
async function copy() {
  try {
    await navigator.clipboard.writeText(text.value.map((l) => l.line).join('\n'))
  } catch {
    return // floor-ok: a blocked clipboard copies nothing
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1500)
}
function onScroll() {
  const el = box.value
  if (el) stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}
// Follow on: jump to the newest line and keep following; off: stop following where it is.
async function follow(on: boolean) {
  stick.value = on
  if (!on) return
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}
// The newest shown line, not the count: at the line cap a new line drops the oldest and the count stays the same.
watch(
  () => text.value[text.value.length - 1],
  async () => {
    if (!stick.value) return
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-[160px] max-w-[320px] flex-1">
        <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <input v-model="filter" type="search" :class="[INPUT, 'pl-8']" placeholder="Filter lines" aria-label="Filter log lines" />
      </div>
      <Segmented
        v-model="only"
        label="Which lines"
        :options="[
          { value: 'all', label: 'All' },
          { value: 'stderr', label: 'Errors only' }
        ]"
      />
      <span class="flex-1" />
      <Tip :label="stick ? 'Following new lines' : 'Follow new lines'">
        <button type="button" :class="stick ? ICON_BTN_ON : ICON_BTN" :aria-pressed="stick" aria-label="Follow new lines" @click="follow(!stick)">
          <ArrowDownToLine class="size-3.5" />
        </button>
      </Tip>
      <Tip :label="copied ? 'Copied' : 'Copy the lines shown'">
        <button type="button" :class="ICON_BTN" aria-label="Copy the lines shown" @click="copy">
          <Check v-if="copied" class="size-3.5 text-success-text" />
          <Copy v-else class="size-3.5" />
        </button>
      </Tip>
      <Tip label="Clear this view (the log file is kept)">
        <button type="button" :class="ICON_BTN" aria-label="Clear this view" @click="clear"><Eraser class="size-3.5" /></button>
      </Tip>
    </div>
    <p v-if="error" role="alert" class="text-[12px] text-danger-text">{{ error }}</p>
    <div
      ref="box"
      class="relative h-[min(560px,calc(100vh-290px))] min-h-[240px] overflow-auto rounded-[var(--radius-10)] bg-bg-deepest p-3 font-mono text-[12px] leading-5 shadow-[inset_0_0_0_1px_var(--border)]"
      role="log"
      aria-label="Server log"
      @scroll="onScroll"
    >
      <div v-if="more" class="mb-2 flex justify-center">
        <button type="button" :class="BTN_GHOST" @click="older">Load older</button>
      </div>
      <p v-if="!text.length" class="flex h-full items-center justify-center font-sans text-[13px] text-text-muted">
        {{ lines.length ? 'No line matches.' : loaded ? 'Nothing logged yet.' : 'Reading the log…' }}
      </p>
      <div
        v-for="(l, i) in text"
        :key="l.seq ?? `t${l.ts}-${i}`"
        class="-ml-[10px] border-l-2 pl-2 whitespace-pre-wrap break-all"
        :class="l.stream === 'stderr' ? 'border-danger/60 text-danger-text' : 'border-transparent text-text-2'"
      >{{ l.line }}</div>
    </div>
    <div class="flex flex-wrap items-center gap-x-2 text-[12px] leading-[18px] text-text-muted tnum">
      <span>{{ text.length }} {{ text.length === 1 ? 'line' : 'lines' }} · {{ stderrCount }} from stderr</span>
      <template v-if="!stick">
        <span aria-hidden="true">·</span>
        <span>Scrolled up: new lines are not followed</span>
        <button type="button" class="cursor-default rounded-[var(--radius-6)] px-1 text-text-2 hover:bg-fill-hover hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none" @click="follow(true)">Jump to latest</button>
      </template>
    </div>
  </div>
</template>
