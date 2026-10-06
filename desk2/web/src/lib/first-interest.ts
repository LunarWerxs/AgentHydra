import { getCurrentInstance, h, nextTick, reactive, ref } from 'vue'
import type { Ref, VNode } from 'vue'
import { Comment, Fragment, Text, cloneVNode, defineComponent } from 'vue'

/**
 * Mount a closed overlay (tooltip, context menu, dropdown) only after someone shows interest in it.
 *
 * A closed reka-ui overlay is a dozen components that show nothing until a hover, focus or click; per
 * row of a long list that was thousands of components. `useFirstInterest()` gives a component a `seen`
 * flag that flips on the first pointer-enter, focus, pointer-down or key on the element it is bound
 * to, and stays true. Render the bare trigger while `seen` is false and the real overlay after.
 *
 *   const { seen, listeners } = useFirstInterest()
 *
 * Two ways to arm it:
 *  - On an enclosing element, such as a sidebar row: put `v-on="listeners"` on the element that is
 *    there before the overlay mounts (the row's wrapper, or the trigger itself) and branch on `seen`
 *    for the overlay roots. The overlay is mounted by the time the first right-click or click lands
 *    (pointer-enter and focus always come first), so that first one needs no replay.
 *  - On the trigger itself, via `<InterestSlot :listeners="listeners">`: it renders the default slot's
 *    one element with the listeners added. `Tip` does this and passes `{ replay: true }`.
 *
 * Mounting the overlay swaps the trigger for a NEW element (Vue cannot reparent a slot), so right
 * after arming the composable puts back what the swap would lose: focus goes back to the same
 * descendant of the component's root element (found by its child-index path), and with
 * `replay: true` the arming event is replayed on the new root: a pointer-enter becomes a pointermove
 * (reka opens a tooltip on that, after its normal delay), a pointer-down or key is re-dispatched.
 *
 * `useFirstInterestSet()` is the same for rows drawn by a `v-for` inside one component.
 *
 * Call it from `setup`: the root element is the component's first rendered element, so a component
 * whose root is the armed element or a fragment around it just works. `interest` narrows what arms
 * it (default hover, focus, press and key); `key` means Enter, Space, ArrowDown, ContextMenu or
 * Shift+F10.
 *
 * Nothing global is held: the listeners live on the bound element.
 */
export type Interest = 'hover' | 'focus' | 'press' | 'key'

export interface FirstInterestOptions {
  interest?: Interest[]
  /** Re-send the arming pointer/key event to the new root once the overlay is mounted. */
  replay?: boolean
}

const KEYS = new Set(['Enter', ' ', 'ArrowDown', 'ContextMenu', 'F10'])

function firstElement(node: Node | null): HTMLElement | null {
  let cur = node
  while (cur) {
    if (cur instanceof HTMLElement) return cur
    cur = cur.nextSibling
  }
  return null
}

function pathTo(root: HTMLElement, el: Element): number[] | null {
  const path: number[] = []
  let cur: Element | null = el
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, cur))
    cur = parent
  }
  return cur === root ? path : null
}

function resolve(root: HTMLElement, path: number[]): HTMLElement | null {
  let cur: Element = root
  for (const i of path) {
    const next = cur.children[i]
    if (!next) return null
    cur = next
  }
  return cur instanceof HTMLElement ? cur : null
}

function replayOn(event: Event, target: HTMLElement): void {
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
    if (event.type === 'pointerdown') {
      target.dispatchEvent(new PointerEvent('pointerdown', init))
    } else if (event.pointerType !== 'touch') {
      // The new trigger sits under a pointer that has not moved, so no pointermove comes by itself.
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (under && target.contains(under)) target.dispatchEvent(new PointerEvent('pointermove', init))
    }
  } else if (event instanceof KeyboardEvent) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      })
    )
  }
}

type Listeners = Record<string, (event: any) => void>

