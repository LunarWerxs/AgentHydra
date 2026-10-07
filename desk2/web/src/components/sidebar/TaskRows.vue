<script setup lang="ts">
import { computed, h, ref, type Component, type FunctionalComponent } from 'vue'
import { Bot, CircleCheck, CircleX, Clock, Cloud, Hourglass, ListChecks, Network } from '@lucide/vue'
import type { CliMayteWorker, SwarmJob } from '@shared/protocol'
import { modelName } from '@/components/cloud/logic'
import { useClock } from '@/lib/clock'
import { accountTone } from './account-tone'
import { elapsedLabel, runPulse } from './logic'
import type { TaskNode } from './tasks'
import { rowLeave } from '@/lib/row-leave'

// The CliMayte tasks under one sidebar row, the chat that spawned them (components/sidebar/tasks.ts): 22px
// lines, one step in per level, with a guide line down their left. A task with a session opens its live
// transcript in Desk; one still queued (no session yet), or one on another PC (named by a cloud mark; its
// session is that PC's), opens on CliMayte's tab in AgentHydra.
// HSwarm jobs the chat called follow its tasks, as lines of the same size with a network mark and their progress.
const props = defineProps<{ nodes: TaskNode[]; jobs?: SwarmJob[]; selectedId: string | null }>()
const emit = defineEmits<{ open: [worker: CliMayteWorker]; 'open-job': [job: SwarmJob] }>()

const jobTip = (j: SwarmJob) =>
  [j.title, `HSwarm job · ${j.status} · ${j.tasks.done}/${j.tasks.total} tasks${j.tasks.failed ? `, ${j.tasks.failed} failed` : ''}${j.tasks.cancelled ? `, ${j.tasks.cancelled} cancelled` : ''}`, j.pc, 'Click to open it on HSwarm'].filter(Boolean).join('\n')
// Only these lines redraw on the tick, not the list around them.
const now = useClock()

/** The session it opens here: none for another PC's (Sidebar.vue openTask). */
const ownSession = (w: CliMayteWorker) => (w.pc ? null : w.sessionId)

// A running task's mark is the 6px dot a working chat has, in the 12px box of the other marks; its color is the text's.
const RunDot: FunctionalComponent = () => h('span', { class: 'flex items-center justify-center', 'aria-hidden': 'true' }, [h('span', { class: 'size-1.5 rounded-full bg-current' })])
// A task that runs, here or on another PC, pulses gray as a working chat's dot does, and one running its check
// pulses its mark the same way: blue is HSwarm's alone and nothing in the sidebar spins (owner, 2026-10-05: "Only
// the HSwarm items should have blue"). Finished, failed, waiting and queued marks hold still.
const STATUS: Record<string, { icon: Component; tone: string; label: string }> = {
  queued: { icon: Clock, tone: 'text-text-muted', label: 'Queued' },
  running: { icon: RunDot, tone: runPulse('gray'), label: 'Running' },
  waiting: { icon: Hourglass, tone: 'text-warning-text', label: 'Waiting' },
  checking: { icon: ListChecks, tone: runPulse('gray'), label: 'Running its check' },
  done: { icon: CircleCheck, tone: 'text-success-text', label: 'Done' },
  failed: { icon: CircleX, tone: 'text-danger-text', label: 'Failed' }
}
const statusOf = (w: CliMayteWorker) => STATUS[w.status] ?? { icon: Clock, tone: 'text-text-muted', label: w.status }
const isManager = (w: CliMayteWorker) => w.kind === 'manage'
const onPc = (pc: string) => `On ${pc}`
// Another PC's task may share its id with one of this PC's.
const keyOf = (w: CliMayteWorker) => (w.pc ? `${w.pc}:${w.id}` : w.id)

function tip(w: CliMayteWorker, status: { label: string }, now: number | null): string {
  return [
    w.title,
    isManager(w) ? 'CliMayte manager' : null,
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
  <TransitionGroup tag="div" class="ml-[11px] flex flex-col gap-px border-l border-border py-px" role="group" aria-label="CliMayte tasks and HSwarm jobs" :css="false" @leave="rowLeave">
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
      <component :is="status.icon" class="size-3 shrink-0" :class="status.tone" aria-hidden="true" />
      <span class="sr-only">{{ status.label }}:</span>
      <!-- A manager (an orchestrator with a wave under it) carries the CliMayte mark and a brighter title, so it stands
           out from the tasks under it (owner, 2026-10-07: "a special icon or something, or a slightly different color"). -->
      <Bot v-if="isManager(n.worker)" role="img" aria-label="CliMayte manager" class="size-3 shrink-0 text-text-muted" />
      <span class="min-w-0 flex-1 truncate" :class="{ 'text-text': isManager(n.worker) && !(own && selectedId === own) }">{{ n.worker.title }}</span>
      <!-- Another PC's task: a little cloud, its PC in the tooltip, so the title keeps the room (owner,
           2026-10-02, of CliMayte's list: "it just shows ones from my other computer with a little cloud icon"). -->
      <span v-if="n.worker.pc" class="flex shrink-0 items-center" :title="onPc(n.worker.pc)">
        <Cloud class="size-3 shrink-0 text-text-muted" aria-hidden="true" />
        <span class="sr-only">{{ onPc(n.worker.pc) }}</span>
      </span>
      <!-- Its account, in the colour of its dot on the row's CliMayte badge (account-tone.ts). -->
      <span v-if="n.worker.account" class="shrink-0 text-[11px] tnum" :style="{ color: accountTone(n.worker.account) ?? undefined }">{{ n.worker.account }}</span>
      <span v-if="n.worker.model" class="max-w-[38%] shrink-0 truncate text-[11px] text-text-muted">{{ modelName(n.worker.model) }}</span>
      <span class="shrink-0 text-[11px] text-text-muted tnum">{{ elapsedLabel(n.worker.startedAt, now) }}</span>
    </button>
    <button
      v-for="j in props.jobs ?? []"
      :key="`swarm:${j.id}`"
      type="button"
      :title="jobTip(j)"
      class="flex h-[22px] w-full min-w-0 cursor-default items-center gap-1 rounded-r-[var(--radius-6)] pl-1 pr-1 text-left text-[12px] leading-4 text-text-2 transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover"
      @click="emit('open-job', j)"
    >
      <!-- A running job's network mark is the sidebar's one blue, pulsing slowly (owner, 2026-10-05: "a slow blue pulsing icon"). -->
      <Network class="size-3 shrink-0" :class="j.active ? runPulse('blue') : j.tasks.failed ? 'text-danger-text' : 'text-text-muted'" aria-hidden="true" />
      <span class="sr-only">HSwarm job, {{ j.status }}:</span>
      <span class="min-w-0 flex-1 truncate">{{ j.title }}</span>
      <span class="shrink-0 text-[11px] text-text-muted tnum">{{ j.tasks.done }}/{{ j.tasks.total }}</span>
    </button>
  </TransitionGroup>
</template>
