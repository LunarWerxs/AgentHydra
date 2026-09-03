import type { InjectionKey, Ref } from "vue"
import { ref } from "vue"

/**
 * Touch support for tooltips.
 *
 * reka-ui's TooltipTrigger deliberately ignores `pointermove` when `pointerType === "touch"`, so on
 * a phone every tooltip is unreachable — including InfoHint, whose disclosed text has no other
 * surface (a settings description simply becomes invisible). This module is the shared plumbing
 * that gives a finger a way in without turning one-tap buttons into two-tap buttons.
 *
 * Two gestures, chosen per trigger:
 *   · "long-press" (default) — press and hold ~500ms. A normal tap still runs the control's action
 *     untouched; only the held gesture reveals, and the click that ends it is swallowed so nothing
 *     fires behind the tooltip.
 *   · "tap" — reveal immediately, tap again (or anywhere outside) to dismiss. Only for triggers
 *     that do nothing on click, i.e. informational icons like InfoHint.
 *
 * THE ONE THING THAT NEEDS EXPLAINING: lifting a finger fires `pointerleave` AND `click`, and reka
 * closes on both, so a tooltip a gesture just revealed would vanish the instant the finger came off
 * the glass. `Tooltip.vue` therefore owns reka's open state and REFUSES its close requests — but
 * only while the gesture is in flight and for a short grace after it ends (PIN_GRACE_MS). Once that
 * lapses it is an ordinary reka tooltip again and reka's Escape and hover paths work normally. A
 * permanent refusal would have disabled them for good.
 *
 * Dismissing by tap is ours, though, not reka's, for two measured reasons. reka's outside-dismiss
 * waits for the CLICK when the pointer is touch, and that is exactly the click the gesture has to
 * swallow. And its one-tooltip-at-a-time broadcast never arrives: TooltipRoot dispatches
 * `tooltip.open` on `document` without `bubbles`, while TooltipContentImpl listens on `window`, so
 * a non-bubbling event never reaches the listener. Both were verified against a running build, and
 * both are why a finger-opened tooltip watches for an outside press itself.
 *
 * Nothing here engages for a mouse or pen: every entry point is gated on the event's own
 * `pointerType`, not on a coarse-pointer media query, so a touchscreen laptop keeps exact hover
 * behaviour and merely gains the gestures.
 */

/** How a finger reveals this trigger's tooltip. `"off"` opts a trigger out entirely. */
export type TooltipTouchMode = "long-press" | "tap" | "off"

/** Per-`Tooltip` API, provided by `Tooltip.vue` and consumed by `TooltipTrigger.vue`. */
export interface TooltipTouchContext {
  /** Is this tooltip showing right now? Lets a trigger tell a first tap from a second one. */
  isOpen: Readonly<Ref<boolean>>
  /** Show it, and start refusing reka's closes. The trigger identifies itself so that a press back
   *  on it counts as a toggle rather than an outside dismissal. */
  revealByTouch: (trigger: HTMLElement | null) => void
  /** The gesture is over: let the refusal lapse after the grace, so reka takes the reins back. */
  endHold: () => void
  /** Dismiss now, refusal and all. */
  closeByTouch: () => void
}

export const TOOLTIP_TOUCH_KEY: InjectionKey<TooltipTouchContext> = Symbol("lunarwerx-tooltip-touch")

/**
 * The nearest `TooltipProvider`'s resolved `disabled` state. reka keeps its provider context
 * internal, but the touch gestures are ours and must obey the same kill-switch — otherwise the
 * "show tooltips" setting would silence hover while a long press still popped one open.
 */
export const TOOLTIP_DISABLED_KEY: InjectionKey<Readonly<Ref<boolean>>> =
  Symbol("lunarwerx-tooltip-disabled")

/** Hold time before a press counts as "reveal", not "tap". Matches the platform long-press feel. */
export const LONG_PRESS_MS = 500

/**
 * How long after a gesture ends reka's closes stay refused. It only has to outlast the
 * pointerleave/click a release fires, which arrive within a few ms — but mobile browsers can still
 * defer the compatibility click, so this is generous rather than tight.
 */
export const PIN_GRACE_MS = 500

/**
 * Slop allowed before the reveal. A finger is never still; anything past this is the start of a
 * scroll or a drag, and the gesture is abandoned so the page keeps moving normally. Once the
 * tooltip is showing the gesture has committed and movement no longer cancels it — otherwise a
 * shifting finger would drop the swallow below and the release would fire the control's action.
 */
export const MOVE_TOLERANCE_PX = 10

/**
 * Eat the click that closes out a revealing gesture, so the control underneath does not also fire.
 *
 * Capture phase on `document`, the earliest point in the dispatch, is the only place that can stop
 * the event before it reaches the trigger, its ancestors, or reka's own click-to-close handler.
 *
 * Call this when the finger LIFTS, not when the tooltip appears: the click is a consequence of the
 * release, and a window opened at reveal time would already have expired under any hold long enough
 * to actually read the tooltip. Scoped to `trigger` and time-boxed because a gesture can end with
 * no click at all (the OS interrupts it, or the finger leaves the element first), and a listener
 * left armed would eat the next tap the user made anywhere else.
 */
export function swallowNextClick(trigger: HTMLElement | null): void {
  if (typeof document === "undefined") return
  let timer: ReturnType<typeof setTimeout> | undefined
  const onClick = (event: Event): void => {
    const target = event.target
    if (trigger && target instanceof Node && !trigger.contains(target)) return
    event.preventDefault()
    event.stopPropagation()
    release()
  }
  const release = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    document.removeEventListener("click", onClick, true)
  }
  document.addEventListener("click", onClick, true)
  timer = setTimeout(release, 700)
}

/**
 * Whether this device has a coarse pointer at all. Shared app-wide rather than per trigger: a
 * dashboard renders dozens of tooltip triggers (six per repo card), and one MediaQueryList each
 * would be pure waste. Deliberately not @vueuse's useMediaQuery, whose listener is bound to
 * whichever component scope happened to call it first and would be torn down when that one
 * unmounts, leaving every later caller reading a ref that no longer updates.
 */
let coarsePointer: Ref<boolean> | undefined
export function useCoarsePointer(): Ref<boolean> {
  if (!coarsePointer) {
    const matches = ref(false)
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const query = window.matchMedia("(any-pointer: coarse)")
      matches.value = query.matches
      query.addEventListener("change", (event) => {
        matches.value = event.matches
      })
    }
    coarsePointer = matches
  }
  return coarsePointer
}
