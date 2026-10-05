<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { TableRowVariants } from "./table-variants"
import { cn } from "@/lib/utils"
import { tableRowVariants } from "./table-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  variant?: TableRowVariants["variant"]
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :data-variant="variant"
    :class="cn(tableRowVariants({ variant }), props.class)"
  >
    <slot />
  </tr>
</template>
