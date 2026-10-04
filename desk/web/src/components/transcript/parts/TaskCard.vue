<script setup lang="ts">
import { Check, CircleStop, LoaderCircle, X } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'

defineProps<{ item: Extract<TranscriptItem, { kind: 'task' }> }>()
</script>

<template>
  <div class="tx-card flex items-start gap-2 px-3 py-2 text-[14px] leading-5">
    <LoaderCircle v-if="item.status === 'running'" class="mt-0.5 size-3.5 shrink-0 animate-spin text-text-muted" />
    <Check v-else-if="item.status === 'completed'" class="mt-0.5 size-3.5 shrink-0 text-success-text" />
    <X v-else-if="item.status === 'failed'" class="mt-0.5 size-3.5 shrink-0 text-danger-text" />
    <CircleStop v-else class="mt-0.5 size-3.5 shrink-0 text-text-muted" />
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-text">{{ item.description }}</span>
        <span class="ml-auto shrink-0 text-[13px] text-text-muted">Background task · {{ item.status }}</span>
      </div>
      <p v-if="item.summary" class="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[13px] text-text-muted">{{ item.summary }}</p>
    </div>
  </div>
</template>
