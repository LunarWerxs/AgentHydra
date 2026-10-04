<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="dropdown-menu-shortcut"
    :class="cn('text-text-muted group-focus/dropdown-menu-item:text-text ms-auto text-[0.625rem] tracking-widest', props.class)"
  >
    <slot />
  </span>
</template>
