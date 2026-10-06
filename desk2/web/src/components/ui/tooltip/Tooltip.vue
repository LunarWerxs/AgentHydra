<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from "reka-ui"
import { TooltipRoot, useForwardProps } from "reka-ui"
import { computed, onScopeDispose, provide, readonly, ref, watch } from "vue"
import type { TooltipTouchContext } from "./touch"
import { PIN_GRACE_MS, TOOLTIP_TOUCH_KEY } from "./touch"

const props = withDefaults(defineProps<TooltipRootProps>(), {
  // Vue's TS-macro compiler gives an optional `boolean` prop a bare runtime `Boolean` type, and an
  // ABSENT Boolean prop defaults to `false`, not `undefined` — the same trap TooltipProvider
  // documents for `disabled`. Without these, `props.open` reads `false` when no caller passed it,
  // `consumerControlled` below is true for EVERY tooltip, and nothing ever opens.
  open: undefined,
  defaultOpen: undefined,
})
const emits = defineEmits<TooltipRootEmits>()

// reka's TooltipRoot decides ONCE, at setup, whether it is controlled:
//   passive: (props.open === undefined) as false
// A tooltip that mounts uncontrolled can therefore never be driven by `open` later. Since a touch
// gesture has to hold one open against reka's close paths (see touch.ts), this wrapper is ALWAYS
// controlled and keeps the state itself — reka asks via `update:open`, we decide.
const consumerControlled = props.open !== undefined
const localOpen = ref(props.defaultOpen ?? false)
const open = computed(() => (consumerControlled ? (props.open ?? false) : localOpen.value))

/**
 * Refusing reka's closes while a gesture holds the tooltip. Set the moment a gesture reveals it and cleared a short
 * grace after that gesture ends — see touch.ts for why it must not be permanent.
 */
const held = ref(false)
let graceTimer: ReturnType<typeof setTimeout> | undefined
/** True while a finger-revealed tooltip is still showing; arms the dismissal listeners. */
const openedByTouch = ref(false)
/** The element the gesture came from — a press back on it is a toggle, not a dismissal. */
let touchTrigger: HTMLElement | null = null

function clearGrace(): void {
  if (graceTimer !== undefined) clearTimeout(graceTimer)
  graceTimer = undefined
}

function setOpen(next: boolean): void {
  // Lifting a finger fires pointerleave AND click, and reka closes on both. Refusing here is what
  // lets a revealed tooltip outlive the release that revealed it.
  if (!next && held.value) return
  if (next === open.value) return
  if (!consumerControlled) localOpen.value = next
  emits("update:open", next)
}

function revealByTouch(trigger: HTMLElement | null): void {
  clearGrace()
  touchTrigger = trigger
  held.value = true
  openedByTouch.value = true
  if (!open.value) {
    if (!consumerControlled) localOpen.value = true
    emits("update:open", true)
  }
}

function endHold(): void {
  if (!held.value) return
  clearGrace()
  graceTimer = setTimeout(() => {
    held.value = false
    graceTimer = undefined
  }, PIN_GRACE_MS)
}

function closeByTouch(): void {
  clearGrace()
  held.value = false
  setOpen(false)
}

// Dismissal for a finger-opened tooltip. Escape and hover still belong to reka once the grace has
// lapsed; these two are the paths reka cannot serve here (touch.ts explains both).
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null
  // A press back on the trigger is a toggle, settled by TooltipTrigger on release, so that a
  // tap-mode icon closes instead of closing and instantly reopening.
  if (target && touchTrigger?.contains(target)) return
  // Reading the tooltip is not dismissing it.
  if (target?.closest('[data-slot="tooltip-content"]')) return
  closeByTouch()
}

function bindDismissal(): void {
  if (typeof document === "undefined") return
  // Capture phase, so a dismissal still lands if something stops propagation on the way up.
  document.addEventListener("pointerdown", onDocumentPointerDown, true)
  // The trigger slides out from under the tooltip; hiding beats floating over whatever replaces it.
  document.addEventListener("scroll", closeByTouch, { capture: true, passive: true })
}

function unbindDismissal(): void {
  if (typeof document === "undefined") return
  document.removeEventListener("pointerdown", onDocumentPointerDown, true)
  document.removeEventListener("scroll", closeByTouch, true)
}

watch(openedByTouch, (is) => {
  if (is) bindDismissal()
  else unbindDismissal()
})

