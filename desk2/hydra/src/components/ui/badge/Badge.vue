<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { BadgeVariants } from "./badge-variants"
import { reactiveOmit } from "@vueuse/core"
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"
import { badgeVariants } from "./badge-variants"

const props = defineProps<PrimitiveProps & {
  variant?: BadgeVariants["variant"]
  size?: BadgeVariants["size"]
  dimmed?: boolean
  interactive?: boolean
  class?: HTMLAttributes["class"]
}>()

const delegatedProps = reactiveOmit(props, "class", "size", "dimmed", "interactive")
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-variant="variant"
    :class="cn(badgeVariants({ variant, size, dimmed, interactive }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
