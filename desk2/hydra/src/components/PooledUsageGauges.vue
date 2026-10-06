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

const props = defineProps<{
  session: PooledRemaining
  week: PooledRemaining
  /** Grey while plenty is left (the Instances landing's one-focus page, owner 2026-10-05): the week
   *  bar takes a colour only once the pool runs low. Off, every caller keeps the green week bar. */
  gray?: boolean
}>()

const { t } = useI18n()

/** The week bar's tone: the pool's used share (100 - left) through usageBadgeVariant, the one rule
 *  the accounts rows use too; `gray` turns the all-clear green into neutral. */
function weekVariant(week: PooledRemaining) {
  if (week.pct === null) return 'neutral'
  const tone = usageBadgeVariant(100 - week.pct)
  return props.gray && tone === 'success' ? 'neutral' : tone
}

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
          :variant="weekVariant(week)"
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
