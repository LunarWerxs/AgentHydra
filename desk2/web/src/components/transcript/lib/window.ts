// Windowed rendering math: which rows of a variable-height list are on screen. Pure.

/** offsets[i] = top of row i; offsets[n] = total height. */
export function prefixOffsets(heights: ArrayLike<number>, gap = 0): Float64Array {
  const n = heights.length
  const out = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) out[i + 1] = out[i] + heights[i] + gap
  return out
}

/** The row containing y: the largest i with offsets[i] <= y, clamped to [0, n-1]. */
export function rowAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Rows [start, end) to render for a viewport, with `overscan` px rendered beyond each edge. */
export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  viewportHeight: number,
  overscan = 600,
): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const start = rowAt(offsets, Math.max(0, scrollTop - overscan))
  const end = Math.min(n, rowAt(offsets, scrollTop + viewportHeight + overscan) + 1)
  return { start, end }
}
