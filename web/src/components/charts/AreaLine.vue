<script setup lang="ts">
// A continuous measure over time — how many sessions were running at once — so a line, with a wash
// under it to carry the eye. Straight segments, never a spline: a smoothed curve would invent a
// concurrency between two samples that was never measured.
//
// A crosshair rather than per-point dots: at hourly buckets over a month there are hundreds of
// points, and a marker on each is noise. One series, so no legend.
import { computed, ref } from 'vue'
import { areaPath, axisMax, linePath, ticks } from '@/lib/chart'

const props = defineProps<{
  points: Array<{ at: number; value: number }>
  format: (n: number) => string
  labelAt: (ms: number) => string
}>()

const W = 720
const H = 150
const PAD_L = 34
const PAD_B = 16
const plotH = H - PAD_B

const max = computed(() => axisMax(Math.max(0, ...props.points.map((p) => p.value))))
const axisTicks = computed(() => ticks(max.value))
const xy = computed(() => {
  const n = Math.max(1, props.points.length - 1)
  return props.points.map((p, i) => ({
    x: PAD_L + (i / n) * (W - PAD_L),
    y: plotH - (p.value / max.value) * plotH,
  }))
})
const hover = ref<number | null>(null)

function onMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  if (rect.width === 0 || props.points.length === 0) return
  const rel = ((e.clientX - rect.left) / rect.width) * W
  const n = Math.max(1, props.points.length - 1)
  const i = Math.round(((rel - PAD_L) / (W - PAD_L)) * n)
  hover.value = Math.min(props.points.length - 1, Math.max(0, i))
}
</script>

<template>
  <div class="w-full overflow-x-auto">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="h-[150px] w-full min-w-[420px]"
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
  <p class="h-4 text-[11px] text-muted-foreground">
    <span v-if="hover !== null && points[hover]">
      {{ labelAt(points[hover]?.at ?? 0) }} · {{ format(points[hover]?.value ?? 0) }}
    </span>
  </p>
</template>
