<script setup lang="ts">
// Change over time in discrete buckets — a day, an hour — so bars, not a line: a line implies the
// value existed between the points, and "spend on Tuesday" does not.
//
// One series, so no legend: the caption above the chart names it. Hovering a bar shows its exact
// value, because the axis is deliberately sparse and reading a value off it is not the job.
import { useElementSize } from '@vueuse/core'
import { computed, ref } from 'vue'
import ChartTip from '@/components/charts/ChartTip.vue'
import { axisMax, ticks } from '@/lib/chart'

const props = defineProps<{
  points: Array<{ key: string; label: string; value: number }>
  format: (n: number) => string
  /** Axis tick text. Defaults to `format`. */
  axisFormat?: (n: number) => string
  valueLabel: string
  shareLabel: string
  peakLabel: string
}>()

// Sized from the container for the same reason AreaLine is: a fixed viewBox in a wider element is
// letterboxed, which wastes the card and makes any pointer maths in element space wrong.
const wrap = ref<HTMLElement | null>(null)
const { width } = useElementSize(wrap)
const W = computed(() => Math.max(320, Math.floor(width.value || 720)))
const H = 168
const PAD_L = 44
const PAD_B = 18
// Headroom for the TOP axis label, whose text is centred on the tick: without it the highest
// label is drawn half outside the viewBox and gets clipped. Caught by looking at the render.
const PAD_T = 8

const max = computed(() => axisMax(Math.max(0, ...props.points.map((p) => p.value))))
const axisTicks = computed(() => ticks(max.value))
const plotW = computed(() => W.value - PAD_L)
const plotH = H - PAD_B
const barW = computed(() => Math.max(1, plotW.value / Math.max(1, props.points.length) - 2))
const xOf = (i: number) => PAD_L + (i * plotW.value) / Math.max(1, props.points.length)
const yOf = (v: number) => PAD_T + (plotH - PAD_T) * (1 - v / max.value)
const fmtAxis = (n: number) => (props.axisFormat ?? props.format)(n)

const hover = ref<number | null>(null)
const tip = ref({ x: 0, y: 0 })

/** The hovered day plus how it sits against the rest, so the card explains rather than repeats. */
const tipRows = computed(() => {
  const i = hover.value
  if (i === null) return []
  const p = props.points[i]
  if (!p) return []
  const values = props.points.map((x) => x.value)
  const total = values.reduce((a, b) => a + b, 0)
  const peak = Math.max(...values)
  const rows = [{ label: props.valueLabel, value: props.format(p.value) }]
  if (total > 0)
    rows.push({ label: props.shareLabel, value: `${((p.value / total) * 100).toFixed(1)}%` })
  rows.push({ label: props.peakLabel, value: props.format(peak) })
  return rows
})

function onEnter(i: number, e: MouseEvent) {
  hover.value = i
  tip.value = { x: e.clientX, y: e.clientY }
}
</script>

<template>
  <div ref="wrap" class="w-full">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="h-40 w-full"
      role="img"
      @mouseleave="hover = null"
    >
      <!-- recessive grid: hairlines at the ticks, nothing else -->
      <g>
        <line
          v-for="t in axisTicks"
          :key="`g${t}`"
          :x1="PAD_L"
          :x2="W"
          :y1="yOf(t)"
          :y2="yOf(t)"
          class="stroke-border"
          stroke-width="1"
        />
        <text
          v-for="t in axisTicks"
          :key="`t${t}`"
          :x="PAD_L - 6"
          :y="yOf(t) + 3"
          text-anchor="end"
          class="fill-muted-foreground text-[9px] tabular-nums"
        >{{ fmtAxis(t) }}</text>
      </g>

      <g>
        <!-- the hit target is the full column height, not the bar: a 2px bar is unhoverable -->
        <rect
          v-for="(p, i) in points"
          :key="`h${p.key}`"
          :x="xOf(i)"
          :y="PAD_T"
          :width="barW + 2"
          :height="plotH - PAD_T"
          fill="transparent"
          @mouseenter="onEnter(i, $event)"
          @mousemove="tip = { x: $event.clientX, y: $event.clientY }"
        />
        <rect
          v-for="(p, i) in points"
          :key="p.key"
          :x="xOf(i)"
          :y="yOf(p.value)"
          :width="barW"
          :height="Math.max(0, plotH - yOf(p.value))"
          rx="2"
          :style="{ fill: 'var(--viz-seq)', opacity: hover === null || hover === i ? 1 : 0.45 }"
        />
      </g>

      <!-- baseline last, so it sits over the bars' feet -->
      <line :x1="PAD_L" :x2="W" :y1="plotH" :y2="plotH" class="stroke-border" stroke-width="1" />
      <text
        v-if="points.length"
        :x="PAD_L"
        :y="H - 4"
        class="fill-muted-foreground text-[9px]"
      >{{ points[0]?.label }}</text>
      <text
        v-if="points.length > 1"
        :x="W"
        :y="H - 4"
        text-anchor="end"
        class="fill-muted-foreground text-[9px]"
      >{{ points[points.length - 1]?.label }}</text>
    </svg>
  </div>
  <ChartTip
    v-if="hover !== null && points[hover]"
    :x="tip.x"
    :y="tip.y"
    :title="points[hover]?.label ?? ''"
    :rows="tipRows"
  />
</template>
