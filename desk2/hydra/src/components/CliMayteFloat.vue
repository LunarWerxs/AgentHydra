<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import SideListRow from '@/components/side-list/SideListRow.vue'
import type { CliMayteWorkerView } from '@/lib/api'
import { isCliMayteActive, modelName } from '@/lib/climayte-status'

const props = withDefaults(
  defineProps<{
    workers: CliMayteWorkerView[]
    now: number
    onRowClick?: (workerId: string) => void
  }>(),
  {
    onRowClick: undefined,
  },
)

const { t } = useI18n()

const running = computed(() =>
  props.workers.filter((w) => w.status === 'running' || w.status === 'checking'),
)

const queued = computed(() =>
  props.workers.filter(
    (w) => isCliMayteActive(w) && w.status !== 'running' && w.status !== 'checking',
  ),
)

const totalActive = computed(() => running.value.length + queued.value.length)

const activeS = (w: CliMayteWorkerView): number => {
  const listedAt = props.now
  return w.ranS + (w.status === 'running' ? Math.max(0, (props.now - listedAt) / 1000) : 0)
}

function activeLabel(totalS: number): string {
  const m = Math.floor(totalS / 60)
  if (m < 1) return t('climayte.activeSeconds', { s: Math.floor(totalS) })
  if (m < 60) return t('climayte.activeMinutes', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('climayte.activeHours', { h, m: m % 60 })
  return t('climayte.activeDays', { d: Math.floor(h / 24), h: h % 24 })
}

function runTag(w: CliMayteWorkerView): { text: string } | null {
  const model = w.model ? modelName(w.model) : t('climayte.runDefault')
  const effort = w.effort ?? t('climayte.runDefault')
  return {
    text: [model, effort].join(' · '),
  }
}

function handleRowClick(workerId: string) {
  props.onRowClick?.(workerId)
}
</script>

<template>
  <div class="flex h-full flex-col bg-sidebar text-sm">
    <!-- Header with counts -->
    <div class="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium">
      <span>{{ $t('climayte.floatRunning', running.length) }}</span>
      <span class="text-muted-foreground">{{ $t('climayte.floatQueued', queued.length) }}</span>
    </div>

    <!-- Task list -->
    <div class="scroll-slim flex-1 overflow-y-auto divide-y border-border">
      <template v-if="totalActive > 0">
        <!-- Running tasks -->
        <template v-for="w in running" :key="w.id">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            @click="handleRowClick(w.id)"
          >
            <CliMayteStatusBadge :status="w.status" icon-only :task="w" :tasks="workers" />
            <span class="flex min-w-0 flex-1 items-center gap-1">
              <span class="min-w-0 truncate font-medium">{{ w.title }}</span>
            </span>
            <span v-if="runTag(w)" class="shrink-0 truncate text-2xs text-muted-foreground">
              {{ runTag(w)?.text }}
            </span>
            <span class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
              {{ activeLabel(activeS(w)) }}
            </span>
          </button>
        </template>

        <!-- Queued tasks -->
        <template v-for="w in queued" :key="w.id">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            @click="handleRowClick(w.id)"
          >
            <CliMayteStatusBadge :status="w.status" icon-only :task="w" :tasks="workers" />
            <span class="flex min-w-0 flex-1 items-center gap-1">
              <span class="min-w-0 truncate font-medium">{{ w.title }}</span>
            </span>
            <span v-if="runTag(w)" class="shrink-0 truncate text-2xs text-muted-foreground">
              {{ runTag(w)?.text }}
            </span>
            <span class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
              {{ activeLabel(activeS(w)) }}
            </span>
          </button>
        </template>
      </template>

      <div v-else class="flex items-center justify-center px-3 py-6 text-xs text-muted-foreground">
        {{ $t('climayte.floatEmpty') }}
      </div>
    </div>
  </div>
</template>
