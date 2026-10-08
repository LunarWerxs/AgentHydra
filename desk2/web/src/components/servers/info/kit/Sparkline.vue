<script setup lang="ts">
import { computed, useId } from 'vue'
import type { ChartPoint } from './kit'

// A small area chart in SVG (no chart library: the window has none, and this is all the pane needs). The x axis is
// time from `from` to `to`; a point is {t, v}, and a null value or a gap longer than `gapMs` breaks the line (the server
// was down or not measured). The SVG stretches to its box (preserveAspectRatio none, strokes kept 1.5px by
// vector-effect), so the last point's dot is an HTML dot over it, never a stretched circle. `thresholds` draw dashed
// lines (an alert rule's limit), `max` fixes the top (else the highest value plus headroom).
const props = withDefaults(
  defineProps<{
    points: ChartPoint[]
    from: number
    to: number
    color: string
    height?: number
    max?: number
    gapMs?: number
    thresholds?: number[]
    /** Read by a screen reader instead of the picture. */
    label: string
  }>(),
  { height: 56, gapMs: 10_000, thresholds: () => [] }
)

const W = 300
const id = useId()
const span = computed(() => Math.max(1, props.to - props.from))
const top = computed(() => {
  if (props.max !== undefined) return Math.max(props.max, 1e-9)
  const vals = props.points.flatMap((p) => (p.v === null ? [] : [p.v]))
  const hi = Math.max(0, ...vals, ...props.thresholds)
  return hi > 0 ? hi * 1.18 : 1
})
const x = (t: number) => ((t - props.from) / span.value) * W
const y = (v: number) => props.height - Math.min(1, Math.max(0, v / top.value)) * (props.height - 3) - 1

/** Runs of points with no break, each drawn as its own line and area. */
const runs = computed(() => {
  const out: { t: number; v: number }[][] = []
  let cur: { t: number; v: number }[] = []
  let last: number | null = null
  for (const p of [...props.points].sort((a, b) => a.t - b.t)) {
    if (p.t < props.from || p.t > props.to) continue
    if (p.v === null || (last !== null && p.t - last > props.gapMs)) {
      if (cur.length) out.push(cur)
      cur = []
    }
    if (p.v !== null) cur.push({ t: p.t, v: p.v })
    last = p.t
  }
  if (cur.length) out.push(cur)
  return out
})
const line = (run: { t: number; v: number }[]) =>
  run.length === 1 ? `M${x(run[0].t) - 1.5},${y(run[0].v)}L${x(run[0].t) + 1.5},${y(run[0].v)}` : run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join('')
const area = (run: { t: number; v: number }[]) => `${line(run)}L${x(run[run.length - 1].t).toFixed(2)},${props.height}L${x(run[0].t).toFixed(2)},${props.height}Z`
const lastPoint = computed(() => {
  const r = runs.value[runs.value.length - 1]
  const p = r?.[r.length - 1]
  return p ? { left: `${(x(p.t) / W) * 100}%`, top: `${y(p.v)}px` } : null
})
</script>

<template>
  <div class="relative w-full" :style="{ height: `${height}px` }" role="img" :aria-label="label">
    <svg class="absolute inset-0 size-full overflow-visible" :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient :id="`${id}-fill`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.28" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line v-for="f in [0.5]" :key="f" x1="0" :x2="W" :y1="height * f" :y2="height * f" stroke="var(--border)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
      <line x1="0" :x2="W" :y1="height - 0.5" :y2="height - 0.5" stroke="var(--border)" vector-effect="non-scaling-stroke" />
      <line
        v-for="(th, i) in thresholds"
        :key="`th${i}`"
        x1="0"
        :x2="W"
        :y1="y(th)"
        :y2="y(th)"
        stroke="var(--warning)"
        stroke-opacity="0.75"
        stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"
      />
      <template v-for="(run, i) in runs" :key="i">
        <path :d="area(run)" :fill="`url(#${id}-fill)`" />
        <path :d="line(run)" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </template>
    </svg>
    <span
      v-if="lastPoint"
      class="pointer-events-none absolute size-1.75 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_var(--bg-panel)]"
      :style="{ ...lastPoint, background: color }"
      aria-hidden="true"
    />
  </div>
</template>
