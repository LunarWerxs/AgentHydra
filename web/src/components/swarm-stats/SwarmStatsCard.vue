<script setup lang="ts">
// Shared HSwarm stats card. Mounted by the Instances landing, the CliMayte tab and Analytics; the
// parent wires `open` to the HSwarm tab (tabs here are a ref, not a URL). Numbers come from
// lib/swarm-stats.ts, which polls once per `days` however many cards are mounted.
import { CloudOff } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { sparklineSeries, useSwarmStats } from '@/lib/swarm-stats'
import { money, useSwarmTiles } from '@/lib/swarm-tiles'

const props = withDefaults(defineProps<{ compact?: boolean; days?: number }>(), {
  compact: false,
  days: 14,
})
defineEmits<{ open: [] }>()

const { t } = useI18n()
const { stats, loading, offline } = useSwarmStats(props.days)

const series = computed(() => sparklineSeries(stats.value?.days ?? []))
const peak = computed(() => Math.max(1, ...series.value.map((p) => p.value ?? 0)))
const fromHistory = computed(() => stats.value?.source === 'zswarm')
const { tiles } = useSwarmTiles(stats)
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
