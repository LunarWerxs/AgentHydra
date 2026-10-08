<script setup lang="ts">
// Hydra Desk's own row in the composer dock (not in the real app): what needs you (pending requests)
// and what is queued. The CliMayte workers count lives under the last message instead, in the real
// app's place (tasks/RunningTasksRow.vue) (owner, 2026-10-05: "That's not great placement").
import { computed } from 'vue'
import { Tip } from '@/components/ui/tooltip'

const props = defineProps<{
  pending: number
  queued: number
}>()
const emit = defineEmits<{ 'show-pending': [] }>()

const visible = computed(() => props.pending > 0 || props.queued > 0)
</script>

<template>
  <div v-if="visible" class="flex flex-col gap-1.5 text-[13px] leading-4.75" aria-label="Hydra Desk status">
    <div class="flex h-6 items-center gap-1.25">
      <button
        v-if="pending > 0"
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-(--radius-6) bg-(--warning-bg) px-1.75 text-(--warning-text) transition-[filter] duration-60 hover:brightness-125"
        @click="emit('show-pending')"
      >
        <span class="size-1.5 animate-(--animate-dot-pulse) rounded-full bg-(--warning)" />
        {{ pending === 1 ? 'Waiting for you' : `${pending} waiting for you` }}
      </button>
      <Tip v-if="queued > 0" :label="`Sent while Claude was working; ${queued === 1 ? 'it runs' : 'they run'} when the turn ends`" side="top">
        <span
          class="tnum flex h-6 items-center rounded-(--radius-6) bg-(--fill-5) px-1.75 text-(--text-2) shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {{ queued }} queued
        </span>
      </Tip>
    </div>
  </div>
</template>
