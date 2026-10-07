<script setup lang="ts">
import { CARD } from './kit'

// A form's section: a heading and a line on what it is for, over a card holding its fields with room between them.
defineProps<{ title: string; description?: string; tone?: 'danger' }>()
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2.5">
    <div class="flex flex-col gap-0.5 px-0.5">
      <h3 class="text-[13px] font-medium leading-5" :class="tone === 'danger' ? 'text-danger-text' : 'text-text'">{{ title }}</h3>
      <p v-if="description" class="text-[12px] leading-4 text-text-muted">{{ description }}</p>
    </div>
    <div :class="[CARD, 'flex flex-col gap-4 p-4', tone === 'danger' && 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_45%,transparent)]']">
      <slot />
    </div>
  </section>
</template>
