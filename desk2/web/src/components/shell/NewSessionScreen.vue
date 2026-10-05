<script setup lang="ts">
import type { ChatSummary } from '@shared/protocol'
import StatsCard from './StatsCard.vue'

// The new-session screen above the composer: greeting and the stats card, centred both ways in the space
// above the composer (Jacob, 2026-10-05). The composer below it owns the env pills (folder, branch) and the
// model chip.
defineProps<{ name: string; chats: ChatSummary[] }>()

// The Claude spark as drawn in new-session-screen.png: twelve uneven rays round a solid core, 22px, #d97757.
const RAYS: [deg: number, length: number][] = [
  [-112, 10.5], [-82, 11], [-52, 9.5], [-22, 10], [4, 10.5], [24, 9],
  [52, 10], [88, 10.5], [118, 10], [148, 9], [178, 11.5], [-152, 9.5]
]
const ray = ([deg, length]: [number, number]) => {
  const a = (deg * Math.PI) / 180
  return { x2: 12 + Math.cos(a) * length, y2: 12 + Math.sin(a) * length }
}
</script>

<template>
  <!-- m-auto rather than justify-center: when the window is too short the column starts at the top and
       scrolls, instead of its top being cut off. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
    <div class="m-auto flex w-full max-w-[768px] flex-col items-center py-6">
      <h1 class="flex items-center justify-center gap-[7px] text-center text-[22px] font-normal leading-7 text-text">
        <svg class="relative top-px size-[22px] shrink-0 text-[#d97757]" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.6" stroke="none" />
          <line v-for="r in RAYS" :key="r[0]" x1="12" y1="12" v-bind="ray(r)" />
        </svg>
        <span>What’s up next{{ name ? `, ${name}` : '' }}?</span>
      </h1>
      <StatsCard class="mt-[46px]" :chats="chats" />
    </div>
  </div>
</template>
