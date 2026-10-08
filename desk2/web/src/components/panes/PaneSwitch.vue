<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'

// The real CDS switch: track h20 w36 (h * 1.8), white 10% (hover 20%), accent when on; knob h-4 white,
// moved h * 0.8 when checked.
defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <SwitchRoot
    :model-value="modelValue"
    :disabled="disabled"
    :aria-label="label"
    class="group/sw relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-(--fill-secondary) p-0.5 outline-none transition-colors duration-150 ease-(--ease-default) hover:bg-(--border-strong) focus-visible:shadow-(--focus-ring) data-[state=checked]:bg-(--accent) data-[state=checked]:hover:bg-(--accent-hover) data-disabled:cursor-not-allowed data-disabled:opacity-50"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <SwitchThumb
      class="pointer-events-none block size-4 rounded-full bg-white shadow-[0_1px_2px_#0000001a] transition-transform duration-150 ease-(--ease-default) data-[state=checked]:translate-x-4"
    />
  </SwitchRoot>
</template>
