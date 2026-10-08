<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { SkeletonVariants } from "./skeleton-variants"
import { cn } from "@/lib/utils"
import { skeletonVariants } from "./skeleton-variants"

interface SkeletonProps {
  class?: HTMLAttributes["class"]
  shape?: "default" | "bubble"
  line?: SkeletonVariants["line"]
  width?: SkeletonVariants["width"]
}

const props = defineProps<SkeletonProps>()
</script>

<template>
  <div
    data-slot="skeleton"
    :data-shape="shape"
    :class="cn('bg-muted rounded-md animate-pulse', shape === 'bubble' && 'rounded-2xl', skeletonVariants({ line, width }), props.class)"
  />
</template>
