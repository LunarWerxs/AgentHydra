// The layout rule of a message's picture gallery: pure sizes, no DOM. One picture stays large; several
// share the row width at their own aspect ratio (no cropping) and wrap into rows that fill the column,
// like a justified photo grid. The last row keeps the target height instead of stretching.

export interface GallerySize {
  width: number
  height: number
}

export interface GalleryOptions {
  /** Gap between pictures, both ways (px). */
  gap?: number
  /** The height a row aims for (px). */
  rowHeight?: number
  /** A lone picture is never taller than this (px). */
  singleMaxHeight?: number
}

const DEFAULTS: Required<GalleryOptions> = { gap: 8, rowHeight: 180, singleMaxHeight: 360 }

/** The aspect ratio (width / height) to lay a picture out with; a picture not loaded yet counts as 4:3. */
export function aspectOf(width: number, height: number): number {
  return width > 0 && height > 0 ? width / height : 4 / 3
}

/**
 * Sizes for pictures with the given aspect ratios in a column `width` px wide, in order. A lone picture
 * fills the width up to singleMaxHeight tall, never past its own width. With several, each row is filled
 * to the full width (height shrinks as more pictures join it, grows when fewer do, never past singleMaxHeight); a last row that follows full rows keeps rowHeight instead of stretching.
 */
export function galleryLayout(aspects: number[], width: number, opts: GalleryOptions = {}): GallerySize[] {
  const { gap, rowHeight, singleMaxHeight } = { ...DEFAULTS, ...opts }
  const W = Math.max(1, Math.floor(width))
  const n = aspects.length
  if (n === 0) return []
  if (n === 1) {
    const a = aspects[0]!
    const h = Math.min(singleMaxHeight, W / a)
    return [{ width: Math.round(h * a), height: Math.round(h) }]
  }
  // A narrow column gets shorter rows, so two pictures still sit side by side.
  const target = Math.max(80, Math.min(rowHeight, Math.round(W / 3.2)))
  const sizes: GallerySize[] = []
  let row: number[] = []
  const flush = (last: boolean) => {
    if (!row.length) return
    const sum = row.reduce((s, a) => s + a, 0)
    const avail = W - gap * (row.length - 1)
    let h = avail / sum
    if (last && sizes.length && h > target) h = target
    else h = Math.min(h, singleMaxHeight)
    for (const a of row) sizes.push({ width: Math.floor(h * a), height: Math.round(h) })
    row = []
  }
  let sum = 0
  for (const a of aspects) {
    // Close the row before this picture when that leaves the row nearer the target height than adding it would.
    if (row.length) {
      const without = (W - gap * (row.length - 1)) / sum
      const withIt = (W - gap * row.length) / (sum + a)
      if (withIt < target && Math.abs(without - target) <= Math.abs(withIt - target)) {
        flush(false)
        sum = 0
      }
    }
    row.push(a)
    sum += a
  }
  flush(true)
  return sizes
}
