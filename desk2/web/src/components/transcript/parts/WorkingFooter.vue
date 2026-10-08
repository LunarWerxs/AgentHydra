<script setup lang="ts">
// The Working row under a running turn: the window's working mark (WorkingMark.vue, the one Settings
// picks; its "spark" is the real Claude Code spinner) and shimmering text, plus Hydra Desk's elapsed time
// and queued count. Stop lives in the composer, as in the real app. Needs-you shows the amber dot instead.
import { computed } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { formatElapsed } from '../lib/tools'
import { useClock } from '@/lib/clock'
import { waitingLine } from '@/components/sidebar/logic'
import WorkingMark from './WorkingMark.vue'

const props = defineProps<{ chat: ChatSummary }>()

const clock = useClock()
const needsYou = computed(() => props.chat.status === 'needs_you')
const text = computed(() => {
  if (needsYou.value) return 'Waiting for you'
  // A CliMayte chat waiting for an account says so and when it starts, the reason in the tooltip, not "Starting…" for half an hour.
  // A first start that downloads Claude Code says how far it is ("Getting Claude Code 2.1.288 (104 MB): 37%").
  if (props.chat.status === 'starting') return props.chat.waiting ? waitingLine(props.chat.waiting, clock.value) : props.chat.activity || 'Starting…'
  return props.chat.activity || 'Working…'
})
const why = computed(() => (props.chat.status === 'starting' && props.chat.waiting ? `${props.chat.waiting.reason}` : text.value))
const elapsed = computed(() =>
  props.chat.turnStartedAt ? formatElapsed(Math.max(0, clock.value - props.chat.turnStartedAt)).replace(/^\d+ms$/, '0s') : '',
)
</script>

<template>
  <div class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px]" role="status" aria-live="polite">
    <span v-if="needsYou" class="mx-1.25 size-1.5 shrink-0 animate-dot-blink rounded-full bg-warning" />
    <WorkingMark v-else />
    <span class="min-w-0 truncate" :class="needsYou ? 'text-warning-text' : 'tx-shimmer'" :title="why">{{ text }}</span>
    <span class="shrink-0 tabular-nums text-[13px] text-text-muted" aria-hidden="true">{{ elapsed }}</span>
    <span v-if="chat.queuedCount" class="shrink-0 text-[13px] text-text-muted">· {{ chat.queuedCount }} queued</span>
  </div>
</template>
