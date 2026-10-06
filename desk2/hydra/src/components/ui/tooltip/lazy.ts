import type { InjectionKey, Ref } from "vue"

/**
 * Provided by `Tooltip.vue`, read by its trigger and content. Until a tooltip is armed (its first hover,
 * focus, press or key, or its owner opening it with `open`) there is no reka root: the trigger renders a
 * stand-in with the arming listeners, the content renders nothing. See lib/lazy-arm.ts for how each first
 * gesture completes.
 */
export interface TooltipLazyContext {
  armed: Readonly<Ref<boolean>>
  /** Mount the reka root; the arming event is replayed on the real trigger when it mounts. */
  arm: (event: Event | null, hadFocus: boolean, as?: "click", pressed?: boolean) => void
  /** The real trigger, once mounted, takes the event to replay (once). */
  takePending: () => { event: Event | null; hadFocus: boolean; as?: "click"; pressed?: boolean } | null
  /** Close it again: the arming press gave the new trigger focus back, which opens a tooltip at once. */
  dismiss: () => void
}

export const TOOLTIP_LAZY_KEY: InjectionKey<TooltipLazyContext> = Symbol("lunarwerx-tooltip-lazy")
