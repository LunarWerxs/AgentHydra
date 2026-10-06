// Shared by LazyOverlay and the kit Tooltip: how the FIRST gesture on a closed, never-mounted overlay
// arms it, and how that gesture is completed once the real trigger exists.
//
// Mouse and pen never swap the stand-in while a press is in progress on it. The stand-in carries the
// trigger's own listeners (a wrapped button's click handler, a popover's hover timers), so the press
// finishes there, natively and once; only then is the overlay armed and only what OPENS it replayed:
// a click for a menu or popover trigger (reka 2.10 opens both on click), nothing for a tooltip. A hover arms
// one task later, so a pointerenter that Chromium sends back to back with a pointerdown (a control that
// came under a resting pointer) is still followed by its press on the stand-in. Touch arms on its
// pointerdown, not its pointerenter: Chromium hit-tests a pointer event's target before it sends the
// boundary events, so a stand-in swapped during pointerenter would still receive the pointerdown, already
// detached, and so would the pointermove/up/cancel that follow (a touch pointer is captured by its
// pointerdown target; an event to a detached node never reaches window). The pointerdown is replayed on the
// real trigger, and the rest of that one pointer's gesture is forwarded to it from the detached stand-in
// itself (see `forwardTouch`), so the long-press and tap rules of ui/tooltip/touch.ts see all of it.

export type LazyInterest = "hover" | "focus" | "press" | "key"
/** What a first press must do on the real trigger: `click` opens a menu or a popover (reka 2.10 opens both on
 *  click, not pointerdown), `none` a tooltip or a control whose own click already ran on the stand-in. */
export type FirstPress = "click" | "none"

const KEYS = new Set(["Enter", " ", "ArrowDown"])

/**
 * Arming swaps the stand-in for the real trigger, and Vue cannot reparent a slot, so everything inside
 * the stand-in is mounted again. A menu or popover in there that is open (the press that just ran on the
 * stand-in opened it: a gear popover inside a lazy tooltip) would close. So nothing arms while one is
 * open; the first hover or focus after it closes arms it.
 */
export function holdsOpen(standIn: Element | null): boolean {
  return !!standIn?.querySelector('[aria-expanded="true"]')
}

function pointerInit(event: PointerEvent): PointerEventInit {
  return {
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
}

/** A touch pointerdown that armed an overlay -> what to call with the element it was replayed onto. */
const touchForwarders = new WeakMap<PointerEvent, (target: HTMLElement) => void>()

export function replay(event: Event | null, target: HTMLElement, hadFocus: boolean, as?: "click"): void {
  // Only focus the swap lost: a press that already opened something (a popover beside a lazy tooltip) has
  // moved focus into it, and taking it back would close it as a focus outside.
  const lost = !document.activeElement || document.activeElement === document.body
  if (hadFocus && lost) target.focus({ preventScroll: true })
  if (!event) return
  if (event instanceof PointerEvent) {
    const init = pointerInit(event)
    if (as === "click") {
      target.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 }))
    } else if (event.type === "pointerdown") {
      target.dispatchEvent(new PointerEvent("pointerdown", init))
      touchForwarders.get(event)?.(target)
      touchForwarders.delete(event)
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

export interface LazyArming {
  onPointerenter: (event: PointerEvent) => void
  onPointerdown: (event: PointerEvent) => void
  onFocus: (event: FocusEvent) => void
  onKeydown: (event: KeyboardEvent) => void
  dispose: () => void
}

export function createLazyArming(opts: {
  isArmed: () => boolean
  /** Mount the real overlay; `event` is what to replay on the new trigger (`as` turns a pointerup into a click). */
  arm: (event: Event | null, hadFocus: boolean, as?: "click") => void
  firstPress?: () => FirstPress
}): LazyArming {
  let standIn: HTMLElement | null = null
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let pressing = false
  let stopPress: (() => void) | null = null
  /** Set by dispose: a press that ends after the overlay unmounted arms nothing. */
  let disposed = false

  function fire(event: Event | null, as?: "click"): void {
    if (disposed || opts.isArmed() || holdsOpen(standIn)) return
    const hadFocus = !!standIn && standIn.contains(document.activeElement)
    opts.arm(event, hadFocus, as)
  }
  function note(event: Event): void {
    if (event.currentTarget instanceof HTMLElement) standIn = event.currentTarget
  }
  function clearHover(): void {
    if (hoverTimer !== undefined) clearTimeout(hoverTimer)
    hoverTimer = undefined
  }

  let stopTouch: (() => void) | null = null
  /**
   * The swap detaches the stand-in that a touch pointer is captured to, so its move, up and cancel never
   * reach the real trigger by themselves: listen on the stand-in and re-send them, same pointer only.
   */
  function forwardTouch(event: PointerEvent): void {
    const from = standIn
    if (!from) return
    touchForwarders.set(event, (target) => {
      stopTouch?.()
      const send = (e: Event): void => {
        if (!(e instanceof PointerEvent) || e.pointerId !== event.pointerId) return
        target.dispatchEvent(new PointerEvent(e.type, pointerInit(e)))
        if (e.type !== "pointermove") stopTouch?.()
      }
      const types = ["pointermove", "pointerup", "pointercancel"]
      for (const type of types) from.addEventListener(type, send)
      stopTouch = () => {
        for (const type of types) from.removeEventListener(type, send)
        stopTouch = null
      }
    })
  }

  function onPointerenter(event: PointerEvent): void {
    if (opts.isArmed() || pressing) return
    note(event)
    if (event.pointerType === "touch") return
    clearHover()
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined
      if (!pressing) fire(event)
    }, 0)
  }

  function onPointerdown(event: PointerEvent): void {
    if (opts.isArmed()) return
    note(event)
    if (event.pointerType === "touch") {
      forwardTouch(event)
      return fire(event)
    }
    clearHover()
    stopPress?.()
    pressing = true
    const mode = opts.firstPress?.() ?? "none"
    const end = (up: Event): void => {
      stopPress?.()
      // After the click that follows this pointerup has run on the stand-in.
      setTimeout(() => {
        pressing = false
        const inside = up.type === "pointerup" && up.target instanceof Node && !!standIn?.contains(up.target)
        const plain = event.button === 0 && inside
        if (plain && mode === "click") fire(up, "click")
        else fire(null)
      }, 0)
    }
    window.addEventListener("pointerup", end, true)
    window.addEventListener("pointercancel", end, true)
    stopPress = () => {
      window.removeEventListener("pointerup", end, true)
      window.removeEventListener("pointercancel", end, true)
      stopPress = null
    }
  }

  return {
    onPointerenter,
    onPointerdown,
    onFocus(event) {
      if (opts.isArmed() || pressing) return
      note(event)
      fire(event)
    },
    onKeydown(event) {
      if (!KEYS.has(event.key)) return
      note(event)
      fire(event)
    },
    dispose() {
      disposed = true
      clearHover()
      stopPress?.()
      stopTouch?.()
    },
  }
}
