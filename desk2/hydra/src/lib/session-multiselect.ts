// web/src/lib/session-multiselect.ts - the range arithmetic behind Shift-click, Ctrl+A and box
// select in the session list.
//
// A Shift-click selects every row between the last row you deliberately clicked and this one,
// inclusive, in the order the list shows them. That is the whole contract, and it is the same one
// every file manager has, which is why it is pinned here as a pure function instead of living
// inline in a click handler: the component supplies the visible keys and the two endpoints, and
// gets back exactly the keys to add. Direction does not matter, and an anchor that has scrolled
// out of the filtered list (the filter changed under you) degrades to selecting just the clicked
// row rather than guessing at a range that no longer exists.

/** Keys between `anchor` and `target` in `keys`, inclusive, in list order. If `target` is not in
 *  the list nothing is selectable and the result is empty; if only the anchor is missing, the
 *  result is the target alone. */
export function rangeBetween(keys: readonly string[], anchor: string, target: string): string[] {
  const to = keys.indexOf(target)
  if (to < 0) return []
  const from = keys.indexOf(anchor)
  if (from < 0) return [target]
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return keys.slice(lo, hi + 1)
}

// SELECTION AS REQUESTS. Every gesture that changes the selection - Shift-click, Ctrl+A, a box
// dragged over the list - is turned into one of two requests the store applies itself, the way
// Dear ImGui's multi-select (ocornut/imgui, MIT) keeps the list widget from owning the selection.
// Written fresh for AgentHydra from that idea. The point is one contract for every gesture: the
// list only ever says "set everything" or "set this range", so a new gesture cannot invent a third
// way of mutating the checked set, and the store stays a plain Set of ID keys.

/** One change to the selection. `setAll` true selects exactly the visible keys (anything hidden by
 *  the filter drops out); `setRange` sets every key from `first` to `last`, inclusive, in list
 *  order, and leaves the rest alone. */
export type SelectionRequest =
  | { type: 'setAll'; selected: boolean }
  | { type: 'setRange'; first: string; last: string; selected: boolean }

/** Apply `requests` in order to `current` against the visible `keys`. Returns a new Set; the
 *  input is never mutated, so a reactive ref only changes when the result is assigned. */
export function applySelectionRequests(
  keys: readonly string[],
  current: ReadonlySet<string>,
  requests: readonly SelectionRequest[],
): Set<string> {
  let next = new Set(current)
  for (const req of requests) {
    if (req.type === 'setAll') {
      next = req.selected ? new Set(keys) : new Set()
      continue
    }
    for (const k of rangeBetween(keys, req.first, req.last)) {
      if (req.selected) next.add(k)
      else next.delete(k)
    }
  }
  return next
}

/** A row's key and its vertical extent, in the scroll container's content coordinates. */
export interface RowBand {
  key: string
  top: number
  bottom: number
}

/** The first and last rows (in list order) a vertical drag band from `y0` to `y1` touches, or
 *  null when it touches none. Rows are full width, so a box over them is one-dimensional: only
 *  the vertical overlap decides, and the rows it covers are always one contiguous range. */
export function bandRange(
  rows: readonly RowBand[],
  y0: number,
  y1: number,
): { first: string; last: string } | null {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  let first: string | null = null
  let last: string | null = null
  for (const r of rows) {
    if (r.bottom <= lo || r.top >= hi) continue
    if (first === null) first = r.key
    last = r.key
  }
  return first && last ? { first, last } : null
}
