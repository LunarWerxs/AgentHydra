<script setup lang="ts">
// A hover card that appears instantly.
//
// WHY NOT `title`. The native tooltip is what these charts used, and it has a built-in delay of
// roughly a second before it appears and a further pause before it moves — so sweeping across a
// heatmap, which is exactly how a heatmap is read, showed nothing at all. This renders on the
// pointer event itself, so it keeps up with the cursor.
//
// Positioned in FIXED coordinates from the pointer, not inside the chart, so it is never clipped by
// the chart's own overflow and never widens the card it sits in. It flips to the other side of the
// cursor near a viewport edge rather than being cut off.
import { computed } from 'vue'

const props = defineProps<{
  x: number
  y: number
  title: string
  /** Label/value pairs. Kept as data rather than a formatted string so the layout stays aligned. */
  rows?: Array<{ label: string; value: string }>
  note?: string
}>()

const ESTIMATED_W = 220
const ESTIMATED_H = 96
const style = computed(() => {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const flipX = props.x + ESTIMATED_W + 24 > vw
  const flipY = props.y + ESTIMATED_H + 24 > vh
  return {
    left: `${flipX ? props.x - ESTIMATED_W - 12 : props.x + 12}px`,
    top: `${flipY ? props.y - ESTIMATED_H - 12 : props.y + 12}px`,
  }
})
</script>

<template>
  <!-- pointer-events-none so the card can never sit between the cursor and the cell it describes -->
  <Teleport to="body">
    <div
      class="pointer-events-none fixed z-50 min-w-[10rem] max-w-[16rem] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
      :style="style"
      role="tooltip"
    >
      <p class="text-xs font-medium">{{ title }}</p>
      <dl v-if="rows?.length" class="mt-1 space-y-0.5">
        <div v-for="r in rows" :key="r.label" class="flex items-baseline justify-between gap-3">
          <dt class="text-[11px] text-muted-foreground">{{ r.label }}</dt>
          <dd class="text-[11px] font-medium tabular-nums">{{ r.value }}</dd>
        </div>
      </dl>
      <p v-if="note" class="mt-1 text-[10px] leading-snug text-muted-foreground">{{ note }}</p>
    </div>
  </Teleport>
</template>
