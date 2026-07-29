<script lang="ts" setup>
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
  XIcon,
} from '@lucide/vue';

import type { ToasterProps } from "vue-sonner"
import { Toaster as Sonner } from "vue-sonner"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"

// vue-sonner defaults its close button to the toast's TOP-LEFT corner, where it reads as a
// stray control floating beside the card rather than that card's dismiss. Every other dismiss
// in the kit sits top-right (DialogScrollContent, SheetContent), so match them. Still a
// default, not a hard-code: a consumer can pass close-button-position to move it back.
const props = withDefaults(defineProps<ToasterProps>(), { closeButtonPosition: "top-right" })
// `class` and `toastOptions` are set explicitly below, so omit them from the
// forwarded spread to avoid binding them twice (TS2783).
const forwarded = reactiveOmit(props, "class", "toastOptions")
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
      '--gray2': 'hsl(var(--popover) / 0.9)',
      '--gray3': 'var(--border)',
      '--gray4': 'var(--border)',
      '--gray5': 'var(--border)',
      '--gray12': 'var(--popover-foreground)',
    }"
    :toast-options="props.toastOptions ?? { classes: { toast: 'rounded-md' } }"
    v-bind="forwarded"
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>
