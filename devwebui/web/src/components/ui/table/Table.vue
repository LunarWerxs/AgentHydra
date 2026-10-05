<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { TableVariants } from "./table-variants"
import { cn } from "@/lib/utils"
import { tableVariants } from "./table-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  density?: TableVariants["density"]
}>()
</script>

<template>
  <div data-slot="table-container" class="relative w-full overflow-x-auto">
    <table data-slot="table" :data-density="density" :class="cn(tableVariants({ density }), props.class)">
      <slot />
    </table>
  </div>
</template>
