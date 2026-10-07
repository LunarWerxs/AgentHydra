<script setup lang="ts">
import PaneSwitch from '@/components/panes/PaneSwitch.vue'

// An on/off setting as a row: what it is and a line on what it does, the window's switch on the right.
defineProps<{ label: string; description?: string; modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <div class="flex min-w-0 items-start gap-3">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[13px] leading-5 text-text">{{ label }}</span>
      <span v-if="description" class="text-[12px] leading-4 text-text-muted">{{ description }}</span>
    </div>
    <PaneSwitch class="mt-px" :label="label" :model-value="modelValue" :disabled="disabled" @update:model-value="(v: boolean) => emit('update:modelValue', v)" />
  </div>
</template>
