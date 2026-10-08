<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

// error is a failed result: the theme's destructive colour on the border and a light wash behind it.
const TONE = {
  default: '',
  primary: 'border-primary/50',
  destructive: 'border-destructive/50',
  error: 'border-destructive/30 bg-destructive/10',
}

const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  size?: "default" | "sm"
  tone?: "default" | "primary" | "destructive" | "error"
}>(), {
  size: "default",
  tone: "default",
})
</script>

<template>
  <div
    data-slot="card"
    :data-size="size"
    :class="cn('ring-foreground/10 bg-card text-card-foreground gap-4 overflow-hidden rounded-lg py-4 text-xs/relaxed ring-1 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg group/card flex flex-col', TONE[tone], props.class)"
  >
    <slot />
  </div>
</template>
