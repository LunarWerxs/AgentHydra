<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, Info, TriangleAlert } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { formatElapsed, isSendFileTool, toolFamily } from './lib/tools'
import type { TurnPrompt } from './lib/groups'
import UserMessage from './parts/UserMessage.vue'
import NoteRow from './parts/NoteRow.vue'
import MarkdownBlock from './parts/MarkdownBlock.vue'
import ThinkingRow from './parts/ThinkingRow.vue'
import ToolRow from './parts/ToolRow.vue'
import SubAgentCard from './parts/SubAgentCard.vue'
import CliMayteCard from './parts/CliMayteCard.vue'
import BrowserCard from './parts/BrowserCard.vue'
import RedesignCard from './parts/RedesignCard.vue'
import RedesignReplyChip from './parts/RedesignReplyChip.vue'
import { parseReplyChip } from './lib/redesign'
import TodoList from './parts/TodoList.vue'
import TaskCard from './parts/TaskCard.vue'
import WorkflowCard from './parts/WorkflowCard.vue'
import SendFileRow from './parts/SendFileRow.vue'
import NamedMedia from './parts/NamedMedia.vue'
import PermissionCard from './parts/PermissionCard.vue'
import QuestionCard from './parts/QuestionCard.vue'
import PlanCard from './parts/PlanCard.vue'
import ElicitationCard from './parts/ElicitationCard.vue'
import MessageActions from './parts/MessageActions.vue'
import { useTranscript } from './context'
import { useDesk } from '@/stores/desk'

// overlayActions: settled tasks follow the reply ("18 background commands completed" sits 15px under its last
// line in real-markdown-and-file-card.png), so the hover toolbar floats over that gap instead of opening one.
const props = defineProps<{ item: TranscriptItem; nested?: boolean; endOfTurn?: boolean; overlayActions?: boolean; prompt?: TurnPrompt | null }>()

const ctx = useTranscript()
const desk = useDesk()

// "Could not get Claude Code ...": Retry starts the download again; the chat's own status line then shows it.
const retrying = ref(false)
async function retryDownload() {
  if (retrying.value) return
  retrying.value = true
  try {
    await desk.retryClaudeCode(ctx.chatId.value)
  } catch {
    // the chat's status line and this row say what happened; the button is there again for another try
  } finally {
    retrying.value = false
  }
}
const family = computed(() => (props.item.kind === 'tool_use' ? toolFamily(props.item.name, props.item.input) : null))
// A message the ReDesign card sent shows as a small chip, not as a raw text bubble.
const chip = computed(() => (props.item.kind === 'user' && !props.item.queued ? parseReplyChip(props.item.text) : null))
const resultLine = computed(() => {
  const it = props.item
  if (it.kind !== 'result') return ''
  // The chat's latest turn is not "Done" while the background tasks it dispatched still run.
  const bg = ctx.background?.value
  const waiting = it.ok && bg && bg.count > 0 && bg.resultId === it.id ? bg.count : 0
  const parts = [`${waiting ? 'Replied' : it.ok ? 'Done' : 'Failed'} in ${formatElapsed(it.durationMs)}`]
  if (waiting) parts.push(`${waiting} background ${waiting === 1 ? 'task' : 'tasks'} still running`)
  if (it.costUsd > 0) parts.push(`$${it.costUsd.toFixed(2)}`)
  if (it.turns > 1) parts.push(`${it.turns} turns`)
  if (!it.ok && it.error) parts.push(it.error)
  return parts.join(' · ')
})

// Retry under a finished reply sends again the prompt that started its turn (worked out with the rows).
const turnPrompt = computed(() => (props.item.kind !== 'assistant_text' || !props.endOfTurn || props.nested ? null : (props.prompt ?? null)))
</script>

<template>
  <RedesignReplyChip v-if="chip" :chip="chip" :ts="item.ts" />

  <UserMessage v-else-if="item.kind === 'user'" :id="item.id" :text="item.text" :ts="item.ts" :images="item.images" :queued="item.queued" />

  <NoteRow v-else-if="item.kind === 'note'" :item="item" />

  <div v-else-if="item.kind === 'assistant_text'" class="group/message-row relative flex flex-col gap-1" :class="nested && 'tx-nested'">
    <MarkdownBlock :text="item.text" :streaming="item.streaming" />
    <NamedMedia v-if="item.media?.length && !item.streaming" :media="item.media" />
    <MessageActions
      v-if="endOfTurn && !nested"
      :text="item.text"
      :ts="item.ts"
      :resend="turnPrompt"
      :branch-from="item.branchFrom"
      :class="overlayActions && 'absolute left-0 top-full z-10 bg-bg-page'"
    />
  </div>

  <ThinkingRow v-else-if="item.kind === 'thinking'" :id="item.id" :text="item.text" :streaming="item.streaming" />

  <template v-else-if="item.kind === 'tool_use'">
    <SendFileRow v-if="isSendFileTool(item.name)" :item="item" />
    <SubAgentCard v-else-if="family === 'agent'" :item="item">
      <template #row="{ item: kid }"><TranscriptRow :item="kid" nested /></template>
    </SubAgentCard>
    <CliMayteCard v-else-if="family === 'climayte'" :item="item" />
    <RedesignCard v-else-if="family === 'redesign'" :item="item" />
    <BrowserCard v-else-if="family === 'browser'" :item="item" />
    <ToolRow v-else :item="item" />
  </template>

  <div v-else-if="item.kind === 'todos'" class="tx-card px-3 py-2">
    <div class="mb-1 text-[13px] text-text-muted">
      To-dos · {{ item.todos.filter((t) => t.status === 'completed').length }}/{{ item.todos.length }} done
    </div>
    <TodoList :todos="item.todos" />
  </div>

  <WorkflowCard v-else-if="item.kind === 'task' && item.taskKind === 'workflow'" :item="item" />
  <TaskCard v-else-if="item.kind === 'task'" :item="item" />
  <PermissionCard v-else-if="item.kind === 'permission'" :item="item" />
  <QuestionCard v-else-if="item.kind === 'question'" :item="item" />
  <PlanCard v-else-if="item.kind === 'plan'" :item="item" />
  <ElicitationCard v-else-if="item.kind === 'elicitation'" :item="item" />

  <div
    v-else-if="item.kind === 'system'"
    class="flex min-h-6 items-start gap-1.5 px-1 py-0.5 text-[13px] leading-5"
    :class="item.level === 'error' ? 'text-danger-text' : item.level === 'warn' ? 'text-warning-text' : 'text-text-muted'"
  >
    <CircleAlert v-if="item.level === 'error'" class="mt-0.5 size-4 shrink-0" />
    <TriangleAlert v-else-if="item.level === 'warn'" class="mt-0.5 size-4 shrink-0" />
    <Info v-else class="mt-0.5 size-4 shrink-0" />
    <span class="whitespace-pre-wrap break-words">{{ item.text }}</span>
    <button
      v-if="item.retry && !ctx.readOnly.value"
      type="button"
      class="ml-1 shrink-0 rounded px-1.5 text-text underline hover:bg-fill-hover disabled:opacity-50"
      :disabled="retrying"
      @click="retryDownload"
    >
      Retry
    </button>
  </div>

  <div
    v-else-if="item.kind === 'result'"
    class="flex h-6 items-center px-1 text-[13px] tabular-nums"
    :class="item.ok ? 'text-text-muted' : 'text-danger-text'"
  >
    {{ resultLine }}
  </div>
</template>
