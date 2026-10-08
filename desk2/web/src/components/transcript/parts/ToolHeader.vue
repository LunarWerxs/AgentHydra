<script setup lang="ts">
import { computed } from 'vue'
import {
  Bot,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Network,
  Plug,
  Search,
  Terminal,
  Wrench,
} from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { bashExit, formatElapsed, keyArgument, toolFamily, toolLabel } from '../lib/tools'
import { toolDiff } from '../lib/diff'
import { useClock } from '@/lib/clock'
import { useTranscript } from '../context'
import StatusIcon from './StatusIcon.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
// step: a row of a tool run's box (ToolGroup): 32 high, 12px in, muted 14px, its chevron always shown, as
// Claude Desktop draws a step. Like StatusRow it is a data-expander: the transcript keeps it still while what it
// opens slides (TranscriptView's holdRow).
const props = defineProps<{ item: ToolItem; open: boolean; step?: boolean }>()
defineEmits<{ toggle: [] }>()

const ctx = useTranscript()
const clock = useClock()
const family = computed(() => toolFamily(props.item.name))
const icon = computed(() => {
  switch (family.value) {
    case 'bash':
      return Terminal
    case 'read':
      return FileText
    case 'edit':
      return FilePen
    case 'write':
      return FilePlus
    case 'search':
      return props.item.name === 'Glob' ? FolderSearch : Search
    case 'web':
      return Globe
    case 'todo':
      return ListTodo
    case 'agent':
      return Bot
    case 'climayte':
      return Network
    case 'mcp':
      return Plug
    default:
      return Wrench
  }
})
const label = computed(() => toolLabel(props.item.name))
const arg = computed(() => keyArgument(props.item.name, props.item.input, ctx.cwd.value))
const counts = computed(() => (family.value === 'edit' || family.value === 'write' ? toolDiff(props.item.name, props.item.input) : null))
const exit = computed(() => (family.value === 'bash' ? bashExit(props.item.status, props.item.result?.text) : null))
const elapsed = computed(() => {
  const end = props.item.endedAt ?? (props.item.status === 'running' ? clock.value : null)
  return end === null ? '' : formatElapsed(end - props.item.startedAt)
})
</script>

<template>
  <button
    type="button"
    class="group flex w-full min-w-0 items-center gap-1.5 text-start transition-colors duration-60 hover:bg-fill-hover"
    :class="step ? 'h-8 px-3 text-[14px]' : 'h-6 rounded-6 px-1 text-[13px]'"
    :aria-expanded="open"
    data-expander
    @click="$emit('toggle')"
  >
    <component :is="icon" class="size-4 shrink-0 text-text-muted" />
    <span class="shrink-0" :class="step ? 'text-text-muted' : 'text-text-2'">{{ label }}</span>
    <span class="min-w-0 truncate font-mono text-[12px] text-text-muted">{{ arg }}</span>
    <span v-if="item.status === 'running' && item.progress" class="min-w-0 max-w-[30%] shrink truncate text-[12px] text-text-muted">
      {{ item.progress }}
    </span>
    <span class="ms-auto flex shrink-0 items-center gap-2 ps-2 text-[12px] tabular-nums">
      <span v-if="counts && (counts.added || counts.removed)" class="font-mono">
        <span class="text-git-add">+{{ counts.added }}</span>
        <span v-if="counts.removed" class="ms-1 text-git-del">-{{ counts.removed }}</span>
      </span>
      <span v-if="exit && exit.ok === false" class="font-mono text-danger-text">{{ exit.label }}</span>
      <span class="text-text-muted">{{ elapsed }}</span>
      <StatusIcon :status="item.status" />
      <ChevronRight
        class="size-3 text-text-muted transition motion-reduce:transition-none"
        :class="[open && 'rotate-90', open || step ? 'opacity-100' : 'opacity-0 group-hover:opacity-100']"
      />
    </span>
  </button>
</template>
