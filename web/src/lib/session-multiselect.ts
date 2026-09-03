// web/src/lib/session-multiselect.ts - the range arithmetic behind Shift-click in the session list.
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
