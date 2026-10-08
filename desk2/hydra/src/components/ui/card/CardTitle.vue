<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  size?: "default" | "lg"
  tone?: "default" | "destructive"
}>()
</script>

<template>
  <div
    data-slot="card-title"
    :class="cn('text-sm font-medium cn-font-heading', size === 'lg' && 'text-base', tone === 'destructive' && 'text-destructive', props.class)"
  >
    <slot />
  </div>
</template>
