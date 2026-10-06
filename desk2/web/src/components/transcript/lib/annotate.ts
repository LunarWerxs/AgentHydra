// Annotating a picture in the viewer: pen, highlighter, arrow, rectangle and circle marks drawn over it, kept
// in the picture's own pixels so the saved copy is full size. Pure apart from drawing on a context it is
// handed; Annotator.vue draws the toolbar and takes the pointer.

export type AnnotateTool = 'pen' | 'highlighter' | 'arrow' | 'rect' | 'ellipse'

export interface Point {
  x: number
  y: number
}

/** One mark, in the picture's natural pixels. A stroke keeps every point; a shape keeps where the drag began and ended. */
export interface Mark {
  tool: AnnotateTool
  color: string
  /** Line width in natural pixels. */
  width: number
  points: Point[]
}

export const ANNOTATE_TOOLS: { tool: AnnotateTool; label: string; key: string }[] = [
  { tool: 'pen', label: 'Pen', key: 'P' },
  { tool: 'highlighter', label: 'Highlighter', key: 'H' },
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'rect', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', label: 'Circle', key: 'O' },
]

export const ANNOTATE_COLORS: { color: string; label: string }[] = [
  { color: '#ff3b30', label: 'Red' },
  { color: '#ffcc00', label: 'Yellow' },
  { color: '#34c759', label: 'Green' },
  { color: '#0a84ff', label: 'Blue' },
  { color: '#ffffff', label: 'White' },
  { color: '#000000', label: 'Black' },
]

/** Line widths as they look on screen; a highlighter is this many times wider. */
export const ANNOTATE_SIZES = [3, 5, 9] as const
export const HIGHLIGHTER_SCALE = 4
export const HIGHLIGHTER_ALPHA = 0.4

/** The line width to store, in natural pixels, for `size` screen pixels with the picture shown `shownWidth` wide. */
export function markWidth(tool: AnnotateTool, size: number, naturalWidth: number, shownWidth: number): number {
  const ratio = shownWidth > 0 ? naturalWidth / shownWidth : 1
  return size * (tool === 'highlighter' ? HIGHLIGHTER_SCALE : 1) * ratio
}

/** A pointer position over the shown picture, in the picture's natural pixels, kept inside it. */
export function toNatural(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, natural: { w: number; h: number }): Point {
  const sx = box.width > 0 ? natural.w / box.width : 1
  const sy = box.height > 0 ? natural.h / box.height : 1
  return {
    x: Math.min(natural.w, Math.max(0, (clientX - box.left) * sx)),
    y: Math.min(natural.h, Math.max(0, (clientY - box.top) * sy)),
  }
}

/** A stroke tool keeps every point; a shape tool keeps only where the drag began and where it is now. */
export function extendMark(mark: Mark, p: Point): Mark {
  if (mark.tool === 'pen' || mark.tool === 'highlighter') {
    const last = mark.points.at(-1)
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) return mark
    return { ...mark, points: [...mark.points, p] }
  }
  return { ...mark, points: [mark.points[0] ?? p, p] }
}

/** A mark worth keeping: a stroke with any length, a click with the pen (a dot), a shape dragged a few pixels. */
export function isMeaningful(mark: Mark): boolean {
  const [a, b] = [mark.points[0], mark.points.at(-1)]
  if (!a || !b) return false
  if (mark.tool === 'pen' || mark.tool === 'highlighter') return true
  return Math.hypot(b.x - a.x, b.y - a.y) >= Math.max(3, mark.width)
}

/** The box a shape spans, whichever way it was dragged. */
export function spanBox(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** The two barbs of an arrow head at `to`, sized to the line width. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const len = Math.max(12, width * 4)
  const spread = Math.PI / 7
  return [
    { x: to.x - len * Math.cos(angle - spread), y: to.y - len * Math.sin(angle - spread) },
    { x: to.x - len * Math.cos(angle + spread), y: to.y - len * Math.sin(angle + spread) },
  ]
}

