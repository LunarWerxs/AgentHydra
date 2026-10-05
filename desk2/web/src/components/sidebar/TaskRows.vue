<script setup lang="ts">
import { type Component } from 'vue'
import { CircleCheck, CircleX, Clock, Hourglass, ListChecks, LoaderCircle } from '@lucide/vue'
import type { CliMayteWorker } from '@shared/protocol'
import { modelName } from '@/components/cloud/logic'
import { elapsedLabel } from './logic'
import type { TaskNode } from './tasks'

// The CliMayte tasks under one sidebar row (components/sidebar/tasks.ts): 22px lines, one step in per
// level, with a guide line down their left. A task with a session opens its live transcript in Desk;
// one still queued (no session yet) opens on CliMayte's tab in AgentHydra.
defineProps<{ nodes: TaskNode[]; selectedId: string | null; now: number }>()
const emit = defineEmits<{ open: [worker: CliMayteWorker] }>()

const STATUS: Record<string, { icon: Component; tone: string; spin?: boolean; label: string }> = {
  queued: { icon: Clock, tone: 'text-text-muted', label: 'Queued' },
  running: { icon: LoaderCircle, tone: 'text-accent-text', spin: true, label: 'Running' },
  waiting: { icon: Hourglass, tone: 'text-warning-text', label: 'Waiting' },
  checking: { icon: ListChecks, tone: 'text-accent-text', label: 'Running its check' },
  done: { icon: CircleCheck, tone: 'text-success-text', label: 'Done' },
  failed: { icon: CircleX, tone: 'text-danger-text', label: 'Failed' }
}
const statusOf = (w: CliMayteWorker) => STATUS[w.status] ?? { icon: Clock, tone: 'text-text-muted', label: w.status }

function tip(w: CliMayteWorker, now: number): string {
  return [
    w.title,
    [statusOf(w).label, w.account, [modelName(w.model), w.effort].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
    w.startedAt ? `Started ${elapsedLabel(w.startedAt, now)} ago` : null,
    w.lastActivity,
    w.sessionId ? 'Click to open its transcript' : 'Click to open it on CliMayte'
  ]
    .filter(Boolean)
    .join('\n')
}
</script>

<template>
  <div class="ml-[11px] flex flex-col gap-px border-l border-border py-px" role="group" aria-label="CliMayte tasks">
    <button
      v-for="n in nodes"
      :key="n.worker.id"
      type="button"
      :title="tip(n.worker, now)"
      :aria-current="n.worker.sessionId && selectedId === n.worker.sessionId ? 'page' : undefined"
      class="flex h-[22px] w-full min-w-0 cursor-default items-center gap-1 rounded-r-[var(--radius-6)] pr-1 text-left text-[12px] leading-4 transition-colors duration-[var(--dur-fast)]"
      :class="n.worker.sessionId && selectedId === n.worker.sessionId ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover'"
      :style="{ paddingLeft: `${4 + (n.depth - 1) * 14}px` }"
      @click="emit('open', n.worker)"
    >
      <component :is="statusOf(n.worker).icon" class="size-3 shrink-0" :class="[statusOf(n.worker).tone, statusOf(n.worker).spin ? 'animate-spin' : '']" aria-hidden="true" />
      <span class="sr-only">{{ statusOf(n.worker).label }}:</span>
      <span class="min-w-0 flex-1 truncate">{{ n.worker.title }}</span>
      <span v-if="n.worker.model" class="max-w-[38%] shrink-0 truncate text-[11px] text-text-muted">{{ modelName(n.worker.model) }}</span>
      <span class="shrink-0 text-[11px] text-text-muted tnum">{{ elapsedLabel(n.worker.startedAt, now) }}</span>
    </button>
  </div>
</template>
