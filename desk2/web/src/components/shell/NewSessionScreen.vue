<script setup lang="ts">
import type { ChatSummary } from '@shared/protocol'
import StatsCard from './StatsCard.vue'

// The new-session screen above the composer: greeting and the stats card, centred both ways in the space
// above the composer (Jacob, 2026-10-05). The composer below it owns the env pills (folder, branch) and the
// model chip.
defineProps<{ name: string; chats: ChatSummary[] }>()
</script>

<template>
  <!-- m-auto rather than justify-center: when the window is too short the column starts at the top and
       scrolls, instead of its top being cut off. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
    <div class="m-auto flex w-full max-w-3xl flex-col items-center py-6">
      <h1 class="flex items-center justify-center gap-1.75 text-center text-[22px] font-normal leading-7 text-text">
        <!-- The AgentHydra logo, the window's own favicon, where Claude draws its spark (Jacob, 2026-10-06). -->
        <img src="/favicon.svg" alt="" class="relative top-px size-5.5 shrink-0" />
        <span>What’s up next{{ name ? `, ${name}` : '' }}?</span>
      </h1>
      <StatsCard class="mt-11.5" :chats="chats" />
    </div>
  </div>
</template>
