<script setup lang="ts">
// The usage ring at the right end of the toolbar: a 20px button with a progress ring (the real one
// draws its arc in the accent blue; Hydra Desk turns it amber at 75% and red at 90%).
import { computed } from 'vue'
import { Tip } from '@/components/ui/tooltip'

const props = defineProps<{ pct: number | null }>()

const R = 5.5
const C = 2 * Math.PI * R
const value = computed(() => Math.max(0, Math.min(100, props.pct ?? 0)))
const dash = computed(() => `${(value.value / 100) * C} ${C}`)
const color = computed(() => (value.value >= 90 ? 'var(--danger)' : value.value >= 75 ? 'var(--warning)' : 'var(--accent)'))
const tip = computed(() =>
  props.pct == null ? 'Usage: Context not measured yet' : `Usage: Context ${Math.round(value.value)}% of the window used`
)
</script>

<template>
  <Tip :label="tip" side="top">
    <span
      class="inline-flex size-5 items-center justify-center rounded-[var(--radius-5)] hover:bg-[var(--fill-hover)]"
      :aria-label="tip"
      role="img"
    >
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" :r="R" fill="none" stroke="var(--border)" stroke-width="2" />
        <circle
          v-if="pct != null && value > 0"
          cx="7"
          cy="7"
          :r="R"
          fill="none"
          :stroke="color"
          stroke-width="2"
          stroke-linecap="round"
          :stroke-dasharray="dash"
          transform="rotate(-90 7 7)"
        />
      </svg>
    </span>
  </Tip>
</template>
