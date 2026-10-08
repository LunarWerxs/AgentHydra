<script setup lang="ts">
// Thinking as a status row: "Thinking" shimmering while it streams, "Thought process" after; opens to the text.
import { useTranscript } from '../context'
import StatusRow from './StatusRow.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ id: string; text: string; streaming?: boolean }>()
const ctx = useTranscript()
</script>

<template>
  <div>
    <StatusRow :open="ctx.isOpen(id)" :running="streaming" @toggle="ctx.toggle(props.id)">
      <span :class="streaming && 'tx-shimmer'">{{ streaming ? 'Thinking' : 'Thought process' }}</span>
    </StatusRow>
    <Collapse :open="ctx.isOpen(id)">
      <div class="mb-1 ms-1 mt-1.5 whitespace-pre-wrap border-s border-border ps-3 text-[14px] leading-5 text-text-muted">{{ text }}<span v-if="streaming" class="stream-cursor" /></div>
    </Collapse>
  </div>
</template>
