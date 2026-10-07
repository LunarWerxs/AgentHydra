<script setup lang="ts">
import { CARD } from './kit'

// A card of the info pane: a heading row (title, an optional count or note, actions on the right) over its body.
// `flush` drops the body's padding, for a list whose rows run to the card's edges.
defineProps<{ title?: string; flush?: boolean }>()
</script>

<template>
  <section :class="CARD" class="min-w-0">
    <header v-if="title || $slots.title || $slots.actions" class="flex min-h-11 items-center gap-2 px-4 pt-1">
      <h3 class="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium leading-5 text-text">
        <slot name="title">{{ title }}</slot>
      </h3>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1"><slot name="actions" /></div>
    </header>
    <div :class="flush ? '' : title || $slots.title || $slots.actions ? 'px-4 pb-4' : 'p-4'"><slot /></div>
  </section>
</template>
