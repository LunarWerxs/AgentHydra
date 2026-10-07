<script setup lang="ts">
import { Check, Pipette, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { SWATCHES } from './kit'

// A color for a server or project (its dot in the list): none, one of eight swatches, or any color. The value is a
// #rrggbb string, '' for none.
const props = defineProps<{ modelValue: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const custom = () => !!props.modelValue && !SWATCHES.includes(props.modelValue.toLowerCase())
const RING = 'ring-2 ring-text ring-offset-2 ring-offset-bg-panel'
</script>

<template>
  <div role="group" :aria-label="label" class="flex flex-wrap items-center gap-2">
    <Tip label="No color">
      <button
        type="button"
        class="flex size-6 cursor-default items-center justify-center rounded-full bg-fill-5 text-text-muted shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        :class="!modelValue && RING"
        aria-label="No color"
        :aria-pressed="!modelValue"
        @click="emit('update:modelValue', '')"
      >
        <X class="size-3.5" />
      </button>
    </Tip>
    <button
      v-for="c in SWATCHES"
      :key="c"
      type="button"
      class="flex size-6 cursor-default items-center justify-center rounded-full text-white focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      :class="modelValue.toLowerCase() === c && RING"
      :style="{ background: c }"
      :aria-label="`Color ${c}`"
      :aria-pressed="modelValue.toLowerCase() === c"
      @click="emit('update:modelValue', c)"
    >
      <Check v-if="modelValue.toLowerCase() === c" class="size-3.5" />
    </button>
    <Tip label="Any color">
      <label
        class="relative flex size-6 cursor-default items-center justify-center overflow-hidden rounded-full text-text-2 shadow-[inset_0_0_0_1px_var(--border-strong)] focus-within:shadow-[var(--focus-ring)]"
        :class="custom() && RING"
        :style="custom() ? { background: modelValue } : undefined"
      >
        <Pipette v-if="!custom()" class="size-3.5" />
        <input type="color" class="absolute inset-0 size-full cursor-default opacity-0" :value="custom() ? modelValue : '#888888'" aria-label="Any color" @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
      </label>
    </Tip>
  </div>
</template>
