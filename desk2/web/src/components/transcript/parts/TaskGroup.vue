<script setup lang="ts">
// Settled background tasks folded into one line, as the real app writes it under a turn: "18 background
// commands completed" in 14px secondary text. Open, it lists each task; a task opens the Background
// tasks panel on it. Under a tool run (ToolGroup) it is one row of that run's box (`step`).
import { computed } from 'vue'
import { Check, CircleStop, X } from '@lucide/vue'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { tasksLine, type TaskItem } from '../lib/groups'
import { formatElapsed } from '../lib/tools'
import StatusRow from './StatusRow.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ id: string; items: TaskItem[]; step?: boolean }>()
const ctx = useTranscript()
const desk = useDesk()
const open = computed(() => ctx.isOpen(props.id))
const line = computed(() => tasksLine(props.items))

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`)
const meta = (t: TaskItem) =>
  [t.durationMs !== undefined ? formatElapsed(t.durationMs) : '', t.tokens !== undefined ? tokens(t.tokens) : ''].filter(Boolean).join(' · ')
</script>

<template>
  <div :class="step && 'px-2 py-1'">
    <StatusRow :open="open" hover-chevron class="tx-status-tasks" @toggle="ctx.toggle(id)">
      <span class="min-w-0 truncate">{{ line }}</span>
    </StatusRow>
    <Collapse :open="open">
      <div class="mb-1 ms-1 mt-1.5 flex flex-col gap-0.5 border-s border-border ps-3">
        <button
          v-for="t in items"
          :key="t.id"
          type="button"
          class="tx-task-line"
          @click="desk.openBackgroundTasks(t.taskId)"
        >
          <Check v-if="t.status === 'completed'" class="size-3.5 shrink-0 text-text-muted" />
          <X v-else-if="t.status === 'failed'" class="size-3.5 shrink-0 text-danger-text" />
          <CircleStop v-else class="size-3.5 shrink-0 text-text-muted" />
          <span class="min-w-0 truncate text-text-2">{{ t.description || t.summary || t.taskId }}</span>
          <span v-if="meta(t)" class="ms-auto shrink-0 ps-3 text-[12px] text-text-muted tabular-nums">{{ meta(t) }}</span>
        </button>
      </div>
    </Collapse>
  </div>
</template>
