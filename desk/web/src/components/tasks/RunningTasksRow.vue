<script setup lang="ts">
// The muted '1 running task · 2 finished' line the real app shows under the last message
// (real-running-task-and-attachments.png: 14px #898781, 64px below the status row above it, text at
// the status rows' x). It counts the Background tasks panel's running units for this chat and opens
// the panel; nothing renders when nothing runs.
import { computed } from 'vue'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { openBackgroundTasks } from './api'
import { panelLists, runningLabel } from './logic'

const props = defineProps<{ chat: ChatSummary; items: TranscriptItem[] }>()
const src = useShellSource()

// Running and finished, as the Background tasks panel lists them for this chat (its CliMayte workers and
// its own background tasks); a task the chat finished counts as finished.
const label = computed(() => {
  const lists = panelLists({ workers: src.workers.value, items: props.items, sessionId: props.chat.sessionId, workerIds: props.chat.workerIds })
  const tasksDone = props.items.filter((i) => i.kind === 'task' && i.status !== 'running').length
  return runningLabel(lists.running.length, lists.finished.length + tasksDone)
})
</script>

<template>
  <button
    v-if="label"
    type="button"
    class="mt-10 flex h-6 items-center rounded-[6px] px-1 text-[14px] text-[var(--text-muted)] outline-none transition-colors duration-[60ms] hover:text-[var(--text-2)] focus-visible:shadow-[var(--focus-ring)]"
    data-running-tasks
    @click="openBackgroundTasks()"
  >
    {{ label }}
  </button>
</template>
