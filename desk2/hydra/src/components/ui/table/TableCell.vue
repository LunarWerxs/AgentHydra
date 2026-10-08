<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { TableCellVariants } from "./table-variants"
import { cn } from "@/lib/utils"
import { tableCellVariants } from "./table-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  size?: TableCellVariants["size"]
  align?: TableCellVariants["align"]
  weight?: TableCellVariants["weight"]
  mono?: boolean
  numeric?: boolean
  muted?: boolean
}>()
</script>

<template>
  <td
    data-slot="table-cell"
    :class="cn(tableCellVariants({ size, align, weight, mono, numeric, muted }), props.class)"
  >
    <slot />
  </td>
</template>
