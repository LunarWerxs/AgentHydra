<script setup lang="ts">
// Where the tokens went, as one stacked bar plus a readout.
//
// A stacked bar rather than four separate ones because the question is "what SHARE of my volume was
// cached", and a share is what a stack shows. The four categories cost wildly different amounts per
// token, so the bar deliberately does NOT imply cost: the caption says what it measures, and the
// dollar figures live in the charts below it.
//
// The segments carry a 2px surface gap between them, which keeps two adjacent fills legible without
// a border that would darken the whole bar.
import { computed } from 'vue'
import type { TokenBreakdown } from '@/lib/api'
import { formatCompact } from '@/lib/format'

const props = defineProps<{ tokens: TokenBreakdown }>()

/** Fixed order and a fixed colour per category, so a category never changes hue because another is
 *  empty — the same "colour follows the entity" rule the model chart uses. */
const PARTS = [
  { key: 'input', labelKey: 'analytics.tokenInput', color: 'var(--viz-1)' },
  { key: 'cacheRead', labelKey: 'analytics.tokenCacheRead', color: 'var(--viz-3)' },
  { key: 'cacheWrite', labelKey: 'analytics.tokenCacheWrite', color: 'var(--viz-5)' },
  { key: 'output', labelKey: 'analytics.tokenOutput', color: 'var(--viz-2)' },
] as const

const rows = computed(() => {
  const total = props.tokens.total || 1
  return PARTS.map((p) => {
    const value = props.tokens[p.key]
    return { ...p, value, pct: (value / total) * 100 }
  })
})

/** A share that rounds to zero but is not zero says "<0.1%" rather than "0%": on a real store the
 *  fresh-input share is genuinely tiny, and rounding it away would hide the point. */
const share = (pct: number, value: number) =>
  pct < 0.1 && value > 0 ? '<0.1%' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`
</script>

<template>
  <div class="space-y-2">
    <div class="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
      <div
        v-for="r in rows"
        :key="r.key"
        class="h-full first:rounded-l-full last:rounded-r-full"
        :style="{ width: `${Math.max(r.value > 0 ? 0.5 : 0, r.pct)}%`, background: r.color }"
        :title="`${$t(r.labelKey)}: ${formatCompact(r.value)}`"
      ></div>
    </div>
    <!-- A legend is always present for four series, and every row is directly labelled with its own
         number too, so identity is never carried by colour alone. -->
    <dl class="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
      <div v-for="r in rows" :key="r.key" class="min-w-0">
        <dt class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span class="size-2 shrink-0 rounded-[2px]" :style="{ background: r.color }"></span>
          <span class="truncate">{{ $t(r.labelKey) }}</span>
        </dt>
        <dd class="pl-3.5 text-sm font-medium tabular-nums">
          {{ formatCompact(r.value) }}
          <span class="text-[11px] font-normal text-muted-foreground">
            {{ share(r.pct, r.value) }}
          </span>
        </dd>
      </div>
    </dl>
  </div>
</template>
