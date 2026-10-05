<script lang="ts">
// One observer for the column all the bubbles stand in, not one each: a width change fits every bubble in
// four steps (clear all, measure all, set all, read all), so the page lays out twice instead of once per bubble.
interface Fitter {
  lastWidth: number
  reset(): void
  measure(): void
  apply(): void
  settle(): void
}
const fitters = new Map<Element, Set<Fitter>>()
let columns: ResizeObserver | null = null

function fitAll(list: Fitter[]) {
  for (const f of list) f.reset()
  for (const f of list) f.measure()
  for (const f of list) f.apply()
  for (const f of list) f.settle()
}

function watchColumn(column: Element, f: Fitter) {
  columns ??= new ResizeObserver((entries) => {
    const due: Fitter[] = []
    for (const e of entries) {
      const w = (e.target as HTMLElement).clientWidth
      for (const f of fitters.get(e.target) ?? []) {
        if (f.lastWidth === w) continue
        f.lastWidth = w
        due.push(f)
      }
    }
    fitAll(due)
  })
  let set = fitters.get(column)
  if (!set) fitters.set(column, (set = new Set()))
  set.add(f)
  if (set.size === 1) columns.observe(column)
  return () => {
    set.delete(f)
    if (!set.size) {
      fitters.delete(column)
      columns?.unobserve(column)
    }
  }
}
</script>

<script setup lang="ts">
// The real user bubble: right aligned, at most 85% of the column and only as wide as its longest line,
// padding 8/12, radius 10, white 5%, 14/20 text,
// entering with code-user-bubble-enter; the actions toolbar (time, Copy, Resend, Fork) under it, shown on hover.
// A long message is clamped with a fade and a "Show more" link inside the bubble. Pictures sent with it
// sit above the bubble as 8px-rounded tiles that open in the lightbox.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ImageRef } from '@shared/protocol'
import MessageActions from './MessageActions.vue'
import ImageTiles from './ImageTiles.vue'

const props = defineProps<{ id?: string; text: string; ts: number; images?: ImageRef[]; queued?: boolean }>()
// Only a message that just arrived animates in; one scrolled back into view does not.
const fresh = Date.now() - props.ts < 2000

const row = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const long = ref(false)
const expanded = ref(false)
let unwatch: (() => void) | null = null
let target: number | null = null

// The real bubble hugs its longest wrapped line instead of filling its max width. Four steps, so many
// bubbles can be fitted with their reads together (see the top of this file).
function reset() {
  if (body.value) body.value.style.width = ''
}
function measure() {
  target = null
  const el = body.value
  if (!el) return
  const range = document.createRange()
  range.selectNodeContents(el)
  let left = Infinity
  let right = -Infinity
  for (const r of range.getClientRects()) {
    if (!r.width) continue
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  // A fresh bubble is still scaling in: client rects are transformed, offsetWidth is not.
  const scale = el.getBoundingClientRect().width / (el.offsetWidth || 1) || 1
  const width = Math.ceil((right - left) / scale)
  if (right > left && width < el.clientWidth) target = width
}
function apply() {
  if (body.value && target !== null) body.value.style.width = `${target}px`
}
function settle() {
  const el = body.value
  if (el && !expanded.value) long.value = el.scrollHeight > el.clientHeight + 1
}
function fit() {
  fitAll([fitter])
}
const fitter: Fitter = { lastWidth: -1, reset, measure, apply, settle }

onMounted(() => {
  fit()
  const parent = row.value?.parentElement
  if (typeof ResizeObserver !== 'undefined' && parent) unwatch = watchColumn(parent, fitter)
})
onBeforeUnmount(() => unwatch?.())
watch(() => props.text, () => nextTick(fit))
</script>

<template>
  <div ref="row" class="group/message-row ms-auto flex flex-col items-end gap-1">
    <ImageTiles v-if="images?.length" :images="images" align="end" class="max-w-[85%]" :class="queued && 'opacity-60'" />
    <div
      v-if="text || !images?.length"
      class="tx-bubble"
      :class="[fresh && 'animate-[code-user-bubble-enter_.3s_cubic-bezier(.32,.72,0,1)] origin-right', queued && 'opacity-60']"
    >
      <p ref="body" class="whitespace-pre-wrap break-words" :class="!expanded && ['tx-bubble-clamped', long && 'tx-bubble-fade']">{{ text }}</p>
      <button v-if="long" type="button" class="tx-bubble-more" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>
    </div>
    <div v-if="queued" class="flex h-6 items-center text-[13px] text-text-muted">Queued, sends when this turn ends</div>
    <MessageActions v-else :text="text" :ts="ts" align="end" :resend="{ text, images }" :item-id="id" />
  </div>
</template>
