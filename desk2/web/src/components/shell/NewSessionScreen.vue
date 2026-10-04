<script setup lang="ts">
import type { ChatSummary } from '@shared/protocol'
import StatsCard from './StatsCard.vue'

// The new-session screen above the composer: greeting and the stats card, in the 768px column.
// The composer below it owns the env pills (folder, branch) and the model chip.
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
  <div class="min-h-0 flex-1 overflow-y-auto px-4">
    <div class="mx-auto w-full max-w-[768px] pb-6 pt-[11px]">
      <h1 class="flex items-center gap-[7px] text-[22px] font-normal leading-7 text-text">
        <svg class="relative top-px size-[22px] shrink-0 text-[#d97757]" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.6" stroke="none" />
          <line v-for="r in RAYS" :key="r[0]" x1="12" y1="12" v-bind="ray(r)" />
        </svg>
        <span>What’s up next{{ name ? `, ${name}` : '' }}?</span>
      </h1>
      <StatsCard class="ml-2.5 mt-[46px]" :chats="chats" />
    </div>
  </div>
</template>
