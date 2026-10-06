<script lang="ts">
// Mount a closed overlay (tooltip, menu, popover) only when someone shows interest in it.
//
// A closed reka-ui overlay is a dozen components with their own reactive state, yet nothing of it
// shows until a hover, focus or click. Used per row of a long list that was thousands of components
// for nothing. This renders the TRIGGER ALONE until the first interest, then mounts the real overlay
// and keeps it mounted, so the second hover is exactly the ordinary one.
//
// Usage (two slots, the trigger is written twice because it is rendered once in either state):
//
//   <LazyOverlay :stand-in="{ 'data-slot': 'tooltip-trigger', 'data-state': 'closed' }">
//     <template #closed><slot /></template>         <!-- the single trigger element, nothing else -->
//     <Tooltip>                                      <!-- the real overlay, mounted on first interest -->
//       <TooltipTrigger as-child><slot /></TooltipTrigger>
//       <TooltipContent>...</TooltipContent>
//     </Tooltip>
//   </LazyOverlay>
//
// - `#closed` must be ONE element or component; the helper adds its listeners to it and (via `stand-in`) the
//   attributes reka would have set while closed (aria-haspopup, aria-expanded, data-state, data-slot...).
//   Anything else (several nodes, nothing) mounts the real overlay at once, which is just today's behaviour.
// - `interest` says what arms it: `hover` (pointer enters), `focus`, `press` (pointerdown), `key`
//   (Enter, Space or ArrowDown). Default: hover, focus, press. A menu adds `key`; a tooltip is fine as is.
// - `armed`: the owner opens the overlay without touching the trigger (InstanceRow's right-click sets
//   its menu's model). While true the real overlay is mounted at once, nothing to replay.
// - The first gesture is not lost. The real trigger is a NEW element (Vue cannot reparent the slot).
//   Which gestures arm it and how each first gesture completes (details in lib/lazy-arm.ts):
//   * hover (mouse, pen): arms one task after pointerenter and replays a pointermove, so reka opens a
//     tooltip after its normal delay. A press that begins first cancels it.
//   * press (mouse, pen): the stand-in is NEVER swapped while the button is down, so the control's own
//     click handler runs once, natively, on the stand-in. After the release it arms and replays only
//     what opens the overlay, per `firstPress`: a pointerdown (menu), a click (popover), nothing.
//   * focus (not during a press) and key (Enter, Space, ArrowDown): arm at once, focus is handed back
//     with focus() and the key is re-dispatched as a clone.
//   * touch: arms at once on pointerenter, which precedes the pointerdown, so the tap and the
//     long-press of ui/tooltip/touch.ts see their own pointerdown on the real trigger.
// - A trigger whose root swallows fallthrough attributes (inheritAttrs: false) would never arm; wrap
//   it or mount the overlay directly.
import {
  cloneVNode,
  Comment,
  defineComponent,
  Fragment,
  getCurrentInstance,
  h,
  nextTick,
  onBeforeUnmount,
  ref,
  Text,
  watch,
} from "vue"
import type { PropType, VNode } from "vue"
import { createLazyArming, replay } from "@/lib/lazy-arm"
import type { FirstPress, LazyInterest } from "@/lib/lazy-arm"

export type LazyOverlayInterest = LazyInterest

function elements(nodes: VNode[] | undefined, out: VNode[] = []): VNode[] {
  for (const node of nodes ?? []) {
    if (node.type === Comment) continue
    if (node.type === Text && !String(node.children ?? "").trim()) continue
    if (node.type === Fragment && Array.isArray(node.children)) elements(node.children as VNode[], out)
    else out.push(node)
  }
  return out
}

function firstElement(node: Node | null): HTMLElement | null {
  let cur = node
  while (cur) {
    if (cur instanceof HTMLElement) return cur
    cur = cur.nextSibling
  }
  return null
}

export default defineComponent({
  name: "LazyOverlay",
  inheritAttrs: false,
  props: {
    interest: {
      type: Array as PropType<LazyOverlayInterest[]>,
      default: () => ["hover", "focus", "press"],
    },
    /** Attributes the real trigger carries while closed, set on the stand-in. */
    standIn: { type: Object as PropType<Record<string, unknown>>, default: () => ({}) },
    /** What a first mouse press must do on the real trigger: `pointerdown` (a menu), `click` (a popover)
     *  or `none` (a tooltip, or a wrapped control that runs its own click on the stand-in). */
    firstPress: { type: String as PropType<FirstPress>, default: "none" },
    /** The owner opens the overlay from outside the trigger (a right-click, a model, a shortcut): true
     *  mounts the real overlay at once, with nothing to replay, and it stays mounted. */
    armed: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const armed = ref(props.armed)
    const instance = getCurrentInstance()
    watch(
      () => props.armed,
      (is) => {
        if (is) armed.value = true
      },
    )

    const arming = createLazyArming({
      isArmed: () => armed.value,
      firstPress: () => props.firstPress,
      arm(event, hadFocus, as) {
        armed.value = true
        void nextTick(() => {
          const target = firstElement((instance?.vnode.el as Node | null) ?? null)
          if (target) replay(event, target, hadFocus, as)
        })
      },
    })
    onBeforeUnmount(arming.dispose)

    const on = (kind: LazyOverlayInterest) => props.interest.includes(kind)

    return () => {
      if (armed.value || props.armed) return h(Fragment, null, slots.default?.())
      const nodes = elements(slots.closed?.())
      const only = nodes[0]
      if (nodes.length !== 1 || !only || typeof only.type === "symbol") {
        return h(Fragment, null, slots.default?.())
      }
      const listeners: Record<string, unknown> = {}
      if (on("hover")) listeners.onPointerenter = arming.onPointerenter
      if (on("focus")) listeners.onFocus = arming.onFocus
      if (on("press")) listeners.onPointerdown = arming.onPointerdown
      if (on("key")) listeners.onKeydown = arming.onKeydown
      return cloneVNode(only, { ...props.standIn, ...listeners })
    }
  },
})
</script>
