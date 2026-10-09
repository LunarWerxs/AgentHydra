// The mark a working chat shows (the Working row under a turn, the line over an outside session's composer):
// one look for the whole window, chosen by the five-minute slot a moment falls in: shuffled, so it reads as random, never
// the same look twice in a row, and every mark in the window swaps together at the
// boundary. Owner, 2026-10-08: "instead of an option for animation, just occasionally have it, randomly one
// and use that one for a few minutes, across all, then swap, etc." (it had been picked in Settings -> General
// -> Appearance and remembered in this window; that picker and its localStorage key are gone with it).
import { ref } from 'vue'

export type WorkingMarkVariant = 'square' | 'orbit' | 'wave' | 'ripple' | 'breathe' | 'tumble' | 'spark'

/** The looks, in the order the slot picker walks them. */
export const WORKING_MARKS: WorkingMarkVariant[] = ['square', 'orbit', 'wave', 'ripple', 'breathe', 'tumble', 'spark']

/** How long one look lasts before the next slot picks another. */
export const WORKING_MARK_PERIOD_MS = 5 * 60 * 1000

// A splitmix-style integer hash: deterministic, and spread enough that neighbouring inputs land anywhere.
function hash(x: number): number {
  x = Math.imul(x, 0x9e3779b1) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x85ebca6b) >>> 0
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** Every look once, in an order shuffled by the block number (a Fisher-Yates shuffle on the hash). */
function blockOrder(block: number): WorkingMarkVariant[] {
  const order = [...WORKING_MARKS]
  for (let i = order.length - 1; i > 0; i--) {
    const j = hash(block * 31 + i) % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** Pure: which look the time slot shows. Slots run in blocks of one of each look, shuffled, so it reads as random and
    a look never shows twice in a row inside a block; a block whose first look is the last of the block before swaps
    its first two (that swap never moves a block's last look, so the one compared with is always the same). */
export function workingMarkForSlot(slot: number): WorkingMarkVariant {
  const n = WORKING_MARKS.length
  const block = Math.floor(slot / n)
  const order = blockOrder(block)
  if (order[0] === blockOrder(block - 1)[n - 1]) [order[0], order[1]] = [order[1], order[0]]
  return order[slot - block * n]
}

const slotNow = () => Math.floor(Date.now() / WORKING_MARK_PERIOD_MS)

/** The one look every mark in the window shows this slot. */
export const workingMark = ref<WorkingMarkVariant>(workingMarkForSlot(slotNow()))

// One timer for the whole window, re-arming itself for the next boundary: no mark keeps its own clock. Browser
// only: the tests read this file without a window, where a timer would only hold the run open.
if (typeof window !== 'undefined') {
  const swap = () => {
    workingMark.value = workingMarkForSlot(slotNow())
    // Re-arm on the true boundary, so a timer that fired a moment early cannot loop tight.
    setTimeout(swap, Math.max((slotNow() + 1) * WORKING_MARK_PERIOD_MS - Date.now(), 100))
  }
  setTimeout(swap, WORKING_MARK_PERIOD_MS - (Date.now() % WORKING_MARK_PERIOD_MS))
}