/** The part of CanvasRenderingContext2D a mark is drawn with (a fake one in the tests). */
export interface Pen {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  globalAlpha: number
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  rect(x: number, y: number, w: number, h: number): void
  stroke(): void
  fill(): void
}

export function drawMark(ctx: Pen, mark: Mark): void {
  const pts = mark.points
  const a = pts[0]
  const b = pts.at(-1)
  if (!a || !b) return
  ctx.save()
  ctx.strokeStyle = mark.color
  ctx.fillStyle = mark.color
  ctx.lineWidth = mark.width
  ctx.lineCap = mark.tool === 'highlighter' ? 'square' : 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = mark.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
  ctx.beginPath()
  switch (mark.tool) {
    case 'pen':
    case 'highlighter':
      if (pts.length === 1) {
        ctx.arc(a.x, a.y, mark.width / 2, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      ctx.moveTo(a.x, a.y)
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break
    case 'arrow': {
      const [l, r] = arrowHead(a, b, mark.width)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.moveTo(l.x, l.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(r.x, r.y)
      ctx.stroke()
      break
    }
    case 'rect': {
      const s = spanBox(a, b)
      ctx.rect(s.x, s.y, s.w, s.h)
      ctx.stroke()
      break
    }
    case 'ellipse': {
      const s = spanBox(a, b)
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
  }
  ctx.restore()
}

/** Undo and redo over the list of marks: the marks drawn, and those undone that Redo brings back. */
export interface MarkHistory {
  marks: Mark[]
  undone: Mark[]
}

export function addMark(h: MarkHistory, mark: Mark): MarkHistory {
  return { marks: [...h.marks, mark], undone: [] }
}
export function undoMark(h: MarkHistory): MarkHistory {
  const last = h.marks.at(-1)
  return last ? { marks: h.marks.slice(0, -1), undone: [...h.undone, last] } : h
}
export function redoMark(h: MarkHistory): MarkHistory {
  const last = h.undone.at(-1)
  return last ? { marks: [...h.marks, last], undone: h.undone.slice(0, -1) } : h
}
/** Clear is one step Undo takes back, all the marks at once. */
export function clearMarks(h: MarkHistory): MarkHistory {
  return h.marks.length ? { marks: [], undone: [...h.undone, ...[...h.marks].reverse()] } : h
}

/** The annotated copy's name: "shot.png" -> "shot (annotated).png"; a copy of a copy is not "(annotated) (annotated)". */
export function annotatedName(name: string, mediaType = 'image/png'): string {
  const base = (name || 'Image').replace(/\.(png|jpe?g|gif|webp|bmp)$/i, '').replace(/ \(annotated\)$/, '')
  return `${base} (annotated).${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`
}

/** A picture whose pixels the window may read back: its own data, or one served by Desk. A picture from another site would taint the canvas. */
export function canAnnotate(src: string, origin = typeof location === 'undefined' ? '' : location.origin): boolean {
  if (/^data:image\//.test(src) || src.startsWith('blob:')) return true
  if (src.startsWith('/') && !src.startsWith('//')) return true
  return !!origin && src.startsWith(`${origin}/`)
}

/** What a key does while annotating. */
export type AnnotateAction = { type: 'cancel' } | { type: 'save' } | { type: 'undo' } | { type: 'redo' } | { type: 'tool'; tool: AnnotateTool }

export function annotateKeyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): AnnotateAction | null {
  if (e.altKey) return null
  const mod = !!(e.ctrlKey || e.metaKey)
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (key === 'Escape') return { type: 'cancel' }
  if (mod) {
    if (key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' }
    if (key === 'y') return { type: 'redo' }
    if (key === 's' || key === 'Enter') return { type: 'save' }
    return null
  }
  const tool = ANNOTATE_TOOLS.find((t) => t.key.toLowerCase() === key)
  return tool ? { type: 'tool', tool: tool.tool } : null
}
