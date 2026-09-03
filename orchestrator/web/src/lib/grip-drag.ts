// Everything a resize grip needs: hardened drag-to-resize pointer handling (useGripDrag) and the
// double-click reset's glide back to the natural size (useGripGlide). The ONLY sanctioned way to
// implement a resize grip in a family app — consumers are RepoYeti's changed-files tree grip, its
// History viewport grip, and its file-viewer edge grip.
//
// History: naive per-grip window-listener drags repeatedly "stuck" — the resize kept
// tracking the cursor after the mouse button was released, until the next stray click
// finally delivered a pointerup. A pointerup can be legitimately swallowed by the browser:
// a right/middle press whose release goes to a context menu or autoscroll overlay, a native
// drag or touch-gesture takeover (which fires pointercancel — or nothing), pointer capture
// silently dropped when the captured element is detached mid-drag (a v-if re-render), or
// the button being released outside the window after capture was lost. No single "correct"
// listener covers all of those, so this composable layers every end signal and treats the
// first one that fires as authoritative:
//   · pointerup / pointercancel on the window (bubbling from the capture target)
//   · lostpointercapture on the window — fires on ANY capture teardown, even when the
//     matching pointerup never arrives (window-level because a detached capture target
//     retargets this event to `document`, bypassing element-scoped listeners)
//   · a buttons-mask check on every pointermove: if the primary button is no longer held,
//     the release was missed — end the drag right there. This is the ultimate backstop: a
//     stuck drag cannot survive past the first mouse movement.
//   · window blur (alt-tab / focus steal mid-drag) and component unmount
// onEnd runs exactly once per started drag, no matter which signal ends it.

import { onBeforeUnmount, ref, type Ref } from "vue";

export interface GripDragHandlers {
  /** Capture the drag's starting state. Return false to reject the drag (missing refs etc.);
   *  any other value — or no return at all — lets the drag proceed. Typed `unknown` rather
   *  than `void | boolean`: only an explicit `false` is ever inspected, and the union form
   *  trips biome's noConfusingVoidType in the consuming apps. */
  onStart?: (e: PointerEvent) => unknown;
  /** Live tracking. Only called while the primary button is verifiably still held. */
  onMove: (e: PointerEvent) => void;
  /** Commit/cleanup. Called exactly once per started drag, however it ended. */
  onEnd: () => void;
}

/**
 * Returns the `pointerdown` handler to bind on the grip element. Bind nothing else — every
 * other listener is attached per-drag and always torn down, whichever way the drag ends.
 */
export function useGripDrag(handlers: GripDragHandlers): (e: PointerEvent) => void {
  let active: (() => void) | null = null; // teardown for the drag in flight

  // Idempotent + re-entrancy-safe: clear `active` before running teardown so a second end
  // signal (pointerup then lostpointercapture fire back-to-back on a normal release) no-ops.
  function end(): void {
    const teardown = active;
    active = null;
    teardown?.();
  }

  function onDown(e: PointerEvent): void {
    // Primary button of the primary pointer only. pointerdown also fires for right/middle
    // presses and extra touch points, and those routinely never get a pointerup (context
    // menu, autoscroll) — the original stuck-drag trigger.
    if (e.button !== 0 || !e.isPrimary) return;
    end(); // never stack two drags on one grip
    if (handlers.onStart?.(e) === false) return;

    const grip = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;

    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      // Primary button no longer down → its pointerup was swallowed somewhere. Stop now.
      if ((ev.buttons & 1) === 0) {
        end();
        return;
      }
      handlers.onMove(ev);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) end();
    };
    const finish = (): void => end();

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", finish);
    // On the WINDOW, not the grip: when the captured element is detached mid-drag (grips
    // tend to sit inside v-if'd wrappers) the spec retargets lostpointercapture to
    // `document`, so a grip-scoped listener would never see exactly the loss it exists to
    // catch. A window listener sees both routes — the normal element-targeted event bubbles
    // up, and the document-targeted one does too. Filtered by pointerId like pointerup above.
    window.addEventListener("lostpointercapture", up);

    // Keep events streaming to the grip even when the cursor leaves the window. If capture
    // is unavailable the window listeners + buttons check still bound the drag.
    try {
      grip.setPointerCapture?.(pointerId);
    } catch {
      /* stale pointerId or detached element — window listeners still cover the drag */
    }

    active = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", finish);
      window.removeEventListener("lostpointercapture", up);
      if (grip.hasPointerCapture?.(pointerId)) {
        try {
          grip.releasePointerCapture(pointerId);
        } catch {
          /* pointer already gone */
        }
      }
      handlers.onEnd();
    };

    e.preventDefault(); // no text selection / native drag while resizing
  }

  onBeforeUnmount(end);
  return onDown;
}

