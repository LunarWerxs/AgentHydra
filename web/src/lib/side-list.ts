/** One section of a `SideList`: a header line (name and count) over its rows. */
export interface SideListGroup<T> {
  key: string
  label: string
  items: T[]
  /** The count on the header line when it is not `items.length` (a group cut short). */
  count?: number
  /** The key of one item. Without it the rows are keyed by position. */
  keyOf?: (item: T) => string | number
}

/** The small muted "model · effort" tag of a row; empty when neither is known. */
export function modelEffortTag(model?: string | null, effort?: string | null): string {
  return [model, effort].filter(Boolean).join(' · ')
}
