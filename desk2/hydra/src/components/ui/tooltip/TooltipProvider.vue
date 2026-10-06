<script setup lang="ts">
import type { TooltipProviderProps } from "reka-ui"
import { TooltipProvider } from "reka-ui"
import { computed, provide } from "vue"
import { useTooltipConfig } from "@/lib/tooltip-config"
import { TOOLTIP_DISABLED_KEY } from "./touch"

const props = withDefaults(defineProps<TooltipProviderProps>(), {
  delayDuration: 0,
  // Vue's TS-macro compiler infers a bare runtime `Boolean` type for an optional `boolean`
  // prop, and Vue defaults an ABSENT Boolean prop to `false` (not `undefined`) — so without
  // this, `props.disabled` is `false` even when no caller ever passes it, and the `?? !enabled.value`
  // fallback below never triggers (the kit-wide tooltip kill-switch silently does nothing).
  // An explicit `undefined` default overrides that implicit coercion.
  disabled: undefined,
  // Same trap, and the same fix: an absent Boolean would read `false`, and `v-bind="props"` below would
  // hand reka that `false`. Focus that is not keyboard focus (reka returning focus to a DropdownMenu or
  // Dialog trigger as it closes) must not open a tooltip: the pointer is elsewhere, so nothing would
  // ever close it. Keyboard :focus-visible focus still opens one; an explicit prop still wins.
  ignoreNonKeyboardFocus: true,
})

// Global kill-switch: unless a caller pins `disabled` explicitly, follow the shared
// "show tooltips" setting (lib/tooltip-config.ts) so one Settings toggle silences every
// tooltip under this provider. InfoHint nests its own `:disabled="false"` provider to
// stay exempt.
const { enabled } = useTooltipConfig()
const resolvedDisabled = computed(() => props.disabled ?? !enabled.value)

// reka keeps its provider context to itself, but the touch gestures in TooltipTrigger are ours and
// have to obey the same kill-switch — otherwise "show tooltips: off" would silence hover while a
// long press still popped one open. Republish the resolved state for them to read.
provide(TOOLTIP_DISABLED_KEY, resolvedDisabled)
</script>

<template>
  <TooltipProvider v-bind="props" :disabled="resolvedDisabled">
    <slot />
  </TooltipProvider>
</template>
