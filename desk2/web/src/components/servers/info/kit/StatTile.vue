<script setup lang="ts">
import type { Component } from 'vue'
import { CARD, EYEBROW, TONE_TEXT, type Tone } from './kit'

// One number or fact as a tile: its label small and upper-case, the value large, a line under it. A tile given
// `@click` (interactive) is a button, for a fact that leads somewhere (a project, the errors).
const props = defineProps<{ label: string; value?: string; sub?: string; icon?: Component; tone?: Tone; interactive?: boolean; title?: string }>()
const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <component
    :is="props.interactive ? 'button' : 'div'"
    :type="props.interactive ? 'button' : undefined"
    :title="title"
    :class="[
      CARD,
      'flex min-w-0 flex-col gap-1 px-3.5 py-3 text-start',
      props.interactive && 'cursor-default transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none'
    ]"
    @click="props.interactive && emit('click')"
  >
    <span class="flex items-center gap-1.5" :class="EYEBROW">
      <component :is="icon" v-if="icon" class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
    </span>
    <span class="flex min-w-0 items-center gap-1.5 text-[18px] font-semibold leading-6 tnum" :class="tone ? TONE_TEXT[tone] : 'text-text'">
      <slot><span class="truncate">{{ value }}</span></slot>
    </span>
    <span v-if="sub || $slots.sub" class="truncate text-[12px] leading-4 text-text-muted"><slot name="sub">{{ sub }}</slot></span>
  </component>
</template>
