<script setup lang="ts">
// The muted '1 running task · 2 finished' line the real app shows under the last message
// (real-running-task-and-attachments.png: 14px #898781, 64px below the status row above it, text at
// the status rows' x). It counts the Background tasks panel's running and finished units for this chat
// and opens the panel; nothing renders when there are neither. When a running worker gave an estimate
// (its `ETA:` line) it also says about how long is left, by the latest one.
import { computed, effectScope, onBeforeUnmount, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { useClock } from '@/lib/clock'
import { cleared, openBackgroundTasks } from './api'
import { latestEtaEnd, panelLists, runningLabel } from './logic'

const props = defineProps<{ chat: ChatSummary; items: TranscriptItem[] }>()
const src = useShellSource()

// Running and finished, as the Background tasks panel lists them for this chat (its CliMayte workers and
// its own background tasks), minus the finished ones cleared there.
const lists = computed(() =>
  panelLists({ workers: src.workers.value, items: props.items, sessionId: props.chat.sessionId, workerIds: props.chat.workerIds, cleared: cleared.value })
)
const etaEndsAt = computed(() => latestEtaEnd(lists.value.running))

// A 15 s clock, only while an estimate is on show: the label counts whole minutes.
const clock = shallowRef<{ now: Readonly<Ref<number>> } | null>(null)
let clockScope: EffectScope | null = null
watch(
  () => etaEndsAt.value !== null,
  (on) => {
    if (on && !clockScope) {
      clockScope = effectScope()
      const tick = clockScope.run(() => useClock(15_000))
      clock.value = tick ? { now: tick } : null
    } else if (!on && clockScope) {
      clockScope.stop()
      clockScope = null
      clock.value = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clockScope?.stop())

const label = computed(() =>
  runningLabel(lists.value.running.length, lists.value.finished.length, { endsAt: etaEndsAt.value, now: clock.value?.now.value ?? Date.now() })
)
</script>

<template>
  <button
    v-if="label"
    type="button"
    class="mt-10 flex h-6 items-center rounded-[6px] px-1 text-[14px] text-[var(--text-muted)] outline-none transition-colors duration-[60ms] hover:text-[var(--text-2)] focus-visible:shadow-[var(--focus-ring)]"
    data-running-tasks
    @click="openBackgroundTasks()"
  >
    {{ label }}
  </button>
</template>
