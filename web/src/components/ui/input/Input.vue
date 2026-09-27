<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import type { InputVariants } from "./input-variants"
import { cn } from "@/lib/utils"
import { inputVariants } from "./input-variants"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  variant?: InputVariants["variant"]
  textSize?: InputVariants["textSize"]
  leading?: InputVariants["leading"]
  trailing?: InputVariants["trailing"]
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :data-variant="variant"
    :class="cn(inputVariants({ variant, textSize, leading, trailing }), props.class)"
  >
</template>
