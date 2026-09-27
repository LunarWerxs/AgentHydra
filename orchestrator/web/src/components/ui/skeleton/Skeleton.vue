<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

interface SkeletonProps {
  class?: HTMLAttributes["class"]
  shape?: "default" | "bubble"
}

const props = defineProps<SkeletonProps>()
</script>

<template>
  <div
    data-slot="skeleton"
    :data-shape="shape"
    :class="cn('bg-muted rounded-md animate-pulse', shape === 'bubble' && 'rounded-2xl', props.class)"
  />
</template>
