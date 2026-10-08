<script setup lang="ts">
import type { LabelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Label } from "reka-ui"
import { cn } from "@/lib/utils"

// text: body-size text; inline: body-size, normal weight, beside a checkbox or switch; mono: a code name.
const VARIANT = {
  default: '',
  text: 'text-sm',
  inline: 'text-sm font-normal',
  mono: 'font-mono text-sm',
}

const props = defineProps<LabelProps & {
  class?: HTMLAttributes["class"]
  variant?: "default" | "text" | "inline" | "mono"
  clickable?: boolean
}>()

const delegatedProps = reactiveOmit(props, "class", "variant", "clickable")
</script>

<template>
  <Label
    data-slot="label"
    v-bind="delegatedProps"
    :class="
      cn(
        'gap-2 text-xs/relaxed leading-none font-medium group-data-[disabled=true]:opacity-50 peer-disabled:opacity-50 flex items-center select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed',
        VARIANT[variant ?? 'default'],
        clickable && 'cursor-pointer',
        props.class,
      )
    "
  >
    <slot />
  </Label>
</template>
