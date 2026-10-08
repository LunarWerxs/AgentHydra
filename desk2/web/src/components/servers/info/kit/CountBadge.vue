<script setup lang="ts">
// A count on a row, a tab or a heading (owner, 2026-10-07: "the red error icon. It isn't oval. It should be a circle"):
// a true 16px circle for one digit, a pill only from two digits on, the number centred in both. Over 99 reads 99+.
const props = withDefaults(defineProps<{ count: number; tone?: 'danger' | 'warning' | 'accent' | 'neutral' }>(), { tone: 'danger' })
const TONE = {
  danger: 'bg-danger text-white',
  warning: 'bg-warning text-[#1a1100]',
  accent: 'bg-accent text-white',
  neutral: 'bg-fill-selected text-text'
} as const
const text = () => (props.count > 99 ? '99+' : String(props.count))
</script>

<template>
  <span
    class="inline-flex h-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none tnum"
    :class="[TONE[tone], text().length === 1 ? 'w-4' : 'min-w-4 px-1.25']"
  >{{ text() }}</span>
</template>
