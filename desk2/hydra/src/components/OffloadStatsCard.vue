<script setup lang="ts">
// The CliMayte tab's one stats card: what was offloaded, to CliMayte (its tasks, runs and tokens) and
// to HSwarm (what it saved), side by side when there is room and stacked when narrow, with "What
// works" under them as a small pass/fail bar chart per model; the per-kind list opens from it. HSwarm
// numbers come from lib/swarm-stats.ts (shared with SwarmStatsCard.vue); the source note is the
// stats' own `source`.
import { ChevronRight, CloudOff } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import CliMayteScoreList from '@/components/CliMayteScoreList.vue'
import PassFailBars from '@/components/charts/PassFailBars.vue'
import { Badge } from '@/components/ui/badge'
import type { CliMayteScorecard, CliMayteTotals } from '@/lib/api'
import { CLIMAYTE_OUTCOME, modelName, tokenTotal } from '@/lib/climayte-status'
import { formatTokens, formatUsd, useKitSourceTokens } from '@/lib/kit'
import { useSwarmStats } from '@/lib/swarm-stats'
import { useSwarmTiles } from '@/lib/swarm-tiles'

const props = defineProps<{ totals: CliMayteTotals | null; scorecard: CliMayteScorecard | null }>()
defineEmits<{ open: [] }>()

const { t } = useI18n()
const { stats, loading, offline } = useSwarmStats(14)
const { tiles } = useSwarmTiles(stats)
const kitTokens = useKitSourceTokens('climayte')
/** The kit's all-time CliMayte tokens; the totals feed's sum until the kit has them. */
const tokensShown = computed(
  () => kitTokens.value ?? (props.totals ? tokenTotal(props.totals.tokens) : 0),
)
const fromHistory = computed(() => stats.value?.source === 'zswarm')

/** "39 done, 23 handed off, ...": a run is any start of the CLI, so the count alone read as that
 *  many sessions (owner, 2026-09-30, about "99 CLI sessions"). */
const runsLine = computed(() => {
  const by = props.totals?.runsByOutcome
  if (!by) return ''
  const list = (Object.keys(CLIMAYTE_OUTCOME) as (keyof typeof CLIMAYTE_OUTCOME)[])
    .filter((k) => (by[k] ?? 0) > 0)
    .sort((a, b) => (by[b] ?? 0) - (by[a] ?? 0))
    .map((k) => `${by[k]} ${t(CLIMAYTE_OUTCOME[k].label).toLowerCase()}`)
    .join(', ')
  return t('climayte.offloadedRuns', { list })
})
const totalsHint = computed(() => {
  const x = props.totals
  if (!x) return ''
  return (
    t('climayte.offloadedHint', {
      runs: runsLine.value,
      sessions: x.cliSessions ?? x.sessions,
      input: formatTokens(x.tokens.input),
      output: formatTokens(x.tokens.output),
      cacheRead: formatTokens(x.tokens.cacheRead),
      cacheWrite: formatTokens(x.tokens.cacheWrite),
      cost: formatUsd(x.costUsd),
    }) +
    (x.rereadShare
      ? ` ${t('climayte.offloadedReread', { share: x.rereadShare, pct: x.rereadPct })}`
      : '')
  )
})

/** One bar per model, summed over kinds and efforts. */
const modelRows = computed(() => {
  const map = new Map<
    string,
    { key: string; label: string; pass: number; fail: number; slip: number; rework: number; failed: number; excluded: number }
  >()
  for (const r of props.scorecard?.rows ?? []) {
    const key = r.model ?? ''
    const row = map.get(key) ?? {
      key,
      label: r.model ? modelName(r.model) : t('climayte.runDefault'),
      pass: 0,
      fail: 0,
      slip: 0,
      rework: 0,
      failed: 0,
      excluded: 0,
    }
    row.pass += r.pass
    row.fail += r.fail
    row.slip += r.slip ?? 0
    row.rework += r.rework ?? 0
    row.failed += r.failed ?? r.fail
    row.excluded += r.excluded ?? 0
    map.set(key, row)
  }
  // Pooled from the counts, never by averaging the rows' scores.
  return [...map.values()].map((row) => ({
    ...row,
    credit: row.pass + (row.slip * 2) / 3 + row.rework / 3,
    hint: t('climayte.scoreModelHint', row),
  }))
})
const listOpen = ref(false)
</script>

