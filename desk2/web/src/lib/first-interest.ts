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
 *    for the overlay roots. Pointer-enter does NOT always come before a press (a press with no move
 *    before it, such as a click right after a wheel scroll, sends enter and down back to back), so the
 *    swap never happens while a press is in progress: a press runs on the stand-in (which carries the
 *    control's own listeners, so its click completes there), the swap follows the release, and only
 *    what opens an overlay is replayed: a click on a menu trigger that the stand-in's own click could not
 *    open (reka 2.10 opens a dropdown on click), a context menu the stand-in could not open.
 *  - On the trigger itself, via `<InterestSlot :listeners="listeners">`: it renders the default slot's
 *    one element with the listeners added. `Tip` does this and passes `{ replay: true }`.
 *
 * Mounting the overlay swaps the trigger for a NEW element (Vue cannot reparent a slot), so right
 * after arming the composable puts back what the swap would lose: focus goes back to the same
 * descendant of the component's root element (found by its child-index path) when the swap left it on
 * the page body, and with
 * `replay: true` the arming event is replayed on the new root: a pointer-enter becomes a pointermove
 * (reka opens a tooltip on that, after its normal delay), a key is re-dispatched.
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

// An Element, not only an HTMLElement: a press often lands on an icon's SVG shape inside the button.
function resolve(root: HTMLElement, path: number[]): Element | null {
  let cur: Element = root
  for (const i of path) {
    const next = cur.children[i]
    if (!next) return null
    cur = next
  }
  return cur
}

function replayOn(event: Event, target: HTMLElement, targetPath: number[] | null): void {
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
      // The press already ran its click on the stand-in. Only a menu trigger still needs one (reka 2.10
      // opens a dropdown on click, not pointerdown), and not one that is already open (its menu root lived
      // outside the swap).
      const hit = targetPath ? resolve(target, targetPath) : null
      const trigger = hit?.closest<HTMLElement>('[aria-haspopup]')
      if (trigger && target.contains(trigger) && trigger.getAttribute('aria-expanded') !== 'true') {
        trigger.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }))
      }
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

function replayMenu(menu: MouseEvent, root: HTMLElement): void {
  const under = document.elementFromPoint(menu.clientX, menu.clientY)
  const target = under && root.contains(under) ? under : root
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: menu.clientX,
      clientY: menu.clientY,
      button: menu.button,
      buttons: menu.buttons,
      ctrlKey: menu.ctrlKey,
      shiftKey: menu.shiftKey,
      altKey: menu.altKey,
      metaKey: menu.metaKey,
    })
  )
}

type Listeners = Record<string, (event: any) => void>

/**
 * Arming swaps the stand-in for a new element and mounts everything inside it again, so a menu or
 * popover in there that is open (the press that just ran on the stand-in opened it) would close. Nothing
 * arms while one is open; the first hover or focus after it closes arms it.
 */
function holdsOpen(standIn: Element | null): boolean {
  return !!standIn?.querySelector('[aria-expanded="true"]')
}
type Fire = (event: Event, from: HTMLElement | null, menu: MouseEvent | null) => void

/**
 * The listeners that arm one control. A press must finish on the element it started on, or the browser
 * sends its click to a common ancestor; so a pointer-down (or a context-menu request) is let through
 * first and the arming (the swap) waits until the pointer is up. Meanwhile a context menu the stand-in
 * could not open is held back and handed to `fire`, which replays it on the new element. A hover is
 * armed one task later and not at all with a button down, so a press that arrives back to back with its
 * pointer-enter (no move before it) finds the stand-in still there. Focus that a press causes is ignored.
 */
