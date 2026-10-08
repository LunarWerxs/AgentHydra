<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Activity } from '@lucide/vue'
import { BTN, CARD, EYEBROW, type ChartPoint } from './kit/kit'
import Sparkline from './kit/Sparkline.vue'

// One resource of a server as a card (owner, 2026-10-07: "There's no, like, charts or stats or anything visually
// viewable"): the value now, large; the average and peak of the window beside it; up to the last ten minutes as an area
// chart with the server's alert limits as dashed lines; the time axis under it. Monitoring off shows how to turn it on;
// a server that is down keeps the samples it had, with "Not running" as its value.
const props = defineProps<{
  label: string
  icon?: Component
  /** The value now, worded; null while there is none (down, or no sample yet). */
  now: string | null
  points: ChartPoint[]
  from: number
  to: number
  color: string
  max: number
  thresholds: number[]
  format: (n: number) => string
  state: 'live' | 'down' | 'off'
  busy?: boolean
}>()
const emit = defineEmits<{ monitor: [] }>()

const vals = computed(() => props.points.flatMap((p) => (p.v === null || p.t < props.from ? [] : [p.v])))
const avg = computed(() => (vals.value.length ? vals.value.reduce((a, b) => a + b, 0) / vals.value.length : null))
const peak = computed(() => (vals.value.length ? Math.max(...vals.value) : null))
const minutes = computed(() => Math.round((props.to - props.from) / 60_000))
</script>

<template>
  <section :class="[CARD, 'flex min-w-0 flex-col gap-3 p-4']" :aria-label="label">
    <div class="flex items-start gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <span class="flex items-center gap-1.5" :class="EYEBROW">
          <component :is="icon ?? Activity" class="size-3.5" aria-hidden="true" />{{ label }}
        </span>
        <!-- A word (Off, Not running) at body size, so it never wraps beside the average and peak; a number large. -->
        <span class="font-semibold leading-7 tnum" :class="now === null ? 'text-[15px] text-text-muted' : 'text-[22px] text-text'">
          {{ state === 'off' ? 'Off' : now ?? (state === 'down' ? 'Not running' : '–') }}
        </span>
      </div>
      <span class="flex-1" />
      <dl v-if="state !== 'off' && avg !== null" class="flex shrink-0 gap-4 pt-0.5 text-end">
        <div class="flex flex-col gap-0.5">
          <dt :class="EYEBROW">Avg</dt>
          <dd class="text-[13px] leading-5 text-text-2 tnum">{{ format(avg) }}</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt :class="EYEBROW">Peak</dt>
          <dd class="text-[13px] leading-5 text-text-2 tnum">{{ format(peak!) }}</dd>
        </div>
      </dl>
    </div>

    <div v-if="state === 'off'" class="flex h-24 flex-col items-start justify-center gap-2 rounded-(--radius-8) bg-fill-5 px-3">
      <p class="text-[12px] leading-4 text-text-muted">Resource monitoring is off, so nothing is measured.</p>
      <button type="button" :class="BTN" :disabled="busy" @click="emit('monitor')">Turn monitoring on</button>
    </div>
    <!-- Nothing measured in the window: a quiet box saying why, never an empty chart. -->
    <div v-else-if="!vals.length" class="flex h-24 items-center justify-center rounded-(--radius-8) bg-fill-5 px-3 text-center text-[12px] leading-4 text-text-muted">
      {{ state === 'down' ? `Start it to see its ${label === 'CPU' ? 'CPU' : label.toLowerCase()} over time.` : 'Waiting for the first sample…' }}
    </div>
    <template v-else>
      <Sparkline
        :points="points"
        :from="from"
        :to="to"
        :color="color"
        :max="max"
        :thresholds="thresholds"
        :height="76"
        :label="`${label} over the last ${minutes} minutes${peak !== null ? `, peak ${format(peak)}` : ''}`"
      />
      <div class="-mt-1 flex justify-between text-[11px] leading-4 text-text-muted tnum">
        <span>{{ minutes }} min ago</span>
        <span>now</span>
      </div>
    </template>
  </section>
</template>
