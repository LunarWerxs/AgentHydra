// Whether the transcript stays pinned to its bottom after a scroll event.
//
// A scroll event does not say who moved the content: Jacob, or the layout. When rows are measured
// shorter than their estimates the browser clamps scrollTop (an upward move), and if the content then
// grows again before the event is dispatched the distance from the bottom is large: reading that as
// "Jacob scrolled up" let go of the bottom and left a freshly opened chat somewhere in its middle.
// So an upward move only unpins when Jacob did it (wheel, touch, keys, dragging the scrollbar:
// `userDriven`); reaching the bottom always pins.

export const PIN_DISTANCE = 24

export function nextPinned(o: { pinned: boolean; top: number; lastTop: number; distance: number; userDriven: boolean }): boolean {
  if (o.distance <= PIN_DISTANCE) return true
  if (o.userDriven && o.top < o.lastTop - 1) return false
  return o.pinned
}