// Watchdog for a mouse-opened (or focus-opened) tooltip whose close never arrives. reka closes on the
// trigger's pointerleave or on pointermoves that its grace-area tracking sees, and neither fires when
// the pointer leaves the document (this pane lives in an iframe, so Desk's chrome counts), when the
// window loses focus, or when a modal (body pointer-events: none) sits over the trigger. So while the
// tooltip is open and not held by a touch gesture, listen on the document and close it ourselves; a
// closed tooltip has no listeners. Closing goes through setOpen, which still respects `held`.
const OUTSIDE_GRACE_MS = 150
let triggerEl: HTMLElement | null = null
let contentOf: (() => unknown) | null = null
let outsideTimer: ReturnType<typeof setTimeout> | undefined
let watching = false

function clearOutsideTimer(): void {
  if (outsideTimer !== undefined) clearTimeout(outsideTimer)
  outsideTimer = undefined
}

function closeIfStranded(): void {
  clearOutsideTimer()
  setOpen(false)
}

function onWatchPointerOut(event: PointerEvent): void {
  if (event.pointerType === "touch") return
  if (event.relatedTarget === null) return closeIfStranded()
  // Into an iframe (Desk's AgentHydra pane): its moves never reach this document, so no pointermove would ever
  // start the grace below. Where the pointer went is enough to start it.
  checkOutside(event.relatedTarget)
}

function onWatchPointerMove(event: PointerEvent): void {
  if (event.pointerType === "touch") return
  checkOutside(event.target)
}

function checkOutside(at: EventTarget | null): void {
  if (triggerEl && !triggerEl.isConnected) return closeIfStranded()
  const target = at instanceof Node ? at : null
  const content = contentOf?.()
  if (!triggerEl || (target && (triggerEl.contains(target) || (content instanceof Node && content.contains(target))))) {
    clearOutsideTimer()
    return
  }
  // Short grace: crossing the gap into hoverable content passes over neither element.
  outsideTimer ??= setTimeout(closeIfStranded, OUTSIDE_GRACE_MS)
}

function bindWatchdog(): void {
  if (watching || typeof document === "undefined") return
  watching = true
  if (triggerEl && !triggerEl.isConnected) return closeIfStranded()
  document.addEventListener("pointerout", onWatchPointerOut, true)
  document.addEventListener("pointermove", onWatchPointerMove, true)
  document.documentElement.addEventListener("pointerleave", onWatchPointerOut)
  window.addEventListener("blur", closeIfStranded)
}

function unbindWatchdog(): void {
  clearOutsideTimer()
  if (!watching) return
  watching = false
  document.removeEventListener("pointerout", onWatchPointerOut, true)
  document.removeEventListener("pointermove", onWatchPointerMove, true)
  document.documentElement.removeEventListener("pointerleave", onWatchPointerOut)
  window.removeEventListener("blur", closeIfStranded)
}

watch(
  () => open.value && !held.value,
  (is) => {
    if (is) bindWatchdog()
    else unbindWatchdog()
  },
  { immediate: true },
)

// However it closed — our dismissal, reka's, or a hover leaving — the touch episode is over.
watch(open, (is) => {
  if (!is) {
    openedByTouch.value = false
    touchTrigger = null
    clearGrace()
    held.value = false
  }
})

onScopeDispose(() => {
  clearGrace()
  unbindDismissal()
  unbindWatchdog()
})

const touch: TooltipTouchContext = {
  isOpen: readonly(open),
  revealByTouch,
  endHold,
  closeByTouch,
  setTrigger(el) {
    triggerEl = el
  },
  setContent(get) {
    contentOf = get
  },
}
provide(TOOLTIP_TOUCH_KEY, touch)

// Still useForwardProps, not a plain spread: it forwards ONLY what the caller actually assigned, so
// `disabled`/`ignoreNonKeyboardFocus`/`disableHoverableContent` stay absent here and keep falling
// through to TooltipProvider. Spreading raw props would hand reka a coerced `false` for each and
// quietly override the provider — including the app-wide "show tooltips" kill switch. `:open` is
// bound after it and wins.
const forwarded = useForwardProps(props)
</script>

<template>
  <TooltipRoot
    v-slot="slotProps"
    data-slot="tooltip"
    v-bind="forwarded"
    :open="open"
    @update:open="setOpen"
  >
    <slot v-bind="slotProps" />
  </TooltipRoot>
</template>