<template>
  <div class="@container flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2">
    <div class="grid grid-cols-1 gap-x-6 gap-y-1.5 @2xl:grid-cols-2">
      <section class="flex min-w-0 flex-col gap-1" :aria-label="$t('climayte.title')">
        <h3 class="text-xs font-semibold">{{ $t('climayte.title') }}</h3>
        <p
          v-if="totals && totals.tasks > 0"
          class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs"
          :title="totalsHint"
        >
          <span class="whitespace-nowrap">
            <span class="font-semibold tabular-nums">{{ totals.tasks }}</span>
            <span class="ms-1 text-muted-foreground">{{ $t('climayte.offloadedTasks', totals.tasks) }}</span>
          </span>
          <span class="whitespace-nowrap">
            <span class="font-semibold tabular-nums">{{ totals.sessions }}</span>
            <span class="ms-1 text-muted-foreground">{{ $t('climayte.offloadedSessions', totals.sessions) }}</span>
          </span>
          <span class="whitespace-nowrap">
            <span class="font-semibold tabular-nums">{{ formatTokens(tokensShown) }}</span>
            <span class="ms-1 text-muted-foreground">{{ $t('climayte.offloadedTokens') }}</span>
          </span>
          <span class="whitespace-nowrap">
            <span class="font-semibold tabular-nums">{{ formatUsd(totals.costUsd) }}</span>
            <span class="ms-1 text-muted-foreground">{{ $t('climayte.offloadedCost') }}</span>
          </span>
        </p>
        <p v-else class="text-xs text-muted-foreground">{{ $t('climayte.offloadedNone') }}</p>
      </section>

      <section class="flex min-w-0 flex-col gap-1" :aria-label="$t('swarmStats.hswarmTitle')">
        <div class="flex items-center gap-2">
          <button type="button" class="text-xs font-semibold hover:underline" @click="$emit('open')">
            {{ $t('swarmStats.hswarmTitle') }}
          </button>
          <Badge variant="secondary" class="text-[10px] text-muted-foreground">
            {{ fromHistory ? $t('swarmStats.fromZswarm') : $t('swarmStats.fromHswarm') }}
          </Badge>
        </div>
        <div v-if="offline && !stats" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CloudOff class="size-3.5" />
          {{ $t('swarmStats.offline') }}
        </div>
        <p v-else-if="stats?.empty" class="text-xs text-muted-foreground">{{ $t('swarmStats.empty') }}</p>
        <p v-else-if="!stats && loading" class="text-xs text-muted-foreground">
          {{ $t('swarmStats.loading') }}
        </p>
        <div v-else-if="stats" class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
          <span v-for="tile in tiles" :key="tile.key" class="whitespace-nowrap" :title="tile.hint">
            <span class="text-muted-foreground">{{ tile.label }}</span>
            <span class="ms-1 font-semibold tabular-nums">{{ tile.value }}</span>
          </span>
        </div>
      </section>
    </div>

    <!-- What works: a bar per model; the button opens the per-kind list. -->
    <div v-if="scorecard" class="flex flex-col gap-1 border-t pt-1.5">
      <button
        type="button"
        class="group flex items-center gap-1.5 rounded-md text-start text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-expanded="listOpen"
        :title="$t('climayte.scoreHint')"
        @click="listOpen = !listOpen"
      >
        <ChevronRight
          class="size-3.5 shrink-0 text-muted-foreground transition-transform"
          :class="listOpen ? 'rotate-90' : ''"
          aria-hidden="true"
        />
        <span class="font-medium">{{ $t('climayte.scoreTitle') }}</span>
        <span v-if="!modelRows.length" class="text-muted-foreground">{{ $t('climayte.scoreNone') }}</span>
      </button>
      <PassFailBars
        v-if="modelRows.length"
        :rows="modelRows"
        :limit="6"
        :more-label="(n: number) => $t('climayte.scoreMoreModels', { n })"
        class="cursor-pointer"
        @click="listOpen = !listOpen"
      />
      <CliMayteScoreList v-if="listOpen" :scorecard="scorecard" />
    </div>
  </div>
</template>
