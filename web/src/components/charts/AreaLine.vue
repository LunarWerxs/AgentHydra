<script setup lang="ts">
// A continuous measure over time — how many sessions were running at once — so a line, with a wash
// under it to carry the eye. Straight segments, never a spline: a smoothed curve would invent a
// concurrency between two samples that was never measured.
//
// THE VIEWBOX IS SIZED FROM THE CONTAINER, which fixes two things at once.
//
// A fixed 720-unit viewBox inside a wider element is scaled to fit and CENTRED (`xMidYMid meet` is
// the default), so the drawing sat in the middle with empty margins — and hover maths that mapped
// across the element's full width therefore read every position as further right than it really
// was, by over a hundred pixels at the left edge of a 956px card. The obvious fix,
// `preserveAspectRatio="none"`, makes the x-mapping trivial and DISTORTS EVERY GLYPH in the chart,
// because the axis labels live in that same coordinate space. Measuring the container and drawing
// at exactly that width means one unit is one pixel: nothing is letterboxed, nothing is stretched,
// and the pointer maths is a subtraction.
//
// A crosshair rather than per-point dots: at hourly buckets over a month there are hundreds of
// points, and a marker on each is noise. One series, so no legend.
import { useElementSize } from '@vueuse/core'
import { computed, ref } from 'vue'
import ChartTip from '@/components/charts/ChartTip.vue'
import { areaPath, axisMax, linePath, ticks } from '@/lib/chart'

const props = defineProps<{
  points: Array<{ at: number; value: number }>
  format: (n: number) => string
  labelAt: (ms: number) => string
  valueLabel: string
  changeLabel: string
  peakLabel: string
}>()

const H = 150
const PAD_L = 34
const PAD_B = 16
const plotH = H - PAD_B

const wrap = ref<HTMLElement | null>(null)
const { width } = useElementSize(wrap)
/** One viewBox unit per CSS pixel. Floored so a sub-pixel container cannot produce a fractional
 *  coordinate space, with a sane default before the first measurement lands. */
const W = computed(() => Math.max(320, Math.floor(width.value || 720)))

const max = computed(() => axisMax(Math.max(0, ...props.points.map((p) => p.value))))
const axisTicks = computed(() => ticks(max.value))
const xy = computed(() => {
  const n = Math.max(1, props.points.length - 1)
  return props.points.map((p, i) => ({
    x: PAD_L + (i / n) * (W.value - PAD_L),
    y: plotH - (p.value / max.value) * plotH,
  }))
})

const hover = ref<number | null>(null)
const tip = ref({ x: 0, y: 0 })

/** The neighbouring value as well as the hovered one, so the card says what the line is DOING
 *  rather than only where it is. */
const tipRows = computed(() => {
  const i = hover.value
  if (i === null) return []
  const at = props.points[i]
  if (!at) return []
  const prev = i > 0 ? props.points[i - 1] : null
  const peak = Math.max(...props.points.map((p) => p.value))
  const rows = [{ label: props.valueLabel, value: props.format(at.value) }]
  if (prev) {
    const delta = at.value - prev.value
    rows.push({ label: props.changeLabel, value: `${delta >= 0 ? '+' : ''}${props.format(delta)}` })
  }
  rows.push({ label: props.peakLabel, value: props.format(peak) })
  return rows
})

function onMove(e: MouseEvent) {
  if (props.points.length === 0) return
  const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  if (rect.width === 0) return
  // One unit per pixel, so this is a direct read rather than a scale.
  const local = e.clientX - rect.left
  const n = Math.max(1, props.points.length - 1)
  const i = Math.round(((local - PAD_L) / (W.value - PAD_L)) * n)
  hover.value = Math.min(props.points.length - 1, Math.max(0, i))
  tip.value = { x: e.clientX, y: e.clientY }
}
</script>

<template>
  <!-- No min-width and no overflow: the drawing is sized to the container, so there is nothing to
       scroll and nothing to clip. -->
  <div ref="wrap" class="w-full">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="h-[150px] w-full"
      role="img"
      @mousemove="onMove"
      @mouseleave="hover = null"
    >
      <line
        v-for="t in axisTicks"
        :key="`g${t}`"
        :x1="PAD_L"
        :x2="W"
        :y1="plotH - (t / max) * plotH"
        :y2="plotH - (t / max) * plotH"
        class="stroke-border"
        stroke-width="1"
      />
      <text
        v-for="t in axisTicks"
        :key="`t${t}`"
        :x="PAD_L - 6"
        :y="plotH - (t / max) * plotH + 3"
        text-anchor="end"
        class="fill-muted-foreground text-[9px] tabular-nums"
      >{{ format(t) }}</text>

      <path :d="areaPath(xy, plotH)" :style="{ fill: 'var(--viz-seq)', opacity: 0.14 }" />
      <path
        :d="linePath(xy)"
        fill="none"
        :style="{ stroke: 'var(--viz-seq)' }"
        stroke-width="2"
        stroke-linejoin="round"
      />

      <g v-if="hover !== null && xy[hover]">
        <line
          :x1="xy[hover]?.x"
          :x2="xy[hover]?.x"
          y1="0"
          :y2="plotH"
          class="stroke-muted-foreground"
          stroke-width="1"
          stroke-dasharray="2 2"
        />
        <!-- 2px surface ring so the marker reads against both the line and the fill -->
        <circle
          :cx="xy[hover]?.x"
          :cy="xy[hover]?.y"
          r="4"
          :style="{ fill: 'var(--viz-seq)' }"
          class="stroke-background"
          stroke-width="2"
        />
      </g>
      <line :x1="PAD_L" :x2="W" :y1="plotH" :y2="plotH" class="stroke-border" stroke-width="1" />
    </svg>
  </div>
  <ChartTip
    v-if="hover !== null && points[hover]"
    :x="tip.x"
    :y="tip.y"
    :title="labelAt(points[hover]?.at ?? 0)"
    :rows="tipRows"
  />
</template>
