<script setup lang="ts">
// Rich tooltip for icon-only / terse toolbar controls: a bold label line plus an optional
// shorter description line. Unlike InfoHint (always-on; its disclosed text has no other
// surface), this respects the app-wide "show tooltips" kill-switch (lib/tooltip-config.ts) by
// simply relying on the ambient TooltipProvider mounted once at App.vue's root, same as every
// other kit Tooltip usage. Wrap a single focusable/hoverable element (usually a Button) in the
// default slot; pass `label` (required) and `description` (optional, only when it adds real
// value beyond the label itself).
//
// `detail` is a THIRD line, and three is the ceiling. It exists because the Instances table's name
// cell genuinely carries three separate facts — the full (possibly elided) name, the profile
// folder, and "click to focus" — and folding any two into one string made the hover read as prose.
// Reach for it only when each line is a different KIND of fact; a second sentence about the same
// fact belongs in `description`.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

defineProps<{ label: string; description?: string; detail?: string }>();
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipContent class="max-w-[220px] flex-col items-start gap-0.5 text-left">
      <div class="font-medium">{{ label }}</div>
      <div v-if="description" class="text-background/70">{{ description }}</div>
      <div v-if="detail" class="text-background/70">{{ detail }}</div>
    </TooltipContent>
  </Tooltip>
</template>
