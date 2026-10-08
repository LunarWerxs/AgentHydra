<script setup lang="ts">
// A compact per-hour stacked bar strip for the landing page: one column per hour, segments stacked
// by series, a native tooltip per column. HTML flex columns instead of SVG so the bars stretch with
// the card without distorting. The bars start at zero and share one scale.
import { computed } from 'vue'

const props = defineProps<{
  /** Oldest hour first; `values` is one number per series, in `series` order. */
  hours: Array<{ label: string; values: number[] }>
  series: Array<{ key: string; label: string; color: string }>
  heightClass?: string
  /** How every number it prints is written (the max label and each tip); the plain number when absent. */
  formatValue?: (n: number) => string
}>()

const totals = computed(() => props.hours.map((h) => h.values.reduce((a, b) => a + b, 0)))
const max = computed(() => Math.max(1, ...totals.value))
const fmt = (n: number) => (props.formatValue ? props.formatValue(n) : String(n))
const tip = (i: number) => {
  const h = props.hours[i]
  if (!h) return ''
  return `${h.label}: ${props.series.map((s, k) => `${fmt(h.values[k] ?? 0)} ${s.label}`).join(', ')}`
}
</script>

<template>
  <div>
    <div class="flex items-end gap-px border-b border-border" :class="heightClass ?? 'h-20'">
      <div
        v-for="(h, i) in hours"
        :key="i"
        class="flex h-full min-w-0 flex-1 flex-col-reverse"
        :title="tip(i)"
      >
        <template v-for="(s, k) in series" :key="s.key">
          <div
            v-if="(h.values[k] ?? 0) > 0"
            class="h-(--bar-h) min-h-0.5 w-full bg-(--bar-c) first:rounded-b-xs last:rounded-t-xs"
            :style="{ '--bar-h': `${((h.values[k] ?? 0) / max) * 100}%`, '--bar-c': s.color }"
          ></div>
        </template>
      </div>
    </div>
    <div class="mt-0.5 flex justify-between text-3xs text-muted-foreground tabular-nums">
      <span>{{ hours[0]?.label }}</span>
      <span>↑{{ fmt(max) }}</span>
      <span>{{ hours[hours.length - 1]?.label }}</span>
    </div>
  </div>
</template>
