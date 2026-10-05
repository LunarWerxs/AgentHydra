<script setup lang="ts">
// Shared icon button: a shadcn Button (icon size by default) wrapped in a Tooltip.
// Put the icon in the slot; @click and other attrs fall through to the Button.
// Needs a <TooltipProvider> ancestor (mounted once at the App root).
import { Button, type ButtonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    tooltip?: string;
    variant?: ButtonVariants["variant"];
    size?: ButtonVariants["size"];
  }>(),
  { variant: "ghost", size: "icon-sm" },
);
</script>

<template>
  <Tooltip v-if="tooltip">
    <TooltipTrigger as-child>
      <Button :variant="variant" :size="size" :aria-label="tooltip" v-bind="$attrs"><slot /></Button>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip }}</TooltipContent>
  </Tooltip>
  <Button v-else :variant="variant" :size="size" v-bind="$attrs"><slot /></Button>
</template>
