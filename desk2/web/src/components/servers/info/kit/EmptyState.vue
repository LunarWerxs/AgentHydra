<script setup lang="ts">
import type { Component } from 'vue'

// Nothing to show yet (no errors, no rules, nothing logged): an icon in a soft circle, a line saying so, a line on what
// would appear, and an action when there is one.
defineProps<{ icon: Component; title: string; text?: string; tone?: 'success' | 'neutral' }>()
</script>

<template>
  <div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
    <span class="flex size-10 items-center justify-center rounded-full" :class="tone === 'success' ? 'bg-success-bg text-success-text' : 'bg-fill-5 text-text-muted'">
      <component :is="icon" class="size-5" aria-hidden="true" />
    </span>
    <p class="text-[13px] font-medium leading-5 text-text">{{ title }}</p>
    <p v-if="text" class="max-w-[320px] text-[12px] leading-4.5 text-text-muted">{{ text }}</p>
    <div v-if="$slots.default" class="mt-1 flex flex-wrap justify-center gap-1.5"><slot /></div>
  </div>
</template>
