<script setup lang="ts">
// Two small gauges for a folded accounts table's header: how much of the 5-hour and the weekly
// window is left across its accounts, pooled by plan size (lib/usage-pool.ts). The table's rows say
// this per account; folded, these are all that is left of them (owner, 2026-10-02: "when it's
// collapsed, I can see little gauges that tell me how much is left for each").
//
// The same bar as the rows' quota cells, and the same colour rule: the week carries the colour, the
// 5-hour bar is neutral (UsageBar's UsageBarVariant). Each gauge has a fixed width, so a reading
// that changes never moves the header.
import { useI18n } from 'vue-i18n'
import UsageBar from '@/components/UsageBar.vue'
import { usageBadgeVariant } from '@/lib/usage'
import type { PooledRemaining } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'

defineProps<{ session: PooledRemaining; week: PooledRemaining }>()

const { t } = useI18n()

/** The tooltip's second line: who is not in the number. Absent when everyone is. */
function leftOut(pool: PooledRemaining): string | undefined {
  return pool.signedOut + pool.unread > 0
    ? t('cliInstances.poolLeftOut', { signedOut: pool.signedOut, unread: pool.unread })
    : undefined
}
const counted = (pool: PooledRemaining) => t('cliInstances.poolCounted', { n: pool.counted })
</script>

<template>
  <div class="flex items-center gap-1.5">
    <IconTooltip
      :label="
        session.pct === null
          ? $t('cliInstances.poolSessionNone')
          : $t('cliInstances.poolSessionTip', { pct: session.pct })
      "
      :description="counted(session)"
      :detail="leftOut(session)"
    >
      <div class="w-24 shrink-0">
        <UsageBar
          :fill-pct="session.pct ?? 0"
          variant="neutral"
          :label="
            session.pct === null
              ? $t('cliInstances.poolSessionEmpty')
              : $t('cliInstances.poolSessionLabel', { pct: session.pct })
          "
        />
      </div>
    </IconTooltip>
    <IconTooltip
      :label="
        week.pct === null
          ? $t('cliInstances.poolWeekNone')
          : $t('cliInstances.poolWeekTip', { pct: week.pct })
      "
      :description="counted(week)"
      :detail="leftOut(week)"
    >
      <div class="w-24 shrink-0">
        <UsageBar
          :fill-pct="week.pct ?? 0"
          :variant="week.pct === null ? 'neutral' : usageBadgeVariant(100 - week.pct)"
          :label="
            week.pct === null
              ? $t('cliInstances.poolWeekEmpty')
              : $t('cliInstances.poolWeekLabel', { pct: week.pct })
          "
        />
      </div>
    </IconTooltip>
  </div>
</template>