function listenersFor(arm: (event: Event) => void, interest: Interest[]): Listeners {
  const listeners: Listeners = {}
  if (interest.includes('hover')) listeners.pointerenter = arm
  if (interest.includes('focus')) listeners.focusin = arm
  if (interest.includes('press')) listeners.pointerdown = arm
  if (interest.includes('key')) {
    listeners.keydown = (event: KeyboardEvent) => {
      if (KEYS.has(event.key)) arm(event)
    }
  }
  return listeners
}

/** Flip to seen, then put back what swapping the trigger for a new element loses (see the doc above). */
function settle(event: Event, before: HTMLElement | null, after: () => HTMLElement | null, replay: boolean): void {
  const active = document.activeElement
  const focusPath = before && active && before.contains(active) ? pathTo(before, active) : null
  void nextTick(() => {
    const root = after()
    if (!root) return
    if (focusPath) resolve(root, focusPath)?.focus({ preventScroll: true })
    if (replay) replayOn(event, root)
  })
}

export function useFirstInterest(options: FirstInterestOptions = {}): {
  seen: Ref<boolean>
  listeners: Listeners
} {
  const instance = getCurrentInstance()
  const seen = ref(false)
  const root = (): HTMLElement | null => firstElement((instance?.vnode.el as Node | null) ?? null)

  function arm(event: Event): void {
    if (seen.value) return
    const before = root()
    seen.value = true
    settle(event, before, root, options.replay === true)
  }

  return { seen, listeners: listenersFor(arm, options.interest ?? ['hover', 'focus', 'press', 'key']) }
}

/**
 * The same for many rows drawn by one component (a `v-for` with no component per row): `seen(id)` and
 * `listeners(id)` are per row key. The armed element is replaced when its overlay mounts, so focus is
 * restored relative to its PARENT, which stays: bind the listeners on a row's outermost element and
 * keep that parent stable (a wrapper per row).
 */
export function useFirstInterestSet(options: { interest?: Interest[] } = {}): {
  seen: (id: string) => boolean
  listeners: (id: string) => Listeners
} {
  const ids = reactive(new Set<string>())
  const cache = new Map<string, Listeners>()
  const interest = options.interest ?? ['hover', 'focus', 'press', 'key']
  return {
    seen: (id) => ids.has(id),
    listeners(id) {
      let found = cache.get(id)
      if (!found) {
        found = listenersFor((event) => {
          if (ids.has(id)) return
          const parent = event.currentTarget instanceof HTMLElement ? event.currentTarget.parentElement : null
          ids.add(id)
          settle(event, parent, () => parent, false)
        }, interest)
        cache.set(id, found)
      }
      return found
    },
  }
}

function oneElement(nodes: VNode[] | undefined, out: VNode[] = []): VNode[] {
  for (const node of nodes ?? []) {
    if (node.type === Comment) continue
    if (node.type === Text && !String(node.children ?? '').trim()) continue
    if (node.type === Fragment && Array.isArray(node.children)) oneElement(node.children as VNode[], out)
    else out.push(node)
  }
  return out
}

/**
 * Renders its default slot's single element with the given `useFirstInterest` listeners added (as
 * `onPointerenter` and so on), and any extra `attrs` (what reka would have put on the closed trigger).
 * More than one node, or none, renders the slot as is: nothing arms, so the caller should mount the
 * overlay at once in that case (Tip never gets there; its slot is one element).
 */
export const InterestSlot = defineComponent({
  name: 'InterestSlot',
  inheritAttrs: false,
  props: {
    listeners: { type: Object as () => Listeners, required: true },
    standIn: { type: Object as () => Record<string, unknown>, default: () => ({}) },
  },
  setup(props, { slots }) {
    return () => {
      const nodes = oneElement(slots.default?.())
      const only = nodes[0]
      if (nodes.length !== 1 || !only || typeof only.type === 'symbol') return h(Fragment, null, slots.default?.())
      const on: Record<string, unknown> = {}
      for (const [name, fn] of Object.entries(props.listeners)) on[`on${name[0].toUpperCase()}${name.slice(1)}`] = fn
      return cloneVNode(only, { ...props.standIn, ...on })
    }
  },
})
