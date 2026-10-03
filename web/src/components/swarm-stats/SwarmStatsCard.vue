<script setup lang="ts">
// Shared ZSwarm stats card. Mounted by the Instances landing, the CliMayte tab and Analytics; the
// parent wires `open` to the HSwarm tab (tabs here are a ref, not a URL). Numbers come from
// lib/swarm-stats.ts, which polls once per `days` however many cards are mounted.
import { CloudOff } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { formatCompact, formatUsd } from '@/lib/format'
import { lastDaysSaved, sparklineSeries, useSwarmStats } from '@/lib/swarm-stats'

const props = withDefaults(defineProps<{ compact?: boolean; days?: number }>(), {
  compact: false,
  days: 14,
})
defineEmits<{ open: [] }>()

const { t } = useI18n()
const { stats, loading, offline } = useSwarmStats(props.days)

const week = computed(() => lastDaysSaved(stats.value?.days ?? [], 7))
const series = computed(() => sparklineSeries(stats.value?.days ?? []))
const peak = computed(() => Math.max(1, ...series.value.map((p) => p.value ?? 0)))
const fromHistory = computed(() => stats.value?.source === 'zswarm')

const money = (n: number | null | undefined) => (n == null ? '—' : formatUsd(n))
const count = (n: number | null | undefined) => (n == null ? '—' : formatCompact(n))

const tiles = computed(() => [
  { key: 'today', label: t('swarmStats.savedToday'), value: money(stats.value?.today.saved_usd) },
  {
    key: 'week',
    label: t('swarmStats.saved7d'),
    value: money(week.value.sum),
    hint:
      week.value.sum !== null && week.value.measured < week.value.total
        ? t('swarmStats.measuredDays', { n: week.value.measured, total: week.value.total })
        : undefined,
  },
  { key: 'all', label: t('swarmStats.savedAllTime'), value: money(stats.value?.total.saved_usd) },
  { key: 'tasks', label: t('swarmStats.tasksToday'), value: count(stats.value?.today.tasks) },
  { key: 'tokens', label: t('swarmStats.tokensKept'), value: count(stats.value?.today.est_tokens) },
])
</script>

<template>
  <div
    class="rounded-lg border border-border bg-card px-3 py-2"
    :class="compact ? 'flex items-center gap-4' : 'space-y-1.5'"
  >
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="text-xs font-semibold hover:underline"
        @click="$emit('open')"
      >
        {{ t('swarmStats.title') }}
      </button>
      <Badge v-if="fromHistory" variant="secondary" class="text-[10px] text-muted-foreground">
        {{ t('swarmStats.fromZswarm') }}
      </Badge>
    </div>

    <div v-if="offline && !stats" class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CloudOff class="size-3.5" />
      {{ t('swarmStats.offline') }}
    </div>
    <div v-else-if="stats?.empty" class="text-xs text-muted-foreground">
      {{ t('swarmStats.empty') }}
    </div>
    <div v-else-if="!stats && loading" class="text-xs text-muted-foreground">
      {{ t('swarmStats.loading') }}
    </div>
    <template v-else-if="stats">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
        <span v-for="tile in tiles" :key="tile.key" class="whitespace-nowrap" :title="tile.hint">
          <span class="text-muted-foreground">{{ tile.label }}</span>
          <span class="ml-1 font-semibold tabular-nums">{{ tile.value }}</span>
        </span>
      </div>
      <div v-if="!compact && series.length" class="flex h-6 items-end gap-px">
        <div
          v-for="p in series"
          :key="p.day"
          class="flex-1 rounded-sm bg-primary/40"
          :class="p.value === null ? 'bg-muted' : ''"
          :style="{ height: `${p.value === null ? 8 : Math.max(8, (Math.max(p.value, 0) / peak) * 100)}%` }"
          :title="`${p.day}: ${money(p.value)}`"
        />
      </div>
    </template>
  </div>
</template>
