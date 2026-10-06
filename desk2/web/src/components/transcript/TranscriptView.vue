<script setup lang="ts">
// The transcript: a windowed list (only the rows near the viewport are in the DOM, so a 3,000-item
// chat scrolls smoothly), auto-scroll that lets go when Jacob scrolls up (a send, the jump button or
// scrolling back down takes it back to the bottom), and a Working row under the last item while the
// chat's turn runs.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch, type Directive } from 'vue'
import { icons } from '@/lib/icons'

const ArrowDown = icons.scrollToBottom
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { buildRows, estimateHeight } from './lib/rows'
import { groupRows, rowGap, type DisplayRow } from './lib/groups'
import { prefixOffsets, rowAt, visibleRange } from './lib/window'
import { provideTranscript } from './context'
import TranscriptRow from './TranscriptRow.vue'
import WorkingFooter from './parts/WorkingFooter.vue'
import ToolGroup from './parts/ToolGroup.vue'
import TaskGroup from './parts/TaskGroup.vue'
import RunningTasksRow from '@/components/tasks/RunningTasksRow.vue'
import { CHAT_SENT_EVENT, sentHere, type ChatSentDetail } from '@/components/composer/api'
import './transcript.css'

const props = defineProps<{
  chatId: string
  items: TranscriptItem[]
  readOnly?: boolean
  /** The chat whose Working row is shown; defaults to the store's chat with chatId. */
  chat?: ChatSummary | null
  /** Rows or sections to start open (the Gallery uses it to show expanded states). */
  expandedIds?: string[]
  /** Hydra Desk 2's session header Find: every match marked, the active one (an item and which match in it) scrolled to. */
  find?: { query: string; active: { itemId: string; nth: number } | null } | null
  /** Tighter gaps between rows (the session header's Compact layout). */
  compact?: boolean
  /** How much of the top something lying over the transcript covers (Hydra Desk 2's session header): the first row starts below it. */
  insetTop?: number
  /** The history is not loaded yet; with `loadError`, the last try at it failed and another is coming. */
  loading?: boolean
  loadError?: string | null
}>()

const desk = useDesk()
const chat = computed<ChatSummary | null>(() =>
  props.chat !== undefined ? props.chat : ((desk.chats.value as ChatSummary[]).find((c) => c.id === props.chatId) ?? null),
)
const rows = computed(() => buildRows(props.items))
// What is laid out: tool runs folded into status rows, end-of-turn replies marked.
const display = computed(() => groupRows(rows.value.top))

provideTranscript(
  {
    chatId: toRef(props, 'chatId'),
    readOnly: computed(() => !!props.readOnly),
    cwd: computed(() => chat.value?.cwd ?? null),
    children: computed(() => rows.value.children),
    background: computed(() => ({
      count: chat.value?.climayteActive ?? 0,
      resultId: props.items.findLast((i) => i.kind === 'result' && !i.parentToolUseId)?.id ?? null,
    })),
  },
  props.expandedIds,
)

const showWorking = computed(() => !!chat.value && ['working', 'starting', 'needs_you'].includes(chat.value.status))
/** What an empty transcript says: an unloaded one never claims to have no messages. */
const emptyText = computed(() => {
  if (!props.loading) return 'No messages yet'
  return props.loadError ? `Could not load this chat's messages: ${props.loadError.replace(/\.$/, '')}. Trying again…` : 'Loading messages…'
})

// Windowing: measured heights by item id, estimates until measured.
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewHeight = ref(800)
const heights = new Map<string, number>()
const version = ref(0)

const indexById = computed(() => new Map(display.value.map((r, i) => [r.id, i])))
// Gaps and row heights together, once per change of the rows: a re-measure then only updates its own row's
// height and adds the heights up again.
const layout = computed(() => {
  const top = display.value
  const gaps: number[] = new Array(top.length)
  const h = new Float64Array(top.length)
  for (let i = 0; i < top.length; i++) {
    gaps[i] = props.compact ? Math.round(rowGap(top, i) * 0.4) : rowGap(top, i)
    h[i] = heights.get(top[i].id) ?? estimateRow(top[i]) + gaps[i]
  }
  return { gaps, h }
})
const gaps = computed(() => layout.value.gaps)
const offsets = computed(() => {
  void version.value
  return prefixOffsets(layout.value.h)
})
const range = computed(() => visibleRange(offsets.value, scrollTop.value, viewHeight.value, 800))
const visible = computed(() =>
  display.value.slice(range.value.start, range.value.end).map((r, k) => ({ r, gap: gaps.value[range.value.start + k] })),
)
const padTop = computed(() => offsets.value[range.value.start] ?? 0)
const padBottom = computed(() => {
  const o = offsets.value
  return Math.max(0, o[o.length - 1] - (o[range.value.end] ?? 0))
})

