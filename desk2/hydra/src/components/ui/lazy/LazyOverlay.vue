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
// - The first interaction is not lost. The real trigger is a NEW element (Vue cannot reparent the
//   slot), so once it is mounted the arming event is replayed on it: hover becomes a pointermove (reka
//   opens a tooltip on that, after its normal delay), press and key are re-dispatched as clones, and
//   focus is handed back with focus() if the stand-in held it.
// - Touch needs nothing extra: pointerenter always precedes pointerdown, and the overlay is mounted
//   between them, so the long-press / tap gestures of ui/tooltip/touch.ts see their own pointerdown.
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
  ref,
  Text,
} from "vue"
import type { PropType, VNode } from "vue"

export type LazyOverlayInterest = "hover" | "focus" | "press" | "key"

const KEYS = new Set(["Enter", " ", "ArrowDown"])

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

function replay(event: Event | null, target: HTMLElement, hadFocus: boolean): void {
  if (hadFocus) target.focus({ preventScroll: true })
  if (!event) return
  if (event instanceof PointerEvent) {
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }
    if (event.type === "pointerdown") {
      target.dispatchEvent(new PointerEvent("pointerdown", init))
    } else if (event.pointerType !== "touch") {
      // The new trigger is under a pointer that has not moved, so no pointermove will come by itself.
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (under && target.contains(under)) target.dispatchEvent(new PointerEvent("pointermove", init))
    }
  } else if (event instanceof KeyboardEvent) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }),
    )
  }
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
  },
  setup(props, { slots }) {
    const armed = ref(false)
    const instance = getCurrentInstance()

    function arm(event: Event): void {
      if (armed.value) return
      const from = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
      const hadFocus = !!from && from.contains(document.activeElement)
      armed.value = true
      void nextTick(() => {
        const target = firstElement((instance?.vnode.el as Node | null) ?? null)
        if (target) replay(event, target, hadFocus)
      })
    }

    const on = (kind: LazyOverlayInterest) => props.interest.includes(kind)

    return () => {
      if (armed.value) return h(Fragment, null, slots.default?.())
      const nodes = elements(slots.closed?.())
      const only = nodes[0]
      if (nodes.length !== 1 || !only || typeof only.type === "symbol" || typeof only.type === "string" && false) {
        return h(Fragment, null, slots.default?.())
      }
      const listeners: Record<string, unknown> = {}
      if (on("hover")) listeners.onPointerenter = arm
      if (on("focus")) listeners.onFocus = arm
      if (on("press")) listeners.onPointerdown = arm
      if (on("key")) {
        listeners.onKeydown = (event: KeyboardEvent) => {
          if (KEYS.has(event.key)) arm(event)
        }
      }
      return cloneVNode(only, { ...props.standIn, ...listeners })
    }
  },
})
</script>
