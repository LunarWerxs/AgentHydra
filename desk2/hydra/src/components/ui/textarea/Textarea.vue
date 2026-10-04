<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import type { TextareaVariants } from "./textarea-variants"
import { cn } from "@/lib/utils"
import { textareaVariants } from "./textarea-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  defaultValue?: string | number
  modelValue?: string | number
  variant?: TextareaVariants["variant"]
  textSize?: TextareaVariants["textSize"]
  density?: TextareaVariants["density"]
  trailing?: TextareaVariants["trailing"]
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
  <textarea
    v-model="modelValue"
    data-slot="textarea"
    :data-variant="variant"
    :class="cn(textareaVariants({ variant, textSize, density, trailing }), props.class)"
  />
</template>