/** A first guess at a row's height until it is measured; messages add their 28px actions toolbar. */
function estimateRow(r: DisplayRow): number {
  if (r.kind === 'tools' || r.kind === 'tasks') return 24
  const it = r.item
  return estimateHeight(it) + (it.kind === 'user' || r.endOfTurn ? 28 : 0)
}

// Auto-scroll: pinned to the bottom until Jacob scrolls up by any means (wheel, touchpad, scrollbar, keys); only
// scrolling back down to the bottom, the jump button or a send re-pins. A reply growing never pulls him down.
const pinned = ref(true)
let lastTop = 0
/** How far the bottom is below the screen, for the jump button. */
const fromBottom = ref(0)
/** The jump button (WhatsApp's down arrow, bottom right) shows once he is more than half a screen up, never for a few lines. */
const showJump = computed(() => !pinned.value && fromBottom.value > Math.max(200, viewHeight.value / 2))

const distanceOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

function scrollToBottom() {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
  lastTop = el.scrollTop
  fromBottom.value = 0
}

/** Keeps a pinned transcript at its bottom. A scroll up that onScroll has not seen yet (a scrollbar drag or a key in
 *  the same frame as a streamed line) lets go here instead of being overwritten. */
function follow() {
  const el = scroller.value
  if (!el || !pinned.value) return
  if (el.scrollTop < lastTop - 1 && distanceOf(el) > 1) return onScroll()
  scrollToBottom()
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  const top = el.scrollTop
  const distance = distanceOf(el)
  // Any move up lets go, however small (the browser clamping a shrunk list at the very bottom is not a move); only a
  // move down to within 24px of the bottom takes hold again.
  const up = top < lastTop - 1
  if (up && distance > 1) pinned.value = false
  else if (!up && distance <= 24) pinned.value = true
  lastTop = top
  scrollTop.value = top
  fromBottom.value = distance
}

function onWheel(e: WheelEvent) {
  if (e.deltaY < 0) pinned.value = false
}

function jumpToLatest() {
  pinned.value = true
  scrollToBottom()
  // Rows near the bottom get measured after this render; follow them down.
  requestAnimationFrame(follow)
}

// Sending from this chat's composer goes to the bottom, even scrolled up, and stays pinned for the reply.
function onSent(e: Event) {
  if (sentHere((e as CustomEvent<ChatSentDetail>).detail, props.chatId)) jumpToLatest()
}

let rowObserver: ResizeObserver | null = null
let viewObserver: ResizeObserver | null = null

// A row's height includes its gap (padding-bottom), which changes when a row is appended under it: watch the border box.
const vMeasure: Directive<HTMLElement> = {
  mounted: (el) => rowObserver?.observe(el, { box: 'border-box' }),
  beforeUnmount: (el) => rowObserver?.unobserve(el),
}

onMounted(() => {
  rowObserver = new ResizeObserver((entries) => {
    const el = scroller.value
    let changed = false
    let anchorDelta = 0
    const o = offsets.value
    const firstOnScreen = el ? rowAt(o, el.scrollTop) : 0
    for (const e of entries) {
      const target = e.target as HTMLElement
      const id = target.dataset.id
      if (!id) continue
      const h = e.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight
      const idx = indexById.value.get(id)
      if (idx === undefined) continue
      const old = o[idx + 1] - o[idx]
      if (Math.abs(h - old) < 0.5 && heights.has(id)) continue
      heights.set(id, h)
      layout.value.h[idx] = h
      changed = true
      // A row above the viewport changed size: keep what Jacob is reading where it is.
      if (!pinned.value && idx < firstOnScreen) anchorDelta += h - old
    }
    if (!changed) return
    version.value++
    if (el && anchorDelta) {
      el.scrollTop += anchorDelta
      lastTop = el.scrollTop
      scrollTop.value = el.scrollTop
    }
  })
  viewObserver = new ResizeObserver(() => {
    if (!scroller.value) return
    viewHeight.value = scroller.value.clientHeight
    follow()
  })
  if (scroller.value) {
    viewObserver.observe(scroller.value)
    viewHeight.value = scroller.value.clientHeight
  }
  // The rows mounted before the observer existed.
  scroller.value?.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => rowObserver!.observe(el, { box: 'border-box' }))
  scrollToBottom()
  window.addEventListener(CHAT_SENT_EVENT, onSent)
})

