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
// entering with code-user-bubble-enter; the actions toolbar (time, Copy, Undo, Fork) under it, shown on hover.
// A message waiting behind a running turn says so instead, with Send now: the turn stops and it goes at once.
// A long message is clamped with a fade and a "Show more" link inside the bubble. Pictures sent with it
// sit above the bubble as 8px-rounded tiles that open in the lightbox.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ImageRef } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import MessageActions from './MessageActions.vue'
import ImageTiles from './ImageTiles.vue'

const props = defineProps<{ id?: string; text: string; ts: number; images?: ImageRef[]; queued?: boolean }>()
// Only a message that just arrived animates in; one scrolled back into view does not.
const fresh = Date.now() - props.ts < 2000

const ctx = useTranscript()
const desk = useDesk()
const chat = computed(() => desk.chats.value.find((c) => c.id === ctx.chatId.value) ?? null)
// A CliMayte chat whose worker waits for an account (or a launch) runs no turn: Send now has nothing to stop, and the
// message already goes first when it starts (2026-10-06: Send now flipped back to itself for half an hour).
const noTurnYet = computed(() => !!chat.value?.workerId && chat.value.status === 'starting')
const canSendNow = computed(() => !ctx.readOnly.value && !!ctx.chatId.value && !noTurnYet.value)
const sendNowState = ref<'idle' | 'sending' | 'failed'>('idle')
const sendNowError = ref('')
// Why Send now stopped nothing (it already went, or no turn runs yet), shown in place of the queued line for a while.
const sendNowNote = ref('')
let noteTimer: ReturnType<typeof setTimeout> | undefined

async function sendNow() {
  if (sendNowState.value === 'sending') return
  sendNowState.value = 'sending'
  try {
    const r = await desk.sendNow(ctx.chatId.value, props.id)
    sendNowState.value = 'idle'
    if (!r.stopped && r.message) {
      sendNowNote.value = r.message
      clearTimeout(noteTimer)
      noteTimer = setTimeout(() => (sendNowNote.value = ''), 10_000)
    }
  } catch (err) {
    sendNowError.value = err instanceof Error ? err.message : String(err)
    sendNowState.value = 'failed'
    setTimeout(() => (sendNowState.value = 'idle'), 4000)
  }
}

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
onBeforeUnmount(() => {
  unwatch?.()
  clearTimeout(noteTimer)
})
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
    <div v-if="queued" class="flex min-h-6 max-w-[85%] items-center gap-1.5 text-right text-[13px] text-text-muted">
      <span v-if="sendNowState === 'failed'" class="text-danger-text">Send now failed{{ sendNowError ? `: ${sendNowError}` : '' }}</span>
      <span v-else-if="sendNowNote">{{ sendNowNote }}</span>
      <template v-else>
        <span>{{ noTurnYet ? 'Queued, goes first when CliMayte starts this chat' : 'Queued, sends when this turn ends' }}</span>
        <template v-if="canSendNow">
          <span aria-hidden="true">·</span>
          <button
            type="button"
            class="cursor-pointer hover:text-text disabled:cursor-default disabled:opacity-60"
            :disabled="sendNowState === 'sending'"
            title="Stop this turn and send this message now"
            @click="sendNow"
          >
            {{ sendNowState === 'sending' ? 'Sending…' : 'Send now' }}
          </button>
        </template>
      </template>
    </div>
    <MessageActions v-else :text="text" :ts="ts" align="end" :resend="{ text, images }" :item-id="id" />
  </div>
</template>
