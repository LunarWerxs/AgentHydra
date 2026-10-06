<script setup lang="ts">
// A compact ranked list of stacked passed/failed bars, one per entity (e.g. per model). The bar is
// scaled to the busiest row, so lengths compare; green is passed, red is failed, and the counts and
// pass share are printed at the end of the row, so colour is never the only signal.
import { computed } from 'vue'

const props = defineProps<{
  rows: Array<{
    key: string
    label: string
    pass: number
    fail: number
    credit?: number
    hint?: string
  }>
  /** Shown beside the rows past `limit`, e.g. "3 more". */
  moreLabel?: (n: number) => string
  limit?: number
}>()

const sorted = computed(() =>
  [...props.rows].sort(
    (a, b) => b.pass + b.fail - (a.pass + a.fail) || a.label.localeCompare(b.label),
  ),
)
const shown = computed(() => (props.limit ? sorted.value.slice(0, props.limit) : sorted.value))
const hidden = computed(() => sorted.value.length - shown.value.length)
const max = computed(() => Math.max(1, ...sorted.value.map((r) => r.pass + r.fail)))
// `credit` (default: pass) is the weighted pass count, so a small fix counts for most of a pass.
const credit = (r: { pass: number; credit?: number }) => r.credit ?? r.pass
const share = (r: { pass: number; fail: number; credit?: number }) => {
  const n = r.pass + r.fail
  return n ? Math.round((credit(r) / n) * 100) : 0
}
</script>

<template>
  <ul class="flex flex-col gap-1 text-2xs">
    <li v-for="r in shown" :key="r.key" class="flex items-center gap-2" :title="r.hint">
      <span class="w-20 shrink-0 truncate text-muted-foreground" :title="r.label">{{ r.label }}</span>
      <div class="flex h-2 min-w-0 flex-1 items-center">
        <div
          class="flex h-full overflow-hidden rounded-full bg-muted"
          :style="{ width: `${Math.max(4, ((r.pass + r.fail) / max) * 100)}%` }"
        >
          <div class="h-full bg-success" :style="{ flexGrow: credit(r) }" />
          <div class="h-full bg-destructive" :style="{ flexGrow: r.pass + r.fail - credit(r) }" />
        </div>
      </div>
      <span class="shrink-0 tabular-nums">
        <span class="text-success">{{ r.pass }}</span>/<span class="text-destructive">{{ r.fail }}</span>
        <span class="ms-1 text-muted-foreground">{{ share(r) }}%</span>
      </span>
    </li>
    <li v-if="hidden > 0 && moreLabel" class="text-muted-foreground">{{ moreLabel(hidden) }}</li>
  </ul>
</template>
