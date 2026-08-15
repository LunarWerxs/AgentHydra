<script setup lang="ts">
import type { ContextMenuContentEmits, ContextMenuContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ContextMenuContent,
  ContextMenuPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ContextMenuContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<ContextMenuContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <ContextMenuPortal>
    <!-- Width is deliberately NOT bound to `--reka-context-menu-trigger-width`, unlike the dropdown
         menu's content. That variable is reka's `--reka-popper-anchor-width`, and a context menu's
         anchor is the click POINT — a zero-width virtual element — so binding to it collapsed every
         menu onto its `min-w-32` floor (128px) and wrapped any label longer than that ("Reveal in
         file manager" was the one that gave it away). Left unset, the popper shrink-to-fits its
         widest item and still respects the available viewport width; callers that want a fixed
         width can still pass one via `class`. -->
    <ContextMenuContent
      data-slot="context-menu-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100 cn-menu-translucent z-50 max-h-(--reka-context-menu-content-available-height) max-w-(--reka-context-menu-content-available-width) origin-(--reka-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto data-[state=closed]:overflow-hidden', props.class)"
    >
      <slot />
    </ContextMenuContent>
  </ContextMenuPortal>
</template>
