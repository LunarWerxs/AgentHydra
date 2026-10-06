<script setup lang="ts">
import { TooltipContent, TooltipPortal } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import Tooltip from './Tooltip.vue'
import TooltipProvider from './TooltipProvider.vue'
import TooltipTrigger from './TooltipTrigger.vue'
import { InterestSlot, useFirstInterest } from '@/lib/first-interest'

// Until the first hover, focus, press or key the tip renders only its slot (a long sidebar has dozens of Tips,
// and a closed tooltip is a dozen components); then the real tooltip mounts and stays. The arming hover is
// replayed on the new trigger, so the very first hover still shows the tip after its delay (lib/first-interest.ts).
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
const { seen, listeners } = useFirstInterest({
  replay: true,
  afterPress: () => {
    open.value = false
  },
})
const standIn = { 'data-slot': 'tooltip-trigger', 'data-state': 'closed' }
watch(off, (v) => {
  if (v) open.value = false
})
</script>

<template>
  <InterestSlot v-if="!seen" :listeners="listeners" :stand-in="standIn">
    <slot />
  </InterestSlot>
  <TooltipProvider v-else :delay-duration="delay" :disabled="off">
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
