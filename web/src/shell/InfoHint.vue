<script setup lang="ts">
// A circle-i info icon that discloses a description on hover/focus/tap, the progressive-disclosure
// primitive for settings. Keeps rows/sections showing only their label, with the verbose text
// tucked behind the icon. Pass `text`, or default-slot content for richer bodies. Needs a
// <TooltipProvider> ancestor (mounted once at the App root).
import { InfoIcon } from '@lucide/vue';
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

defineProps<{ text?: string }>();
</script>

<template>
  <!-- Nested always-enabled provider: the app-wide "show tooltips" switch must never silence
       InfoHints — their disclosed text has no other surface, so it would strand the info.
       ignore-non-keyboard-focus: dialogs/panels autofocus their first focusable on open, and
       when that is an InfoHint the tooltip popped instantly (seen in RepoYeti's settings
       sidebar). Programmatic focus must not disclose; hover and keyboard Tab still do. -->
  <TooltipProvider v-if="text || $slots.default" :disabled="false" ignore-non-keyboard-focus>
    <Tooltip>
      <!-- touch="tap": the icon does nothing when clicked, so a single tap can safely BE the
           disclosure (tap again, or anywhere outside, to dismiss). Every other trigger keeps the
           default long press, which leaves one-tap actions alone. Without this the text is simply
           unreachable on a phone — reka-ui ignores touch pointers on hover.
           before:-inset-2 grows the finger target to ~30px around a 14px icon without moving
           anything: a pseudo-element costs no layout. -->
      <TooltipTrigger as-child touch="tap">
        <button
          type="button"
          aria-label="More information"
          class="relative inline-flex shrink-0 rounded-full text-muted-foreground/50 outline-none transition-colors before:absolute before:-inset-2 before:content-[''] hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <InfoIcon class="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent class="max-w-xs text-[12px] leading-snug"><slot>{{ text }}</slot></TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