// ── the reset glide ───────────────────────────────────────────────────────────
// Double-clicking a grip drops the pinned px height and hands the element back to the stylesheet,
// which in practice means `height: auto` under a max-height cap. CSS cannot transition px → auto,
// so an unassisted reset lands as an instant jump however emphatic the `transition: height` rule
// is. This holds ONE more explicit px height — where the element is about to settle — for the
// length of that transition, so the same rule that smooths a drag also smooths the reset.
//
// The persisted override is released up front rather than when the glide finishes: a reload, an
// unmount or a second reset mid-animation then still leaves the stored state correct, and the held
// height keeps the picture steady until the element's own style arrives at the same number.

/** Glide duration. Keep in step with the `transition: height` rule on the resized viewports. */
export const GRIP_GLIDE_MS = 180;

/** Under this there is nothing to watch, so the reset just lands. */
const GLIDE_MIN_DELTA_PX = 2;

export interface GripGlide {
  /** Height held during the glide, in px. null = the element's own style applies again. */
  height: Ref<number | null>;
  /**
   * Release the override and glide to `to`. `from` is what the element measures right now
   * (`clientHeight`); pass null when that is unavailable and the reset lands immediately.
   */
  glideTo: (from: number | null | undefined, to: number, release: () => void) => void;
  /**
   * Abandon a glide in flight. Call it from a fresh drag's onStart AFTER pinning that drag's own
   * starting height, so the element never renders a frame of its untouched style in between.
   */
  cancel: () => void;
}

export function useGripGlide(): GripGlide {
  const height = ref<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    height.value = null;
  }

  function glideTo(from: number | null | undefined, to: number, release: () => void): void {
    cancel();
    release();
    if (from == null || Math.abs(to - from) < GLIDE_MIN_DELTA_PX || reducedMotion()) return;
    // The element is ALREADY rendered at `from`, so this single assignment is a complete
    // transition pair — no pin-then-retarget frame dance, nothing to wait a tick for.
    height.value = to;
    // `transitionend` is not dependable here (a live refresh or a second reset can interrupt the
    // property mid-flight and the event never arrives), so the hold expires on a timer with slack.
    timer = setTimeout(cancel, GRIP_GLIDE_MS + 60);
  }

  onBeforeUnmount(cancel);
  return { height, glideTo, cancel };
}

/** Respect the OS setting — with motion reduced, a reset simply lands. */
function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

/**
 * The height a scroll viewport will settle at once its explicit height is released: the content
 * extent, clamped to `cap` (the stylesheet's max-height). The glide needs this to be exact —
 * overshoot it and the reset still ends in the snap it exists to avoid.
 *
 * `scrollHeight` CANNOT answer this: it never reports less than the element's own clientHeight, so
 * a viewport dragged TALLER than its content just hands the drag height back. Measuring first
 * child's top to last child's bottom is independent of the viewport's current size, and the gaps
 * and margins between children fall inside the span for free.
 */
export function releasedHeight(el: HTMLElement | null | undefined, cap: number): number {
  if (!el) return cap;
  const kids = el.children;
  const first = kids[0]?.getBoundingClientRect();
  const last = kids[kids.length - 1]?.getBoundingClientRect();
  if (!first || !last) return Math.min(el.scrollHeight, cap);
  const style = getComputedStyle(el);
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return Math.min(Math.ceil(last.bottom - first.top + padding), cap);
}
