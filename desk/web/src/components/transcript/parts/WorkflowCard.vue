<script setup lang="ts">
// A workflow in the flow (real-workflow-card.png): a 318px card, r8, 1px white-10% ring on the page,
// the title (14px secondary), then "Workflow" (500), the agent count and the elapsed time (13px, muted
// labels), a row of 6px progress squares and a chevron right. A click opens the Background tasks panel.
import { computed } from 'vue'
import { icons } from '@/lib/icons'
import type { TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useClock } from '../context'
import { workflowDots, workflowElapsed } from '../lib/groups'

const Chevron = icons.statusChevron
const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'task' }> }>()
const desk = useDesk()
const now = useClock()

const elapsed = computed(() => workflowElapsed(props.item, now.value))
const dots = computed(() => workflowDots(props.item))
</script>

<template>
  <button type="button" class="tx-workflow" :aria-label="`${item.description || 'Workflow'}: open background tasks`" @click="desk.openBackgroundTasks(item.taskId)">
    <span class="flex w-full items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-left text-[14px] leading-5 text-text-2">{{ item.description || 'Workflow' }}</span>
      <Chevron class="size-3.5 shrink-0 text-text-muted" />
    </span>
    <span class="mt-1 flex items-center gap-2 text-[13px] leading-[18px] tabular-nums">
      <span class="font-medium text-text-2">Workflow</span>
      <span v-if="item.agents !== undefined" class="text-text-muted"><span class="text-text-2">{{ item.agents }}</span> {{ item.agents === 1 ? 'agent' : 'agents' }}</span>
      <span class="text-text-muted">{{ elapsed }}</span>
    </span>
    <span class="mt-[11px] flex gap-0.5" aria-hidden="true">
      <span v-for="(d, i) in dots" :key="i" class="tx-workflow-dot" :data-state="d" />
    </span>
  </button>
</template>
