<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

/**
 * AppContainer, the single source of the unified content width. The width is the
 * `--container-max` token in base.css (800px), imported so it can never drift
 * between apps. Wrap each app's main content column with this.
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div :class="cn('mx-auto w-full max-w-(--container-max) px-4 sm:px-6', props.class)">
    <slot />
  </div>
</template>
