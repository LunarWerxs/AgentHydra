<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue'

// A choice of a few as one control: Settings' radiogroup look (Runtime: Auto / Node / Bun). Arrow keys move the choice.
const props = defineProps<{ modelValue: T; options: { value: T; label: string; icon?: Component }[]; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

function key(e: KeyboardEvent, i: number) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  e.preventDefault()
  const n = props.options.length
  const next = props.options[(i + step + n) % n]
  emit('update:modelValue', next.value)
  const group = (e.currentTarget as HTMLElement).parentElement
  requestAnimationFrame(() => (group?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus())
}
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="inline-flex h-8 max-w-full shrink-0 items-center gap-px rounded-(--radius-7) bg-fill-5 p-0.75 shadow-[inset_0_0_0_1px_var(--border)]" :class="disabled && 'pointer-events-none opacity-50'">
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      :tabindex="modelValue === o.value ? 0 : -1"
      class="inline-flex h-6.5 min-w-0 cursor-default items-center gap-1.5 rounded-(--radius-5) px-2.5 text-[13px] leading-4.75 text-text-2 transition-colors duration-60 hover:text-text focus-visible:shadow-(--focus-ring) focus-visible:outline-none aria-checked:bg-(--fill-secondary) aria-checked:text-text"
      @click="emit('update:modelValue', o.value)"
      @keydown="key($event, i)"
    >
      <component :is="o.icon" v-if="o.icon" class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="truncate">{{ o.label }}</span>
    </button>
  </div>
</template>
