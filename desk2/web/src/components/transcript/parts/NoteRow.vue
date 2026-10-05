<script setup lang="ts">
// A note another program typed into the session as a user turn (an AgentHydra ping): a muted card on the
// left with who sent it, never the person's bubble on the right. A long one is clamped to four lines, with
// Show more whenever the clamp hides text (measured, so a wrapped line counts).
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Bot } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'note' }> }>()

const body = ref<HTMLElement | null>(null)
const expanded = ref(false)
const clipped = ref(false)
function measure() {
  const el = body.value
  if (el && !expanded.value) clipped.value = el.scrollHeight > el.clientHeight + 1
}
let resize: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (body.value && typeof ResizeObserver !== 'undefined') (resize = new ResizeObserver(measure)).observe(body.value)
})
onBeforeUnmount(() => resize?.disconnect())
watch(() => props.item.text, () => nextTick(measure))
</script>

<template>
  <div class="tx-card max-w-[72%] self-start px-3 py-2 text-[13px] leading-5">
    <div class="flex items-center gap-1.5 text-text-muted">
      <Bot class="size-3.5 shrink-0" />
      <span class="truncate text-text-2">{{ item.from }} response</span>
    </div>
    <p v-if="item.text" ref="body" class="mt-1 whitespace-pre-wrap break-words text-text-2" :class="!expanded && 'line-clamp-4'">{{ item.text }}</p>
    <button v-if="clipped || expanded" type="button" class="mt-0.5 text-text-muted hover:text-text" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? 'Show less' : 'Show more' }}
    </button>
  </div>
</template>
