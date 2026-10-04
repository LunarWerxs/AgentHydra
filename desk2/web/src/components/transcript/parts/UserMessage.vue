<script setup lang="ts">
// The real user bubble: right aligned, at most 85% of the column and only as wide as its longest line,
// padding 8/12, radius 10, white 5%, 14/20 text,
// entering with code-user-bubble-enter; the actions toolbar (time, Copy, Resend) under it, shown on hover.
// A long message is clamped with a fade and a "Show more" link inside the bubble. Pictures sent with it
// sit above the bubble as 8px-rounded tiles that open in the lightbox.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ImageRef } from '@shared/protocol'
import MessageActions from './MessageActions.vue'
import ImageTiles from './ImageTiles.vue'

const props = defineProps<{ text: string; ts: number; images?: ImageRef[]; queued?: boolean }>()
// Only a message that just arrived animates in; one scrolled back into view does not.
const fresh = Date.now() - props.ts < 2000

const row = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const long = ref(false)
const expanded = ref(false)
let ro: ResizeObserver | null = null
let lastWidth = -1

// The real bubble hugs its longest wrapped line instead of filling its max width.
function fit() {
  const el = body.value
  if (!el) return
  el.style.width = ''
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
  if (right > left && width < el.clientWidth) el.style.width = `${width}px`
  if (!expanded.value) long.value = el.scrollHeight > el.clientHeight + 1
}

function onResize() {
  const w = row.value?.parentElement?.clientWidth ?? 0
  if (w === lastWidth) return
  lastWidth = w
  fit()
}

onMounted(() => {
  fit()
  const parent = row.value?.parentElement
  if (typeof ResizeObserver !== 'undefined' && parent) {
    ro = new ResizeObserver(onResize)
    ro.observe(parent)
  }
})
onBeforeUnmount(() => ro?.disconnect())
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
    <MessageActions v-else :text="text" :ts="ts" align="end" :resend="{ text, images }" />
  </div>
</template>
