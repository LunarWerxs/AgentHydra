<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUpRight } from '@lucide/vue'
import { useClock } from '@/lib/clock'
import { icons } from '@/lib/icons'

const Square = icons.stop
import type { CliMayteWorker } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { chatWorkers } from './dock'
import { Tip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{
  originSessionId?: string | null
  workerIds?: readonly string[]
}>()

const desk = useDesk()
const showOnlyThisChat = ref(false)

const filteredWorkers = computed(() => {
  const workers = desk.workers.value
  if (!showOnlyThisChat.value || !props.originSessionId) {
    return workers
  }
  return chatWorkers(workers, props.originSessionId, props.workerIds)
})

const activeWorkers = computed(() => {
  return filteredWorkers.value.filter((w) => w.active)
})

const finishedWorkers = computed(() => {
  return filteredWorkers.value.filter((w) => !w.active).slice(0, 20)
})

const groupedActive = computed(() => {
  const groups = new Map<string | null, CliMayteWorker[]>()
  for (const worker of activeWorkers.value) {
    const group = worker.group
    if (!groups.has(group)) {
      groups.set(group, [])
    }
    groups.get(group)!.push(worker)
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items }))
})

const now = useClock(1000)

const elapsedTime = (worker: CliMayteWorker): string => {
  if (!worker.startedAt) return ''
  const elapsed = Math.max(0, now.value - worker.startedAt)
  const minutes = Math.floor(elapsed / 60000)
  const seconds = Math.floor((elapsed % 60000) / 1000)
  return minutes > 0 ? `${minutes}m` : `${seconds}s`
}

const statusGlyph = (worker: CliMayteWorker): string => {
  const status = worker.status
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'waiting' || status === 'checking') return 'waiting'
  return status
}

const glyphClass = (worker: CliMayteWorker): string => {
  const base = 'shrink-0 w-3 h-3'
  const status = statusGlyph(worker)
  switch (status) {
    case 'running':
      return base + ' animate-spin text-[var(--brand)]'
    case 'waiting':
      return base + ' rounded-full bg-[var(--status-needs-you)] animate-pulse'
    default:
      return base + ' rounded-full bg-[var(--text-muted)]'
  }
}

const cancelErrors = ref(new Map<string, string>())
const cancelTarget = ref<CliMayteWorker | null>(null)