onBeforeUnmount(() => {
  window.removeEventListener(CHAT_SENT_EVENT, onSent)
  rowObserver?.disconnect()
  viewObserver?.disconnect()
  clearFind()
})

// Follow new items, streaming growth and re-measured rows while pinned; scrolled up, they only tell the jump button how far down the bottom is.
watch(
  [offsets, showWorking, () => props.items[props.items.length - 1]],
  () => {
    if (pinned.value) return void nextTick(follow)
    if (scroller.value) fromBottom.value = distanceOf(scroller.value)
  },
  { flush: 'post' },
)

// Find: the matches in the rows on screen are marked with the CSS Custom Highlight API, so no row
// renders again; marked again as rows come into view. The active match's row is scrolled to first (it
// may not be in the DOM yet), then the match itself, a third of the way down.
const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
let activeRange: Range | null = null
function clearFind() {
  highlights?.delete('desk-find')
  highlights?.delete('desk-find-active')
  activeRange = null
}
function paintFind() {
  clearFind()
  const q = props.find?.query.trim().toLowerCase()
  const el = scroller.value
  if (!highlights || !q || !el) return
  const act = props.find?.active ?? null
  const all: Range[] = []
  for (const row of el.querySelectorAll<HTMLElement>('[data-id]')) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let nth = 0
    let first: Range | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue?.toLowerCase() ?? ''
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
        const r = new Range()
        r.setStart(n, at)
        r.setEnd(n, at + q.length)
        all.push(r)
        first ??= r
        if (act && row.dataset.id === act.itemId && nth === act.nth) activeRange = r
        nth++
      }
    }
    // The rendered text can count differently from the item's own (markdown): its first match stands in.
    if (act && row.dataset.id === act.itemId && !activeRange) activeRange = first
  }
  if (all.length) highlights.set('desk-find', new Highlight(...all))
  if (activeRange) highlights.set('desk-find-active', new Highlight(activeRange))
}
function revealActive() {
  const el = scroller.value
  if (!el || !activeRange) return
  const box = activeRange.getBoundingClientRect()
  const view = el.getBoundingClientRect()
  // The session header and its Find bar lie over the top: a match under them is not in view.
  const inset = props.insetTop ?? 0
  const top = view.top + inset
  if (box.top >= top + 48 && box.bottom <= view.bottom - 48) return
  el.scrollTop += box.top - top - (el.clientHeight - inset) / 3
  scrollTop.value = lastTop = el.scrollTop
}
// Keyed by value: the header hands a fresh object whenever the items poll in, and that must not scroll.
const activeKey = computed(() => (props.find?.active ? `${props.find.active.nth}:${props.find.active.itemId}` : ''))
watch(activeKey, () => {
  const act = props.find?.active
  const el = scroller.value
  const idx = act ? indexById.value.get(act.itemId) : undefined
  if (!el || idx === undefined) return
  pinned.value = false
  el.scrollTop = Math.max(0, offsets.value[idx] - el.clientHeight / 3)
  scrollTop.value = lastTop = el.scrollTop
  nextTick(() =>
    requestAnimationFrame(() => {
      paintFind()
      revealActive()
    }),
  )
})
// Without a query there is nothing to mark, so the rows scrolling or measuring do not ask the DOM anything.
// Each source is a primitive or a stable ref, so a scroll that keeps the same rendered range does not repaint.
watch(
  [() => (props.find?.query ? range.value.start : null), () => (props.find?.query ? range.value.end : null), () => (props.find?.query ? display.value : null), () => props.find?.query, activeKey],
  () => nextTick(paintFind),
  { flush: 'post' },
)
// Content that changes inside the rendered range (a tool group opening, markdown re-rendering) moves the
// text under the marks: while a query is set, one repaint per frame follows the rendered DOM.
let findMutations: MutationObserver | null = null
let findFrame = 0
function watchFindDom(on: boolean) {
  findMutations?.disconnect()
  findMutations = null
  if (findFrame) cancelAnimationFrame(findFrame)
  findFrame = 0
  const el = scroller.value
  if (!on || !el || !highlights) return
  // Only changes in a row (or rows coming and going) move the marks: the working clock under the rows ticks every second.
  const inRow = (m: MutationRecord) => {
    const t = m.target
    if ((t instanceof Element ? t : t.parentElement)?.closest('[data-id]')) return true
    return m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].some((n) => n instanceof Element && (n.matches('[data-id]') || !!n.querySelector('[data-id]')))
  }
  findMutations = new MutationObserver((records) => {
    if (findFrame || !records.some(inRow)) return
    findFrame = requestAnimationFrame(() => {
      findFrame = 0
      paintFind() // the marks are highlights, not elements: painting adds no mutation
    })
  })
  findMutations.observe(el, { childList: true, subtree: true, characterData: true })
}
watch(() => !!props.find?.query && !!scroller.value, watchFindDom, { immediate: true, flush: 'post' })
onBeforeUnmount(() => watchFindDom(false))

