<script setup lang="ts">
import { icons } from '@/lib/icons';
const ChevronDownIcon = icons.more;

import type { SelectTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { SelectIcon, SelectTrigger, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"

const props = withDefaults(
  defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"], size?: "sm" | "default", variant?: "default" | "row" }>(),
  { size: "default", variant: "default" },
)

const delegatedProps = reactiveOmit(props, "class", "size", "variant")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectTrigger
    data-slot="select-trigger"
    :data-size="size"
    :data-variant="variant"
    v-bind="forwardedProps"
    :class="cn(
      'border-border-strong data-placeholder:text-text-muted bg-fill-5 dark:bg-fill-5 dark:hover:bg-fill-5 focus-visible:border-accent focus-visible:ring-accent/30 aria-invalid:ring-danger/20 dark:aria-invalid:ring-danger/40 aria-invalid:border-danger dark:aria-invalid:border-danger/50 gap-1.5 rounded-md border px-2 py-1.5 text-xs/relaxed transition-colors focus-visible:ring-2 aria-invalid:ring-2 data-[size=default]:h-7 data-[size=sm]:h-6 *:data-[slot=select-value]:gap-1.5 [&_svg:not([class*=size-])]:size-3.5 flex w-fit items-center justify-between whitespace-nowrap outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
      variant === 'row' && 'w-full h-auto data-[size=default]:h-auto data-[size=sm]:h-auto gap-3 rounded-none border-0 bg-transparent dark:bg-transparent px-3.5 py-1.75 text-ui font-normal text-text shadow-none ring-0 hover:bg-fill-hover dark:hover:bg-fill-hover focus-visible:bg-fill-hover focus-visible:ring-0 [&>svg]:hidden',
      props.class,
    )"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDownIcon class="text-text-muted size-3.5 pointer-events-none" />
    </SelectIcon>
  </SelectTrigger>
</template>
