<script setup lang="ts">
import { TooltipContent, TooltipPortal } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import Tooltip from './Tooltip.vue'
import TooltipProvider from './TooltipProvider.vue'
import TooltipTrigger from './TooltipTrigger.vue'

// The real app's tooltip on one control: #20201f, #f0efec, z 50, a 120ms fade. The slot is the
// trigger itself (as-child); a multi-line label keeps its lines.
const props = withDefaults(
  defineProps<{
    label: string
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'start' | 'center' | 'end'
    delay?: number
    disabled?: boolean
  }>(),
  { side: 'bottom', align: 'center', delay: 500, disabled: false }
)

// reka's disabled only stops the next open: a tooltip already showing would stay up (as an empty pill
// when the label went). Turning disabled closes it too.
const off = computed(() => props.disabled || !props.label)
const open = ref(false)
watch(off, (v) => {
  if (v) open.value = false
})
</script>

<template>
  <TooltipProvider :delay-duration="delay" :disabled="off">
    <Tooltip v-model:open="open">
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          data-slot="tooltip-content"
          :side="side"
          :align="align"
          :side-offset="4"
          :collision-padding="8"
          class="tip z-50 max-w-80 whitespace-pre-line rounded-[var(--radius-6)] bg-bg-popover px-2 py-1 text-[12px] leading-4 text-text shadow-(--shadow-menu-ringed)"
        >
          {{ label }}
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  </TooltipProvider>
</template>

<style scoped>
.tip[data-state] {
  animation: tip-in var(--dur-fast) var(--ease-out);
}
@keyframes tip-in {
  from {
    opacity: 0;
  }
}
</style>
