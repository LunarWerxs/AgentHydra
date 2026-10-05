<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { CircleCheck, CircleX, Clock, Cloud, Hourglass, ListChecks, LoaderCircle } from '@lucide/vue'
import type { CliMayteWorker } from '@shared/protocol'
import { modelName } from '@/components/cloud/logic'
import { useClock } from '@/lib/clock'
import { elapsedLabel } from './logic'
import type { TaskNode } from './tasks'
import { rowLeave } from '@/lib/row-leave'

// The CliMayte tasks under one sidebar row, the chat that spawned them (components/sidebar/tasks.ts): 22px
// lines, one step in per level, with a guide line down their left. A task with a session opens its live
// transcript in Desk; one still queued (no session yet), or one on another PC (named by a cloud mark; its
// session is that PC's), opens on CliMayte's tab in AgentHydra.
const props = defineProps<{ nodes: TaskNode[]; selectedId: string | null }>()
const emit = defineEmits<{ open: [worker: CliMayteWorker] }>()
// Only these lines redraw on the tick, not the list around them.
const now = useClock()

/** The session it opens here: none for another PC's (Sidebar.vue openTask). */
const ownSession = (w: CliMayteWorker) => (w.pc ? null : w.sessionId)

const STATUS: Record<string, { icon: Component; tone: string; spin?: boolean; label: string }> = {
  queued: { icon: Clock, tone: 'text-text-muted', label: 'Queued' },
  running: { icon: LoaderCircle, tone: 'text-accent-text', spin: true, label: 'Running' },
  waiting: { icon: Hourglass, tone: 'text-warning-text', label: 'Waiting' },
  checking: { icon: ListChecks, tone: 'text-accent-text', label: 'Running its check' },
  done: { icon: CircleCheck, tone: 'text-success-text', label: 'Done' },
  failed: { icon: CircleX, tone: 'text-danger-text', label: 'Failed' }
}
const statusOf = (w: CliMayteWorker) => STATUS[w.status] ?? { icon: Clock, tone: 'text-text-muted', label: w.status }
const onPc = (pc: string) => `On ${pc}`
// Another PC's task may share its id with one of this PC's.
const keyOf = (w: CliMayteWorker) => (w.pc ? `${w.pc}:${w.id}` : w.id)

function tip(w: CliMayteWorker, status: { label: string }, now: number | null): string {
  return [
    w.title,
    w.pc ? onPc(w.pc) : null,
    [status.label, w.account, [modelName(w.model), w.effort].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
    w.startedAt && now !== null ? `Started ${elapsedLabel(w.startedAt, now)} ago` : null,
    w.lastActivity,
    ownSession(w) ? 'Click to open its transcript' : 'Click to open it on CliMayte'
  ]
    .filter(Boolean)
    .join('\n')
}

// What each line shows that does not move with the clock, worked out once per change of the tasks. Its
// tooltip is rebuilt with the elapsed time only while the pointer or focus is on it.
const lines = computed(() =>
  props.nodes.map((n) => {
    const key = keyOf(n.worker)
    const status = statusOf(n.worker)
    const own = ownSession(n.worker)
    return { n, key, status, own, base: tip(n.worker, status, null) }
  })
)
const hot = ref<string | null>(null)
</script>

<template>
  <TransitionGroup tag="div" class="ml-[11px] flex flex-col gap-px border-l border-border py-px" role="group" aria-label="CliMayte tasks" :css="false" @leave="rowLeave">
    <button
      v-for="{ n, key, status, own, base } in lines"
      :key="key"
      type="button"
      :title="hot === key ? tip(n.worker, status, now) : base"
      :aria-current="own && selectedId === own ? 'page' : undefined"
      class="flex h-[22px] w-full min-w-0 cursor-default items-center gap-1 rounded-r-[var(--radius-6)] pr-1 text-left text-[12px] leading-4 transition-colors duration-[var(--dur-fast)]"
      :class="own && selectedId === own ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover'"
      :style="{ paddingLeft: `${4 + (n.depth - 1) * 14}px` }"
      @click="emit('open', n.worker)"
      @pointerenter="hot = key"
      @pointerleave="hot = null"
      @focus="hot = key"
      @blur="hot = null"
    >
      <component :is="status.icon" class="size-3 shrink-0" :class="[status.tone, status.spin ? 'animate-[spin_2.5s_linear_infinite]' : '']" aria-hidden="true" />
      <span class="sr-only">{{ status.label }}:</span>
      <span class="min-w-0 flex-1 truncate">{{ n.worker.title }}</span>
      <!-- Another PC's task: a little cloud, its PC in the tooltip, so the title keeps the room (owner,
           2026-10-02, of CliMayte's list: "it just shows ones from my other computer with a little cloud icon"). -->
      <span v-if="n.worker.pc" class="flex shrink-0 items-center" :title="onPc(n.worker.pc)">
        <Cloud class="size-3 shrink-0 text-text-muted" aria-hidden="true" />
        <span class="sr-only">{{ onPc(n.worker.pc) }}</span>
      </span>
      <span v-if="n.worker.model" class="max-w-[38%] shrink-0 truncate text-[11px] text-text-muted">{{ modelName(n.worker.model) }}</span>
      <span class="shrink-0 text-[11px] text-text-muted tnum">{{ elapsedLabel(n.worker.startedAt, now) }}</span>
    </button>
  </TransitionGroup>
</template>
