<script setup lang="ts">
// Wrap a single interactive element (a button, a toggle item, a menu trigger) in a
// hover/focus tooltip without replacing it. The trigger goes in the default slot and
// must be exactly ONE root element — it's forwarded with `as-child`, so the tooltip's
// listeners/aria merge straight onto your element (no extra DOM wrapper, so things like
// ToggleGroup rounding and roving focus keep working). Pass copy via the `label` prop,
// or richer markup via the #label slot. Needs a <TooltipProvider> ancestor (mounted
// once at the App root). For plain icon buttons, prefer IconButton.vue instead.
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

withDefaults(
  defineProps<{
    label?: string;
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
  }>(),
  { side: "bottom" },
);
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipContent :side="side" :side-offset="sideOffset">
      <slot name="label">{{ label }}</slot>
    </TooltipContent>
  </Tooltip>
</template>
