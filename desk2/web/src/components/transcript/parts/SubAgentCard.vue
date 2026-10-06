<script setup lang="ts">
import { computed } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import { useTranscript } from '../context'
import ToolHeader from './ToolHeader.vue'
import MarkdownBlock from './MarkdownBlock.vue'
import ToolGroup from './ToolGroup.vue'
import BrowserCard from './BrowserCard.vue'
import { groupRows } from '../lib/groups'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem }>()

const ctx = useTranscript()
const running = computed(() => props.item.status === 'running')
const open = computed(() => ctx.isOpen(props.item.id, running.value))
const kids = computed(() => ctx.children.value.get(props.item.id) ?? [])
const kidRows = computed(() => groupRows(kids.value))
const prompt = computed(() => String(props.item.input.prompt ?? ''))
const steps = computed(() => kids.value.filter((k) => k.kind === 'tool_use').length)
const latest = computed(() => {
  for (let i = kids.value.length - 1; i >= 0; i--) {
    const k = kids.value[i]
    if (k.kind === 'tool_use') return `${k.name}${k.status === 'running' ? '…' : ''}`
  }
  return null
})
</script>

<template>
  <div class="tx-card">
    <div class="px-1 pt-0.5" :class="!open && 'pb-0.5'">
      <ToolHeader :item="item" :open="open" @toggle="ctx.toggle(item.id, running)" />
    </div>
    <div v-if="!open && (steps || latest)" class="-mt-0.5 px-3 pb-1.5 pl-[30px] text-[13px] text-text-muted">
      {{ steps }} tool call{{ steps === 1 ? '' : 's' }}<template v-if="running && latest"> · {{ latest }}</template>
    </div>
    <div v-if="open" class="space-y-1 border-t border-border px-3 py-2">
      <p v-if="prompt" class="line-clamp-3 whitespace-pre-wrap text-[13px] leading-5 text-text-muted">{{ prompt }}</p>
      <div v-if="kids.length" class="flex flex-col gap-2 border-l border-border pl-3">
        <template v-for="r in kidRows" :key="r.id">
          <ToolGroup v-if="r.kind === 'tools'" :id="r.id" :items="r.items" />
          <BrowserCard v-else-if="r.kind === 'browser'" :item="r.items[r.items.length - 1]" :run="r.items" />
          <!-- A nested row is drawn by the TranscriptRow that holds this card, so the two do not import each other. -->
          <slot v-else-if="r.kind === 'item'" name="row" :item="r.item" />
        </template>
      </div>
      <p v-else-if="running" class="text-[13px] text-text-muted">Starting…</p>
      <div v-if="item.result" class="pt-1 text-[13px]">
        <MarkdownBlock v-if="!item.result.isError" :text="item.result.text" />
        <p v-else class="whitespace-pre-wrap text-[13px] text-danger-text">{{ item.result.text }}</p>
      </div>
    </div>
  </div>
</template>
