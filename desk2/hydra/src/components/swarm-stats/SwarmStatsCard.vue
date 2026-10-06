<script setup lang="ts">
// Shared HSwarm stats card, one line: its title and the stat tiles. Mounted by the Instances landing
// (Analytics shows the same numbers in its lead row's HSwarm tile instead, and the per-day savings
// are on the HSwarm tab's savings view); the parent wires `open` to the HSwarm tab (tabs here are a
// ref, not a URL). Numbers come from lib/swarm-stats.ts, which polls once per `days` however many
// cards are mounted.
import { CloudOff } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { useSwarmStats } from '@/lib/swarm-stats'
import { useSwarmTiles } from '@/lib/swarm-tiles'

const props = withDefaults(defineProps<{ days?: number }>(), { days: 14 })
defineEmits<{ open: [] }>()

const { t } = useI18n()
const { stats, loading, offline } = useSwarmStats(props.days)

const fromHistory = computed(() => stats.value?.source === 'zswarm')
const { tiles } = useSwarmTiles(stats)
</script>

<template>
  <div class="flex items-center gap-4 rounded-lg border border-border bg-card px-3 py-2">
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
    <div v-else-if="stats" class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
      <span v-for="tile in tiles" :key="tile.key" class="whitespace-nowrap" :title="tile.hint">
        <span class="text-muted-foreground">{{ tile.label }}</span>
        <span class="ml-1 font-semibold tabular-nums">{{ tile.value }}</span>
      </span>
    </div>
  </div>
</template>
