<script setup lang="ts">
// Hydra Desk's own row in the composer dock (not in the real app; shaped like its background-tasks
// pill): what needs Jacob (pending requests), what is queued, and a chip for the CliMayte workers
// this chat dispatched ("2 agents running", "1 running, 2 done", "3 agents done"). The chip opens the
// Background tasks panel, which lists them.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronDown } from '@lucide/vue'
import type { CliMayteWorker } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { cleared, openBackgroundTasks } from '@/components/tasks/api'
import { summarizeDock } from './dock'

const props = defineProps<{
  workers: CliMayteWorker[] // this chat's workers only
  climayteActive?: number // ChatSummary.climayteActive, for workers the list has not reported yet
  pending: number
  queued: number
}>()
const emit = defineEmits<{ 'show-pending': [] }>()

const summary = computed(() => summarizeDock(props.workers, props.climayteActive ?? 0, cleared.value))
const visible = computed(() => props.pending > 0 || props.queued > 0 || summary.value.tone !== 'none')

// A worker settling flashes the chip once, so the change is seen with the panel closed.
const flash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => flashTimer && clearTimeout(flashTimer))
watch(
  () => summary.value.done,
  (done, before) => {
    if (before === undefined || done <= before) return
    flash.value = true
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flash.value = false), 2400)
  }
)
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
      <button
        v-if="summary.tone !== 'none'"
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-[var(--radius-6)] bg-[var(--fill-5)] pl-[7px] pr-1 text-[var(--text-2)] shadow-[inset_0_0_0_1px_var(--border)] transition-[background-color,box-shadow] duration-300 hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
        :class="flash ? 'shadow-[inset_0_0_0_1px_var(--success-text)]' : ''"
        aria-haspopup="dialog"
        :data-tone="summary.tone"
        @click="openBackgroundTasks()"
      >
        <span
          class="size-1.5 rounded-full"
          :class="summary.tone === 'done' ? 'bg-[var(--success-text)]' : 'animate-[var(--animate-dot-blink)] bg-[var(--text-muted)]'"
        />
        <span class="tnum">{{ summary.label }}</span>
        <ChevronDown class="size-3 text-[var(--text-muted)]" />
      </button>
    </div>
  </div>
</template>
