<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { TableHeadVariants } from "./table-variants"
import { cn } from "@/lib/utils"
import { tableHeadVariants } from "./table-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  width?: TableHeadVariants["width"]
  align?: TableHeadVariants["align"]
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn(tableHeadVariants({ width, align }), props.class)"
  >
    <slot />
  </th>
</template>