// The header over the top folding or unfolding changes the inset: what is on screen stays where it is
// (the header slides over it or off it) unless the list is at its top, where the first row follows it.
// Pinned to the bottom, the bottom stays.
watch(
  () => props.insetTop ?? 0,
  (now, before) => {
    const el = scroller.value
    if (!el || now === before) return
    if (pinned.value) return follow()
    if (el.scrollTop <= 0 && now > before) return
    el.scrollTop += now - before
    scrollTop.value = lastTop = el.scrollTop
  },
  { flush: 'post' },
)

// A different chat starts at its bottom.
watch(
  () => props.chatId,
  () => {
    heights.clear()
    version.value++
    pinned.value = true
    nextTick(scrollToBottom)
  },
)
</script>

<template>
  <div class="relative h-full min-h-0 bg-bg-page">
    <div
      ref="scroller"
      class="@container h-full overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
      role="feed"
      aria-label="Chat messages"
      data-transcript-scroller
      @scroll.passive="onScroll"
      @wheel.passive="onWheel"
    >
      <!-- The real column: 840 wide; text 768 at x 1151-1919 in whole-window.png, so 36px gutters (16 under a 560px pane); the last line sits 114px above the composer strip (whole-window.png) -->
      <div class="mx-auto w-full max-w-[840px] px-9 pb-[86px] @max-[560px]:px-4" :style="{ paddingTop: `${20 + (insetTop ?? 0)}px` }">
        <div v-if="!items.length && !showWorking" class="py-16 text-center text-[14px] text-text-muted">{{ emptyText }}</div>
        <div :style="{ height: `${padTop}px` }" />
        <div v-for="({ r, gap }, k) in visible" :key="r.id" v-measure :data-id="r.id" :style="{ paddingBottom: `${gap}px` }">
          <ToolGroup v-if="r.kind === 'tools'" :id="r.id" :items="r.items" :tasks="r.tasks" />
          <TaskGroup v-else-if="r.kind === 'tasks'" :id="r.id" :items="r.items" />
          <TranscriptRow v-else :item="r.item" :end-of-turn="r.endOfTurn" :prompt="r.prompt" :overlay-actions="display[range.start + k + 1]?.kind === 'tasks'" />
        </div>
        <div :style="{ height: `${padBottom}px` }" />
        <WorkingFooter v-if="showWorking && chat" :chat="chat" class="mt-4" />
        <RunningTasksRow v-if="chat && !readOnly" :chat="chat" :items="items" />
      </div>
    </div>
    <Transition
      enter-from-class="opacity-0 translate-y-1"
      leave-to-class="opacity-0 translate-y-1"
      enter-active-class="transition duration-150"
      leave-active-class="transition duration-150"
    >
      <button
        v-if="showJump"
        type="button"
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
        class="tx-scroll-bottom absolute bottom-4 right-5"
        @click="jumpToLatest"
      >
        <ArrowDown class="size-5 mix-blend-luminosity" />
      </button>
    </Transition>
  </div>
</template>
