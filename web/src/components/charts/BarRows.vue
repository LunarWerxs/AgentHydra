<script setup lang="ts">
// A ranked horizontal bar list: the form for "which of these is biggest", where the labels are
// words rather than dates. Horizontal because model ids and project paths are long — a vertical bar
// chart would rotate them to 45 degrees, which is the anti-pattern this avoids by construction.
//
// One value per row and the value printed at the end of it, so there is no axis to read against and
// no legend to match up: the label and the number are already next to the mark.
import { computed } from 'vue'
import { seriesColor } from '@/lib/chart'

const props = defineProps<{
  rows: Array<{ key: string; label: string; value: number; detail?: string }>
  /** Fixed order for colour assignment, so filtering never repaints the survivors. */
  order?: readonly string[]
  /** Rendered value, e.g. money or a compact count. */
  format: (n: number) => string
  /** One hue for every row (magnitude), instead of one per entity (identity). */
  mono?: boolean
}>()

const max = computed(() => Math.max(1, ...props.rows.map((r) => r.value)))
const colorFor = (key: string) =>
  props.mono ? 'var(--viz-seq)' : seriesColor(key, props.order ?? props.rows.map((r) => r.key))
</script>

<template>
  <ul class="space-y-1.5">
    <li v-for="row in rows" :key="row.key" class="group">
      <div class="flex items-baseline justify-between gap-3 text-xs">
        <span class="min-w-0 truncate text-muted-foreground" :title="row.detail ?? row.label">
          {{ row.label }}
        </span>
        <span class="shrink-0 tabular-nums font-medium">{{ format(row.value) }}</span>
      </div>
      <!-- 6px track, 4px rounded end anchored at the baseline: a thin mark, per the mark spec -->
      <div class="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full transition-[width] duration-300"
          :style="{ width: `${Math.max(1.5, (row.value / max) * 100)}%`, background: colorFor(row.key) }"
        ></div>
      </div>
    </li>
  </ul>
</template>
