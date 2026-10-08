<script setup lang="ts">
// Thinking as a status row: "Thinking" shimmering while it streams, "Thought process" after; opens to the text.
// step: a row of a tool run's box (ToolGroup), drawn as a tool step (32 high, 12px in, its chevron always shown); it
// opens its text under it over a hairline, inside the box. Alone, it opens its text in a rounded box of its own, as
// the steps of a run are drawn.
import { computed } from 'vue'
import { Brain, ChevronRight } from '@lucide/vue'
import { useTranscript } from '../context'
import StatusRow from './StatusRow.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ id: string; text: string; streaming?: boolean; step?: boolean }>()
const ctx = useTranscript()
const label = computed(() => (props.streaming ? 'Thinking' : 'Thought process'))
// Blank lines at either end of the text would show as empty space in the box (pre-wrap keeps them; owner, 2026-10-08:
// "an extra empty space below them for no reason").
const shown = computed(() => props.text.replace(/^\s*\n/, '').trimEnd())
</script>

<template>
  <div>
    <button
      v-if="step"
      type="button"
      class="group flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-start text-[14px] transition-colors duration-60 hover:bg-fill-hover"
      :aria-expanded="ctx.isOpen(id)"
      data-expander
      @click="ctx.toggle(id)"
    >
      <Brain class="size-4 shrink-0 text-text-muted" />
      <span class="min-w-0 truncate text-text-muted" :class="streaming && 'tx-shimmer'">{{ label }}</span>
      <ChevronRight class="ms-auto size-3 shrink-0 text-text-muted transition motion-reduce:transition-none" :class="ctx.isOpen(id) && 'rotate-90'" />
    </button>
    <StatusRow v-else :open="ctx.isOpen(id)" :running="streaming" @toggle="ctx.toggle(props.id)">
      <span :class="streaming && 'tx-shimmer'">{{ label }}</span>
    </StatusRow>
    <Collapse :open="ctx.isOpen(id)">
      <div v-if="step" class="whitespace-pre-wrap border-t border-border px-3 py-2 text-[14px] leading-5 text-text-muted">{{ shown }}<span v-if="streaming" class="stream-cursor" /></div>
      <div v-else class="tx-steps mb-1 mt-1.5 whitespace-pre-wrap px-3 py-2 text-[14px] leading-5 text-text-muted">{{ shown }}<span v-if="streaming" class="stream-cursor" /></div>
    </Collapse>
  </div>
</template>
