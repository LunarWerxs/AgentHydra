<script setup lang="ts">
// Hour-of-week: seven rows of twenty-four cells. A heatmap is the right form here because the
// question is "when", and a reader answers it by finding a bright patch, not by comparing numbers.
//
// SEQUENTIAL, ONE HUE, light to dark. Never a rainbow: a rainbow implies categories, and these
// cells differ only in magnitude. Encoded as opacity over a single validated hue, so the ramp is
// monotonic by construction and cannot accidentally cross a hue boundary.
import { computed, ref } from 'vue'

const props = defineProps<{ hours: number[] }>()

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const max = computed(() => Math.max(1, ...props.hours))
const hover = ref<number | null>(null)

/** Floor at a faint tint so a cell with ONE turn in it is still visibly not empty. */
const intensity = (v: number) => (v === 0 ? 0 : 0.15 + 0.85 * (v / max.value))
const label = (i: number) =>
  `${DAYS[Math.floor(i / 24)]} ${String(i % 24).padStart(2, '0')}:00 · ${props.hours[i] ?? 0} turns`
</script>

<template>
  <div class="w-full overflow-x-auto">
    <div class="min-w-[440px]">
      <div v-for="(day, d) in DAYS" :key="day" class="flex items-center gap-1">
        <span class="w-8 shrink-0 text-[10px] text-muted-foreground">{{ day }}</span>
        <div class="flex flex-1 gap-[2px]">
          <!-- every cell keeps a faint track, so an hour with nothing in it reads as EMPTY rather
               than as absent. Without it the zero cells are invisible and a quiet night makes the
               grid look like a floating block instead of a seven-by-twenty-four matrix. -->
          <div
            v-for="h in 24"
            :key="h"
            class="h-3.5 flex-1 rounded-[2px] bg-muted"
            :class="hover === d * 24 + (h - 1) ? 'ring-1 ring-foreground/40' : ''"
            :title="label(d * 24 + (h - 1))"
            @mouseenter="hover = d * 24 + (h - 1)"
            @mouseleave="hover = null"
          >
            <div
              class="h-full w-full rounded-[2px]"
              :style="{
                background: 'var(--viz-seq)',
                opacity: intensity(hours[d * 24 + (h - 1)] ?? 0),
              }"
            ></div>
          </div>
        </div>
      </div>
      <div class="mt-1 flex items-center gap-1">
        <span class="w-8 shrink-0"></span>
        <span class="flex-1 text-[10px] text-muted-foreground">00:00</span>
        <span class="text-[10px] text-muted-foreground">23:00</span>
      </div>
    </div>
  </div>
  <p class="h-4 text-[11px] text-muted-foreground">
    <span v-if="hover !== null">{{ label(hover) }}</span>
  </p>
</template>
