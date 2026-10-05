<script setup lang="ts">
import { computed } from 'vue'
import type { TodoEntry, TranscriptItem } from '@shared/protocol'
import { bashExit, toolFamily } from '../lib/tools'
import { toolDiff } from '../lib/diff'
import { useTranscript } from '../context'
import ToolHeader from './ToolHeader.vue'
import OutputBlock from './OutputBlock.vue'
import DiffView from './DiffView.vue'
import TodoList from './TodoList.vue'
import ImageTiles from './ImageTiles.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem }>()

const ctx = useTranscript()
const family = computed(() => toolFamily(props.item.name))
// Edits show their diff without a click, as Claude Code does; everything else opens on demand.
const openByDefault = computed(() => family.value === 'edit' || family.value === 'write')
const open = computed(() => ctx.isOpen(props.item.id, openByDefault.value))
const diff = computed(() => (open.value ? toolDiff(props.item.name, props.item.input) : null))
const exit = computed(() => bashExit(props.item.status, props.item.result?.text))
const command = computed(() => String(props.item.input.command ?? ''))
const todos = computed(() => (Array.isArray(props.item.input.todos) ? (props.item.input.todos as TodoEntry[]) : []))
const showInput = computed(() => !['bash', 'edit', 'write', 'todo', 'read'].includes(family.value))
// Only an open row of a family that shows its input pretty-prints it.
const inputJson = computed(() => (open.value && showInput.value ? JSON.stringify(props.item.input, null, 2) : ''))
// A result that is only pictures ("[image]" per picture) shows the pictures, not the placeholder text.
const pictureOnly = computed(() => !!props.item.result?.images?.length && /^(\[image\]\s*)+$/.test(props.item.result?.text ?? ''))
</script>

<template>
  <div>
    <ToolHeader :item="item" :open="open" @toggle="ctx.toggle(item.id, openByDefault)" />
    <div v-if="open" class="mb-1.5 ml-[26px] mt-0.5 overflow-hidden rounded-8 border border-border bg-bg-panel">
      <!-- Bash: the command, its output, the exit state -->
      <template v-if="family === 'bash'">
        <pre class="whitespace-pre-wrap break-words border-b border-border px-3 py-2 font-mono text-[12px] leading-[19px] text-text"><span class="select-none text-text-muted">$ </span>{{ command }}</pre>
        <OutputBlock
          v-if="item.result || item.progress"
          :id="item.id"
          :text="item.result?.text ?? item.progress ?? ''"
          :error="item.result?.isError"
          :server-truncated="item.result?.truncated"
        />
        <div class="flex items-center gap-2 border-t border-border px-3 py-1 font-mono text-[11px]">
          <span :class="exit.ok === false ? 'text-danger-text' : exit.ok ? 'text-success-text' : 'text-text-muted'">{{ exit.label }}</span>
          <span v-if="item.input.description" class="truncate font-sans text-text-muted">{{ item.input.description }}</span>
        </div>
      </template>

      <!-- Edit / MultiEdit / Write: the line diff -->
      <template v-else-if="(family === 'edit' || family === 'write') && diff">
        <DiffView :id="item.id" :diff="diff" />
        <OutputBlock
          v-if="item.result?.isError || item.status === 'denied'"
          :id="`${item.id}:r`"
          :text="item.result?.text ?? 'Denied'"
          error
          class="border-t border-border"
        />
      </template>

      <!-- TodoWrite: the checklist it set -->
      <div v-else-if="family === 'todo'" class="px-3 py-2">
        <TodoList :todos="todos" />
      </div>

      <!-- Everything else: input, then result -->
      <template v-else>
        <div v-if="showInput" class="border-b border-border">
          <div class="px-3 pt-1.5 text-[12px] text-text-muted">Input</div>
          <OutputBlock :id="`${item.id}:in`" :text="inputJson" :max-lines="20" />
        </div>
        <div v-if="showInput" class="px-3 pt-1.5 text-[12px] text-text-muted">Result</div>
        <ImageTiles v-if="item.result?.images?.length" :images="item.result.images" class="px-3 py-2" />
        <OutputBlock
          v-if="item.result && !pictureOnly"
          :id="item.id"
          :text="item.result.text"
          :error="item.result.isError"
          :server-truncated="item.result.truncated"
          :max-lines="family === 'read' ? 20 : 30"
        />
        <div v-else class="px-3 py-2 text-[12px] text-text-muted">
          {{ item.status === 'running' ? item.progress || 'Running…' : item.status === 'denied' ? 'Denied' : 'No result' }}
        </div>
      </template>
    </div>
  </div>
</template>
