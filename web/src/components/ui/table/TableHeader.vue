<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  sticky?: boolean
}>()
</script>

<template>
  <thead
    data-slot="table-header"
    :data-sticky="sticky ? '' : undefined"
    :class="cn('[&_tr]:border-b', sticky && 'sticky top-0 z-10 bg-card', props.class)"
  >
    <slot />
  </thead>
</template>
