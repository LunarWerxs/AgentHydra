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
  <div v-if="visible" class="flex flex-col gap-1.5 text-[13px] leading-[19px]" aria-label="Hydra Desk status">
    <div class="flex h-6 items-center gap-[5px]">
      <button
        v-if="pending > 0"
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-[var(--radius-6)] bg-[var(--warning-bg)] px-[7px] text-[var(--warning-text)] transition-[filter] duration-[60ms] hover:brightness-125"
        @click="emit('show-pending')"
      >
        <span class="size-1.5 animate-[var(--animate-dot-pulse)] rounded-full bg-[var(--warning)]" />
        {{ pending === 1 ? 'Waiting for you' : `${pending} waiting for you` }}
      </button>
      <Tip v-if="queued > 0" :label="`Sent while Claude was working; ${queued === 1 ? 'it runs' : 'they run'} when the turn ends`" side="top">
        <span
          class="tnum flex h-6 items-center rounded-[var(--radius-6)] bg-[var(--fill-5)] px-[7px] text-[var(--text-2)] shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {{ queued }} queued
        </span>
      </Tip>
    </div>
  </div>
</template>
