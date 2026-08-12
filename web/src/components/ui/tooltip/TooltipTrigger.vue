<script setup lang="ts">
import type { TooltipTriggerProps } from "reka-ui"
import { reactiveOmit } from "@vueuse/core"
import { TooltipTrigger } from "reka-ui"
import { computed, inject, onBeforeUnmount } from "vue"
import type { TooltipTouchMode } from "./touch"
import {
  LONG_PRESS_MS,
  MOVE_TOLERANCE_PX,
  swallowNextClick,
  TOOLTIP_DISABLED_KEY,
  TOOLTIP_TOUCH_KEY,
  useCoarsePointer,
} from "./touch"

const props = withDefaults(
  defineProps<
    TooltipTriggerProps & {
      /**
       * Which finger gesture reveals this tooltip (see touch.ts). The default long press keeps a
       * single tap doing what it always did — running the control's action — so no tooltip turns a
       * one-tap button into a two-tap one. Use `"tap"` only where a click does nothing anyway, e.g.
       * an info icon whose text has no other surface.
       */
      touch?: TooltipTouchMode
    }
  >(),
  { touch: "long-press" },
)

const touchCtx = inject(TOOLTIP_TOUCH_KEY, null)
const providerDisabled = inject(TOOLTIP_DISABLED_KEY, null)

// A touchscreen laptop keeps full hover behaviour — every gesture below is gated on the event's own
// pointerType, not on this. It only decides whether to suppress the OS long-press artefacts
// (selection handles, callout) that would otherwise fight the hold.
const coarsePointer = useCoarsePointer()
const suppressNativeHold = computed(() => props.touch !== "off" && coarsePointer.value)

const active = computed(() => props.touch !== "off" && touchCtx !== null && !providerDisabled?.value)

/** The in-flight gesture: `pointerId` is null between gestures. */
let pointerId: number | null = null
let element: HTMLElement | null = null
let startX = 0
let startY = 0
let timer: ReturnType<typeof setTimeout> | undefined
/** Whether the tooltip was already showing when this gesture began — a second tap, in tap mode. */
let openAtStart = false
/** Set once this gesture has revealed the tooltip. */
let revealed = false

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function endGesture(): void {
  clearTimer()
  if (revealed) touchCtx?.endHold()
  pointerId = null
  element = null
  openAtStart = false
  revealed = false
}

function reveal(): void {
  // Re-checked here, not just at pointerdown: half a second is long enough for the "show tooltips"
  // switch to have been turned off with the other hand.
  if (!active.value) return
  revealed = true
  touchCtx?.revealByTouch(element)
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType !== "touch" || !event.isPrimary || !active.value) return
  endGesture()
  pointerId = event.pointerId
  element = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  startX = event.clientX
  startY = event.clientY
  openAtStart = touchCtx?.isOpen.value === true
  // Tap mode settles on release, so a scroll that starts on the trigger is not read as a tap.
  if (props.touch === "long-press") timer = setTimeout(reveal, LONG_PRESS_MS)
}

function onPointerMove(event: PointerEvent): void {
  if (pointerId === null || event.pointerId !== pointerId) return
  // Before the reveal, movement means scroll or drag: abandon, and let the page move. After it, the
  // gesture has committed — dropping it here would also drop the click swallow below, and the
  // release would fire the control's action out from under the tooltip.
  if (revealed) return
  if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) endGesture()
}

function onPointerUp(event: PointerEvent): void {
  if (pointerId === null || event.pointerId !== pointerId) return

  if (props.touch === "tap" && !revealed) {
    // A tap toggles: show the text, or put it away if this same tap-mode icon is already showing
    // it. Either way the click is eaten, so tapping the icon never fires the row or card behind it.
    if (openAtStart) touchCtx?.closeByTouch()
    else reveal()
    swallowNextClick(element)
  } else if (revealed) {
    // Armed on RELEASE, because the click is a consequence of the release: a window opened back at
    // reveal time could already have lapsed under a hold long enough to read the tooltip.
    swallowNextClick(element)
  } else if (openAtStart) {
    // A plain tap on a control still showing a tooltip from an earlier hold. reka closes on tap by
    // itself once the grace has lapsed, but inside it that close is refused — so do it here and
    // leave the click alone, because this tap is here to run the action.
    touchCtx?.closeByTouch()
  }

  endGesture()
}

/**
 * Android raises its context menu around the moment a hold completes, and iOS answers one with a
 * selection callout — both would land on top of the tooltip that hold just asked for. Suppressed
 * only while a touch gesture is actually in flight, so right-click is untouched.
 */
function onContextMenu(event: Event): void {
  if (pointerId !== null) event.preventDefault()
}

onBeforeUnmount(endGesture)

const forwarded = reactiveOmit(props, "touch")
</script>

<template>
  <TooltipTrigger
    data-slot="tooltip-trigger"
    v-bind="forwarded"
    :style="
      suppressNativeHold
        ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }
        : undefined
    "
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="endGesture"
    @contextmenu="onContextMenu"
  >
    <slot />
  </TooltipTrigger>
</template>