const cancelWorker = async (worker: CliMayteWorker) => {
  cancelErrors.value.delete(worker.id)
  try {
    await desk.cancelWorker(worker.id)
  } catch (err) {
    cancelErrors.value.set(worker.id, `Stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const confirmCancel = () => {
  const worker = cancelTarget.value
  cancelTarget.value = null
  if (worker) void cancelWorker(worker)
}
</script>

<template>
  <div class="flex flex-col h-full bg-(--bg-page)">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-(--border)">
      <div class="flex items-center gap-2">
        <h2 class="text-[13px] font-medium">CliMayte</h2>
        <span class="rounded-(--radius-4) bg-(--fill-secondary) px-1 text-[11px] leading-4 text-(--text-2)">
          {{ activeWorkers.length }}
        </span>
      </div>
      <label v-if="originSessionId" class="flex items-center gap-2 text-[12px]">
        <input
          v-model="showOnlyThisChat"
          type="checkbox"
          class="rounded"
        />
        <span>This chat only</span>
      </label>
    </div>

    <!-- Workers list -->
    <div class="flex-1 overflow-y-auto">
      <!-- Active workers grouped -->
      <div v-if="activeWorkers.length > 0">
        <div v-for="group in groupedActive" :key="group.group || 'ungrouped'" class="border-b border-(--border) last:border-b-0">
          <div v-if="group.group" class="px-4 py-2 text-[12px] font-medium text-(--text-muted) bg-(--bg-popover) sticky top-0">
            {{ group.group }}
          </div>
          <div
            v-for="worker in group.items"
            :key="worker.id"
            class="px-4 py-3 border-b border-(--border) last:border-b-0 hover:bg-(--fill-hover)"
          >
            <!-- Worker header with glyph and title -->
            <div class="flex items-start gap-2 mb-2">
              <div :class="glyphClass(worker)" />
              <div class="flex-1 min-w-0">
                <div class="text-[13px] font-medium truncate">{{ worker.title }}</div>
              </div>
              <div class="shrink-0 text-[12px] text-(--text-muted)">
                {{ elapsedTime(worker) }}
              </div>
            </div>

            <!-- Account and model/effort -->
            <div class="flex items-center gap-2 mb-2 text-[12px]">
              <span v-if="worker.account" class="text-(--text-muted)">{{ worker.account }}</span>
              <span v-if="worker.model" class="text-(--text-muted)">{{ worker.model }}</span>
              <span v-if="worker.effort" class="text-(--text-muted)">{{ worker.effort }}</span>
            </div>

            <!-- Progress bar -->
            <div v-if="worker.usedPct !== null" class="mb-2 h-1.5 bg-(--slider-track) rounded-full overflow-hidden">
              <div
                class="h-full bg-(--brand)"
                :style="{ width: `${Math.min(worker.usedPct, 100)}%` }"
              />
            </div>

            <!-- Last activity -->
            <div v-if="worker.lastActivity" class="text-[12px] text-(--text-muted) mb-2 truncate">
              {{ worker.lastActivity }}
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-1">
              <Tip :label="'Stop ' + worker.title" side="top">
                <button
                  @click="cancelTarget = worker"
                  class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[12px] bg-(--fill-5) hover:bg-(--fill-hover) rounded-(--radius-6) text-(--text-muted) transition-colors duration-60 hover:text-(--text)"
                >
                  <Square class="size-3.5" />
                  <span class="hidden sm:inline">Stop</span>
                </button>
              </Tip>
              <Tip v-if="worker.sessionId" :label="'Open ' + worker.title" side="top">
                <button
                  @click="desk.select({ kind: 'external', id: worker.sessionId || '' })"
                  class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[12px] bg-(--fill-5) hover:bg-(--fill-hover) rounded-(--radius-6) text-(--text-muted) transition-colors duration-60 hover:text-(--text)"
                >
                  <ArrowUpRight class="size-3.5" />
                  <span class="hidden sm:inline">Open</span>
                </button>
              </Tip>
            </div>
            <p v-if="cancelErrors.get(worker.id)" role="alert" class="mt-2 text-[12px] text-danger-text">{{ cancelErrors.get(worker.id) }}</p>
          </div>
        </div>
      </div>

      <!-- Recently finished -->
      <div v-if="finishedWorkers.length > 0">
        <div class="px-4 py-2 text-[12px] font-medium text-(--text-muted) bg-(--bg-popover) sticky top-0 z-10">
          Recently finished
        </div>
        <div
          v-for="worker in finishedWorkers"
          :key="worker.id"
          class="px-4 py-2 border-b border-(--border) last:border-b-0 hover:bg-(--fill-hover) text-[12px]"
        >
          <div class="flex items-center gap-2 mb-1">
            <span
              v-if="worker.verdict"
              class="inline-block px-1.5 rounded-(--radius-4) leading-4 text-white"
              :class="worker.verdict === 'ok' ? 'bg-(--success)' : 'bg-(--danger)'"
            >
              {{ worker.verdict }}
            </span>
            <span class="truncate">{{ worker.title }}</span>
          </div>
          <div v-if="worker.error" class="text-(--danger-text) text-[12px] truncate">
            {{ worker.error }}
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="activeWorkers.length === 0 && finishedWorkers.length === 0" class="flex items-center justify-center h-full text-(--text-muted)">
        <div class="text-center">
          <p class="text-[13px] font-medium">No workers</p>
          <p class="text-[12px]">{{ showOnlyThisChat ? 'This chat has not dispatched any workers' : 'No active or recent workers' }}</p>
        </div>
      </div>
    </div>
    <Dialog :open="cancelTarget !== null" @update:open="(o: boolean) => !o && (cancelTarget = null)">
      <DialogContent :aria-describedby="undefined">
        <DialogTitle>Stop this worker?</DialogTitle>
        <DialogDescription>Cancel "{{ cancelTarget?.title }}"?</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" @click="cancelTarget = null">Keep running</Button>
          <Button @click="confirmCancel">Stop</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
