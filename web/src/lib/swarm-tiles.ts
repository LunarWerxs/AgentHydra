// The HSwarm stat tiles (saved today / 7 days / all time, tasks and tokens today), shared by the
// plain card (SwarmStatsCard.vue) and the combined CliMayte + HSwarm card (OffloadStatsCard.vue).
import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCompact, formatUsd } from '@/lib/format'
import { lastDaysSaved, type SwarmStatsData } from '@/lib/swarm-stats'

export const money = (n: number | null | undefined) => (n == null ? '—' : formatUsd(n))
export const count = (n: number | null | undefined) => (n == null ? '—' : formatCompact(n))

export function useSwarmTiles(stats: Ref<SwarmStatsData | null>) {
  const { t } = useI18n()
  const week = computed(() => lastDaysSaved(stats.value?.days ?? [], 7))
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
    {
      key: 'tokens',
      label: t('swarmStats.tokensKept'),
      value: count(stats.value?.today.est_tokens),
    },
  ])
  return { tiles, week }
}
