<script setup lang="ts">
// Hour-of-week: seven rows of twenty-four cells. A heatmap is the right form here because the
// question is "when", and a reader answers it by finding a bright patch, not by comparing numbers.
//
// SQUARE CELLS THAT FILL THE CARD, in two steps and for two different reasons. The cells were
// `flex-1` inside a full-width row, so they stretched into rectangles and the grid stopped reading
// as a calendar. Pinning them to a fixed 14px fixed the shape and left a small block floating in a
// lot of empty card. They are now sized FROM the container: one measured width, one cell edge, and
// every cell a square of exactly that edge, so the grid grows to fill whatever it is given.
//
// SEQUENTIAL, ONE HUE, light to dark. Never a rainbow: a rainbow implies categories, and these
// cells differ only in magnitude. Encoded as opacity over a single validated hue, so the ramp is
// monotonic by construction and cannot cross a hue boundary. Every cell keeps a faint track, so an
// hour with nothing in it reads as EMPTY rather than as absent.
import { useElementSize } from '@vueuse/core'
import { computed, ref } from 'vue'

const props = defineProps<{ hours: number[] }>()

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LABEL_W = 32
const GAP = 3

const wrap = ref<HTMLElement | null>(null)
const { width } = useElementSize(wrap)

/**
 * Cell edge, derived from the space available.
 *
 * Clamped at both ends: never below 10px (a week of activity stops being readable) and never above
 * 34px (past that seven rows of squares is a wall). Between those it simply fills, which is what
 * makes the grid look deliberate at any card width instead of centred in empty space.
 */
const cell = computed(() => {
  const usable = Math.max(0, (width.value || 720) - LABEL_W - GAP) - GAP * 23
  return Math.max(10, Math.min(34, Math.floor(usable / 24)))
})
const gridWidth = computed(() => cell.value * 24 + GAP * 23)

const max = computed(() => Math.max(1, ...props.hours))
const hover = ref<number | null>(null)

/** Floor at a faint tint so a cell with ONE turn in it is still visibly not empty. */
const intensity = (v: number) => (v === 0 ? 0 : 0.15 + 0.85 * (v / max.value))
const label = (i: number) =>
  `${DAYS[Math.floor(i / 24)]} ${String(i % 24).padStart(2, '0')}:00 · ${props.hours[i] ?? 0} turns`

/** Every third hour, so the axis stays readable when the cells are small. */
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]
</script>

<template>
  <div ref="wrap" class="w-full overflow-x-auto">
    <div class="min-w-[340px]" :style="{ width: `${LABEL_W + GAP + gridWidth}px` }">
      <div
        v-for="(day, d) in DAYS"
        :key="day"
        class="flex items-center"
        :style="{ gap: `${GAP}px`, marginBottom: `${GAP}px` }"
      >
        <span
          class="shrink-0 text-[10px] text-muted-foreground"
          :style="{ width: `${LABEL_W}px` }"
        >{{ day }}</span>
        <div class="flex" :style="{ gap: `${GAP}px` }">
          <div
            v-for="h in 24"
            :key="h"
            class="shrink-0 rounded-[2px] bg-muted"
            :class="hover === d * 24 + (h - 1) ? 'ring-1 ring-foreground/40' : ''"
            :style="{ width: `${cell}px`, height: `${cell}px` }"
            :title="label(d * 24 + (h - 1))"
            @mouseenter="hover = d * 24 + (h - 1)"
            @mouseleave="hover = null"
          >
            <div
              class="size-full rounded-[2px]"
              :style="{
                background: 'var(--viz-seq)',
                opacity: intensity(hours[d * 24 + (h - 1)] ?? 0),
              }"
            ></div>
          </div>
        </div>
      </div>
      <div class="flex items-center" :style="{ gap: `${GAP}px` }">
        <span class="shrink-0" :style="{ width: `${LABEL_W}px` }"></span>
        <div class="relative h-3" :style="{ width: `${gridWidth}px` }">
          <span
            v-for="h in HOUR_TICKS"
            :key="h"
            class="absolute top-0 text-[10px] tabular-nums text-muted-foreground"
            :style="{ left: `${h * (cell + GAP)}px` }"
          >{{ String(h).padStart(2, '0') }}</span>
        </div>
      </div>
    </div>
  </div>
  <p class="h-4 text-[11px] text-muted-foreground">
    <span v-if="hover !== null">{{ label(hover) }}</span>
  </p>
</template>
