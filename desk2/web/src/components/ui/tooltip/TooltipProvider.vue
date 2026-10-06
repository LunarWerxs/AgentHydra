<script setup lang="ts">
import type { TooltipProviderProps } from "reka-ui"
import { TooltipProvider } from "reka-ui"
import { computed, provide } from "vue"
import { TOOLTIP_DISABLED_KEY } from "./touch"

const props = withDefaults(defineProps<TooltipProviderProps>(), {
  delayDuration: 0,
  // Vue defaults an ABSENT Boolean prop to `false`; keep it `undefined` so "not pinned" stays visible.
  disabled: undefined,
  // Same trap, same fix: focus that is not keyboard focus (reka returning focus to a DropdownMenu or
  // Dialog trigger as it closes) must not open a tooltip, because the pointer is elsewhere and nothing
  // would ever close it. Keyboard :focus-visible focus still opens one; an explicit prop still wins.
  ignoreNonKeyboardFocus: true,
})

// AgentHydra's copy follows a global "show tooltips" setting here; Hydra Desk has none, so tooltips
// are on unless a caller pins `disabled`.
const resolvedDisabled = computed(() => props.disabled ?? false)

// The touch gestures in TooltipTrigger read the same disabled state.
provide(TOOLTIP_DISABLED_KEY, resolvedDisabled)
</script>

<template>
  <TooltipProvider v-bind="props" :disabled="resolvedDisabled">
    <slot />
  </TooltipProvider>
</template>
