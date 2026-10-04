<script setup lang="ts">
// Settled background tasks folded into one line, as the real app writes it under a turn: "18 background
// commands completed" in 14px secondary text. Open, it lists each task; a task opens the Background
// tasks panel on it.
import { computed } from 'vue'
import { Check, CircleStop, X } from '@lucide/vue'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { tasksLine, type TaskItem } from '../lib/groups'
import { formatElapsed } from '../lib/tools'
import StatusRow from './StatusRow.vue'

const props = defineProps<{ id: string; items: TaskItem[] }>()
const ctx = useTranscript()
const desk = useDesk()
const open = computed(() => ctx.isOpen(props.id))
const line = computed(() => tasksLine(props.items))

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`)
const meta = (t: TaskItem) =>
  [t.durationMs !== undefined ? formatElapsed(t.durationMs) : '', t.tokens !== undefined ? tokens(t.tokens) : ''].filter(Boolean).join(' · ')
</script>

<template>
  <div>
    <StatusRow :open="open" hover-chevron class="tx-status-tasks" @toggle="ctx.toggle(id)">
      <span class="min-w-0 truncate">{{ line }}</span>
    </StatusRow>
    <div v-if="open" class="mb-1 ml-1 mt-1.5 flex flex-col gap-0.5 border-l border-border pl-3">
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
        <span v-if="meta(t)" class="ml-auto shrink-0 pl-3 text-[12px] text-text-muted tabular-nums">{{ meta(t) }}</span>
      </button>
    </div>
  </div>
</template>
