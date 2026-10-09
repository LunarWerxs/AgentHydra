<script setup lang="ts">
// A reply the ReDesign card sent ("ReDesign: more options please."), shown as a compact chip on the person's side
// instead of a text bubble. The message itself is unchanged: the AI still receives the full text.
import { LayoutGrid } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import type { ReplyChip } from '../lib/redesign'

defineProps<{ chip: ReplyChip; ts: number }>()
</script>

<template>
  <div class="flex justify-end" data-redesign-chip>
    <Tip :label="new Date(ts).toLocaleString()">
      <span class="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-fill-hover px-2.5 py-1 text-[13px] text-text">
        <LayoutGrid class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ chip.label }}</span>
      </span>
    </Tip>
  </div>
</template>
