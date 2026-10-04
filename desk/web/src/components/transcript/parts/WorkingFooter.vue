<script setup lang="ts">
// The Working row under a running turn: the real Claude Code spinner (glyphs stepping through
// codeSpinnerSpin) and shimmering text, plus Hydra Desk's elapsed time and queued count. Stop lives
// in the composer, as in the real app. Needs-you shows the amber dot instead.
import { computed } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { formatElapsed } from '../lib/tools'
import { useClock } from '../context'

const props = defineProps<{ chat: ChatSummary }>()

const clock = useClock()
const needsYou = computed(() => props.chat.status === 'needs_you')
const text = computed(() => {
  if (needsYou.value) return 'Waiting for you'
  if (props.chat.status === 'starting') return 'Starting…'
  return props.chat.activity || 'Working…'
})
const elapsed = computed(() =>
  props.chat.turnStartedAt ? formatElapsed(Math.max(0, clock.value - props.chat.turnStartedAt)).replace(/^\d+ms$/, '0s') : '',
)
const GLYPHS = ['·', '✢', '✳', '✶', '✻']
</script>

<template>
  <div class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px]" role="status" aria-live="polite">
    <span v-if="needsYou" class="mx-[5px] size-1.5 shrink-0 animate-dot-blink rounded-full bg-warning" />
    <span v-else class="tx-spinner" aria-hidden="true">
      <span class="tx-spinner-strip"><span v-for="g in GLYPHS" :key="g">{{ g }}</span></span>
    </span>
    <span class="min-w-0 truncate" :class="needsYou ? 'text-warning-text' : 'tx-shimmer'">{{ text }}</span>
    <span class="shrink-0 tabular-nums text-[13px] text-text-muted">{{ elapsed }}</span>
    <span v-if="chat.queuedCount" class="shrink-0 text-[13px] text-text-muted">· {{ chat.queuedCount }} queued</span>
  </div>
</template>
