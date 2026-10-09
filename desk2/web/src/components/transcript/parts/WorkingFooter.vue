<script setup lang="ts">
// The Working row under a running turn: the window's working mark (WorkingMark.vue, the look the current
// five-minute slot picked; its "spark" is the real Claude Code spinner) and shimmering text, plus Hydra Desk's
// elapsed time and queued count. Stop lives in the composer, as in the real app. Needs-you shows the amber dot
// instead. The text is the turn's step in its own words and the time counts from the person's last message, as
// Claude Desktop's working line does (lib/now-doing.ts; owner, 2026-10-08); its ">" opens the step it names.
import { computed } from 'vue'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { nowDoing, runningFor } from '../lib/now-doing'
import { useClock } from '@/lib/clock'
import { waitingLine } from '@/components/sidebar/logic'
import WorkingMark from './WorkingMark.vue'
import RevealStep from './RevealStep.vue'

const props = defineProps<{ chat: ChatSummary; items?: readonly TranscriptItem[] }>()
const emit = defineEmits<{ reveal: [id: string] }>()

const clock = useClock()
const needsYou = computed(() => props.chat.status === 'needs_you')
const doing = computed(() => nowDoing(props.items ?? [], props.chat.cwd))
const text = computed(() => {
  if (needsYou.value) return 'Waiting for you'
  // A CliMayte chat waiting for an account says so and when it starts, the reason in the tooltip, not "Starting…" for half an hour.
  // A first start that downloads Claude Code says how far it is ("Getting Claude Code 2.1.288 (104 MB): 37%").
  if (props.chat.status === 'starting') return props.chat.waiting ? waitingLine(props.chat.waiting, clock.value) : props.chat.activity || 'Starting…'
  return doing.value.text || props.chat.activity || 'Working…'
})
const why = computed(() => (props.chat.status === 'starting' && props.chat.waiting ? `${props.chat.waiting.reason}` : text.value))
const since = computed(() => doing.value.since ?? props.chat.turnStartedAt)
const elapsed = computed(() => (since.value ? runningFor(clock.value - since.value) : ''))
// Only while the words are the step's own (not "Starting…" or the server's activity line).
const step = computed(() => (!needsYou.value && props.chat.status !== 'starting' && doing.value.text ? doing.value.step : null))
</script>

<template>
  <div class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px]" role="status" aria-live="polite">
    <span v-if="needsYou" class="mx-1.25 size-1.5 shrink-0 animate-dot-blink rounded-full bg-warning" />
    <WorkingMark v-else />
    <span class="min-w-0 truncate" :class="needsYou ? 'text-warning-text' : 'tx-shimmer'" :title="why">{{ text }}</span>
    <RevealStep v-if="step" @click="step && emit('reveal', step)" />
    <span class="shrink-0 tabular-nums text-[13px] text-text-muted" aria-hidden="true">{{ elapsed }}</span>
    <span v-if="chat.queuedCount" class="shrink-0 text-[13px] text-text-muted">· {{ chat.queuedCount }} queued</span>
  </div>
</template>
