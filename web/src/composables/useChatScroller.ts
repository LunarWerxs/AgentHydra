// useChatScroller - one owner for WHERE a chat transcript sits, so the rules live in one place
// instead of in each caller's "measure, fetch, nextTick, scrollTo" dance. The ideas (follow only
// while the reader is at the bottom, keep the reader's place when older turns are prepended,
// anchor to a chosen message, a jump-to-latest affordance, a pending flag until the opening
// position is applied) follow shadcn-ui's MessageScroller; this is written fresh for Vue.
//
// Headless: it owns no markup. The view binds `atBottom`, `unseen` and `pending` and calls the
// verbs; every measurement goes through the small pure helpers below so they can be tested
// against a plain object instead of a browser.

import type { Ref } from 'vue'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/** The three numbers every decision here is made from. An HTMLElement is one. */
export interface ScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** How close to the end still counts as "at the end". A streaming reply grows the page by a line or
 *  two between polls, and a reader parked a hair above the last line still means "keep me here". */
export const FOLLOW_THRESHOLD_PX = 120

export function distanceFromBottom(el: ScrollBox): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export function isAtBottom(el: ScrollBox, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(el) < threshold
}

/** Taken BEFORE older content is prepended: the reader's offset from the END of the content, which
 *  is the one distance a prepend does not change. */
export function capturePrependAnchor(el: ScrollBox): number {
  return el.scrollHeight - el.scrollTop
}

/** Applied AFTER the prepend has rendered: the same message stays under the reader's eye instead of
 *  the view jumping by the height of everything that was added above it. */
export function restorePrependAnchor(el: ScrollBox, anchor: number): void {
  el.scrollTop = Math.max(0, el.scrollHeight - anchor)
}

export function useChatScroller(el: Ref<HTMLElement | null>) {
  // True until the caller reports the opening position applied. Bound as data-pending-scroll so
  // styling, screenshots and tests can tell "not positioned yet" from "positioned at the top".
  const pending = ref(true)
  const atBottom = ref(true)
  // New turns that arrived while the reader was scrolled up, for the jump-to-latest badge.
  const unseen = ref(0)

  function measure() {
    const box = el.value
    atBottom.value = !box || isAtBottom(box)
    if (atBottom.value) unseen.value = 0
  }

  // The listener follows the element: the transcript pane is v-if'd in and out as sessions open.
  watch(
    el,
    (next, prev) => {
      prev?.removeEventListener('scroll', measure)
      next?.addEventListener('scroll', measure, { passive: true })
      measure()
    },
    { immediate: true },
  )
  onBeforeUnmount(() => el.value?.removeEventListener('scroll', measure))

  function scrollToLatest() {
    const box = el.value
    if (box) box.scrollTop = box.scrollHeight
    measure()
  }

  /** A fresh open: start at the end, or at the message `land` anchors to when it finds one, and
   *  say so once it has rendered. `update` answers false when its content was superseded, so a
   *  stale load leaves the position to the newer one. */
  async function open(update: () => Promise<boolean>, land?: () => boolean) {
    pending.value = true
    unseen.value = 0
    if (!(await update())) return
    await nextTick()
    if (!land?.()) scrollToLatest()
    pending.value = false
  }

  /** New content at the END (a poll, a streaming reply): stick to the end only if the reader was
   *  already there when the update started; otherwise leave them where they are and count it. */
  async function follow(update: () => Promise<'skipped' | 'same' | 'grew'>) {
    const box = el.value
    const wasAtBottom = !box || isAtBottom(box)
    const result = await update()
    if (result === 'skipped') return
    await nextTick()
    if (wasAtBottom) scrollToLatest()
    else if (result === 'grew') unseen.value++
  }

  /** Older content at the START (history paging): keep the reader's message where it was. */
  async function prepend(update: () => Promise<boolean>) {
    const box = el.value
    const anchor = box ? capturePrependAnchor(box) : 0
    if (!(await update())) return
    await nextTick()
    if (el.value) restorePrependAnchor(el.value, anchor)
    measure()
  }

  /** Bring one chosen message into view, e.g. the hit a search opened the transcript for. */
  function anchorTo(selector: string): boolean {
    const target = el.value?.querySelector(selector)
    if (!target) return false
    target.scrollIntoView({ block: 'center' })
    measure()
    return true
  }

  return { pending, atBottom, unseen, measure, scrollToLatest, open, follow, prepend, anchorTo }
}
