<script setup lang="ts">
import { XIcon } from '@lucide/vue';

import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { CSSProperties, HTMLAttributes } from "vue"
import { computed } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { Button } from '@/components/ui/button'
import SheetOverlay from "./SheetOverlay.vue"

interface SheetContentProps extends DialogContentProps {
  class?: HTMLAttributes["class"]
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  /** Render the dimming backdrop. Set false for a "pure push" panel (LunarWerx). */
  showOverlay?: boolean
  /** Nudge a right-docked panel left by N px so it can stack with another shifted
   *  panel (e.g. a file viewer). Only applies when side="right". */
  rightOffsetPx?: number
}

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<SheetContentProps>(), {
  side: "right",
  showCloseButton: true,
  showOverlay: true,
  rightOffsetPx: 0,
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "side", "showCloseButton", "showOverlay", "rightOffsetPx")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const contentStyle = computed<CSSProperties | undefined>(() => {
  if (props.side !== "right" || props.rightOffsetPx <= 0) return undefined
  return { right: `${props.rightOffsetPx}px` }
})
</script>

<template>
  <DialogPortal>
    <SheetOverlay v-if="showOverlay" />
    <DialogContent
      data-slot="sheet-content"
      :data-side="side"
      :class="cn('bg-popover text-popover-foreground fixed z-50 flex flex-col bg-clip-padding text-xs/relaxed shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[side=bottom]:data-[state=open]:slide-in-from-bottom-10 data-[side=left]:data-[state=open]:slide-in-from-left-10 data-[side=right]:data-[state=open]:slide-in-from-right-10 data-[side=top]:data-[state=open]:slide-in-from-top-10 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[side=bottom]:data-[state=closed]:slide-out-to-bottom-10 data-[side=left]:data-[state=closed]:slide-out-to-left-10 data-[side=right]:data-[state=closed]:slide-out-to-right-10 data-[side=top]:data-[state=closed]:slide-out-to-top-10', props.class)"
      :style="contentStyle"
      v-bind="{ ...$attrs, ...forwarded }"
    >
      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="sheet-close"
        as-child
      >
        <Button variant="ghost" class="absolute top-4 right-4" size="icon-sm">
          <XIcon />
          <span class="sr-only">Close</span>
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