function listenersFor(armed: () => boolean, fire: Fire, interest: Interest[]): Listeners {
  const listeners: Listeners = {}
  let pressing = false
  let hover = 0

  function now(event: Event): void {
    if (armed() || pressing) return
    const from = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    if (!holdsOpen(from)) fire(event, from, null)
  }

  function press(event: Event): void {
    if (armed() || pressing) return
    clearTimeout(hover)
    pressing = true
    const from = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    let menu: MouseEvent | null = null
    // Bubble phase on window: it runs after the stand-in's own handlers, so a menu they already opened
    // (defaultPrevented) is not opened twice.
    const onMenu = (e: Event): void => {
      if (e.defaultPrevented || menu) return
      menu = e as MouseEvent
      e.preventDefault()
    }
    const touch = event instanceof PointerEvent && event.pointerType === 'touch'
    let fallback = 0
    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      clearTimeout(fallback)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('click', stop, true)
      window.removeEventListener('pointercancel', stop, true)
      window.removeEventListener('blur', stop)
      // One task later, after the click (and a context menu that comes with the release) went out.
      setTimeout(() => {
        window.removeEventListener('contextmenu', onMenu)
        pressing = false
        if (!armed() && !holdsOpen(from)) fire(event, from, menu)
      }, 0)
    }
    // A tap's click comes well after its pointerup (the browser sends the compatibility mouse events late)
    // and would toggle shut a menu the swap had just opened, so a touch waits for that click. A long press
    // that brings no click is let go half a second after the release.
    const release = (): void => {
      if (!touch) return stop()
      clearTimeout(fallback)
      fallback = window.setTimeout(stop, 500)
    }
    window.addEventListener('pointerup', release, true)
    if (touch) window.addEventListener('click', stop, true)
    window.addEventListener('pointercancel', stop, true)
    window.addEventListener('blur', stop)
    window.addEventListener('contextmenu', onMenu)
    if (event.type === 'contextmenu') stop()
  }

  if (interest.includes('hover')) {
    listeners.pointerenter = (event: PointerEvent) => {
      if (event.buttons) return
      const from = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
      clearTimeout(hover)
      hover = window.setTimeout(() => {
        if (!armed() && !pressing && !holdsOpen(from)) fire(event, from, null)
      }, 0)
    }
  }
  if (interest.includes('focus')) listeners.focusin = now
  if (interest.includes('press')) {
    listeners.pointerdown = press
    listeners.contextmenu = press
  }
  if (interest.includes('key')) {
    listeners.keydown = (event: KeyboardEvent) => {
      if (KEYS.has(event.key)) now(event)
    }
  }
  return listeners
}

/** Flip to seen, then put back what swapping the trigger for a new element loses (see the doc above). */
function settle(
  event: Event,
  before: HTMLElement | null,
  after: () => HTMLElement | null,
  replay: boolean,
  menu: MouseEvent | null
): void {
  const active = document.activeElement
  const focusPath = before && active && before.contains(active) ? pathTo(before, active) : null
  const targetPath = before && event.target instanceof Element ? pathTo(before, event.target) : null
  void nextTick(() => {
    const root = after()
    if (!root) return
    // Only focus the swap lost: if the press opened something that took focus, leave it there.
    const lost = !document.activeElement || document.activeElement === document.body
    const focusTo = focusPath && lost ? resolve(root, focusPath) : null
    if (focusTo instanceof HTMLElement || focusTo instanceof SVGElement) focusTo.focus({ preventScroll: true })
    if (menu) replayMenu(menu, root)
    else if (replay || event.type === 'pointerdown') replayOn(event, root, targetPath)
  })
}

export function useFirstInterest(options: FirstInterestOptions = {}): {
  seen: Ref<boolean>
  listeners: Listeners
} {
  const instance = getCurrentInstance()
  const seen = ref(false)
  const root = (): HTMLElement | null => firstElement((instance?.vnode.el as Node | null) ?? null)

  function arm(event: Event, _from: HTMLElement | null, menu: MouseEvent | null): void {
    if (seen.value) return
    const before = root()
    seen.value = true
    settle(event, before, root, options.replay === true, menu)
  }

  return { seen, listeners: listenersFor(() => seen.value, arm, options.interest ?? ['hover', 'focus', 'press', 'key']) }
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
        found = listenersFor(
          () => ids.has(id),
          (event, from, menu) => {
            if (ids.has(id)) return
            const parent = from?.parentElement ?? null
            ids.add(id)
            settle(event, parent, () => parent, false, menu)
          },
          interest
        )
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
