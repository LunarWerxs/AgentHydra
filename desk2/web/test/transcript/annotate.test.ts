import { describe, expect, test } from 'bun:test'
import {
  addMark,
  annotateKeyAction,
  annotatedName,
  arrowHead,
  canAnnotate,
  clearMarks,
  drawMark,
  extendMark,
  isMeaningful,
  markWidth,
  redoMark,
  spanBox,
  toNatural,
  undoMark,
  type Mark,
  type MarkHistory,
  type Pen,
} from '../../src/components/transcript/lib/annotate'
import { viewerKeyAction } from '../../src/components/transcript/lib/viewer'

const mark = (tool: Mark['tool'], points: [number, number][], width = 4): Mark => ({ tool, color: '#ff3b30', width, points: points.map(([x, y]) => ({ x, y })) })

/** A context that writes down what was drawn. */
function fakePen(): Pen & { calls: string[] } {
  const calls: string[] = []
  const log =
    (name: string) =>
    (...args: number[]) =>
      void calls.push(`${name}(${args.map((a) => Math.round(a)).join(',')})`)
  return {
    calls,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    save: () => void calls.push('save'),
    restore: () => void calls.push('restore'),
    beginPath: () => void calls.push('beginPath'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    arc: log('arc'),
    ellipse: log('ellipse'),
    rect: log('rect'),
    stroke: () => void calls.push('stroke'),
    fill: () => void calls.push('fill'),
  }
}

describe('annotate geometry', () => {
  test('a pointer over the shown picture maps to its natural pixels and stays inside it', () => {
    const box = { left: 100, top: 50, width: 500, height: 250 }
    const natural = { w: 2000, h: 1000 }
    expect(toNatural(350, 175, box, natural)).toEqual({ x: 1000, y: 500 })
    expect(toNatural(100, 50, box, natural)).toEqual({ x: 0, y: 0 })
    expect(toNatural(40, 900, box, natural)).toEqual({ x: 0, y: 1000 })
  })

  test('line widths are what they look on screen, scaled into the picture; a highlighter is four times wider', () => {
    expect(markWidth('pen', 5, 2000, 500)).toBe(20)
    expect(markWidth('highlighter', 5, 2000, 500)).toBe(80)
    expect(markWidth('rect', 3, 400, 400)).toBe(3)
  })

  test('a stroke keeps every point (not repeats); a shape keeps where the drag began and where it is', () => {
    let pen = mark('pen', [[0, 0]])
    pen = extendMark(pen, { x: 5, y: 5 })
    pen = extendMark(pen, { x: 5.2, y: 5.1 })
    pen = extendMark(pen, { x: 9, y: 2 })
    expect(pen.points).toHaveLength(3)
    let box = mark('rect', [[10, 10]])
    box = extendMark(box, { x: 30, y: 40 })
    box = extendMark(box, { x: 50, y: 60 })
    expect(box.points).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 60 },
    ])
  })

  test('a pen click is a dot worth keeping; a shape clicked without a drag is not', () => {
    expect(isMeaningful(mark('pen', [[4, 4]]))).toBe(true)
    expect(isMeaningful(mark('ellipse', [[4, 4], [5, 5]]))).toBe(false)
    expect(isMeaningful(mark('ellipse', [[4, 4], [40, 30]]))).toBe(true)
  })

  test('a shape dragged up and left spans the same box as one dragged down and right', () => {
    expect(spanBox({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 40 })
  })

  test('the arrow head sits at the end the drag finished, its barbs back along the line', () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
    expect(l.x).toBeLessThan(100)
    expect(r.x).toBeLessThan(100)
    expect(Math.sign(l.y)).toBe(-Math.sign(r.y))
  })
})

describe('drawMark', () => {
  test('a circle is an ellipse inside the dragged box', () => {
    const ctx = fakePen()
    drawMark(ctx, mark('ellipse', [[10, 20], [110, 80]]))
    expect(ctx.calls).toContain('ellipse(60,50,50,30,0,0,6)')
    expect(ctx.calls).toContain('stroke')
  })

  test('the highlighter is see-through; the pen and the shapes are not', () => {
    const seen: number[] = []
    for (const tool of ['highlighter', 'pen', 'rect'] as const) {
      const ctx = fakePen()
      const real = ctx.stroke
      ctx.stroke = () => {
        seen.push(ctx.globalAlpha)
        real()
      }
      drawMark(ctx, mark(tool, [[0, 0], [40, 40]]))
    }
    expect(seen[0]).toBeLessThan(1)
    expect(seen.slice(1)).toEqual([1, 1])
  })

  test('a single pen point is drawn as a filled dot, an arrow as a line and its two barbs', () => {
    const dot = fakePen()
    drawMark(dot, mark('pen', [[7, 7]], 6))
    expect(dot.calls).toContain('arc(7,7,3,0,6)')
    expect(dot.calls).toContain('fill')
    const arrow = fakePen()
    drawMark(arrow, mark('arrow', [[0, 0], [100, 0]]))
    expect(arrow.calls.filter((c) => c.startsWith('lineTo'))).toHaveLength(3)
  })
})

describe('undo, redo and clear', () => {
  const a = mark('pen', [[0, 0]])
  const b = mark('rect', [[0, 0], [9, 9]])
  const c = mark('arrow', [[0, 0], [9, 9]])

  test('undo takes the last mark back, redo returns it, a new mark forgets what was undone', () => {
    let h: MarkHistory = { marks: [], undone: [] }
    h = addMark(addMark(h, a), b)
    h = undoMark(h)
    expect(h.marks).toEqual([a])
    h = redoMark(h)
    expect(h.marks).toEqual([a, b])
    h = addMark(undoMark(h), c)
    expect(h.marks).toEqual([a, c])
    expect(redoMark(h)).toEqual(h)
  })

  test('clear is one step that redo brings back in the order drawn', () => {
    const h = clearMarks(addMark(addMark({ marks: [], undone: [] }, a), b))
    expect(h.marks).toEqual([])
    expect(redoMark(redoMark(h)).marks).toEqual([a, b])
    expect(undoMark({ marks: [], undone: [] })).toEqual({ marks: [], undone: [] })
  })
})

describe('the annotated copy', () => {
  test('is named after the original, once, with the extension of what it was saved as', () => {
    expect(annotatedName('shot.png')).toBe('shot (annotated).png')
    expect(annotatedName('Pasted image')).toBe('Pasted image (annotated).png')
    expect(annotatedName('shot (annotated).png')).toBe('shot (annotated).png')
    expect(annotatedName('photo.JPG', 'image/jpeg')).toBe('photo (annotated).jpg')
    expect(annotatedName('')).toBe('Image (annotated).png')
  })

  test('only a picture whose pixels the window may read gets the pen', () => {
    const origin = 'http://127.0.0.1:7798'
    expect(canAnnotate('data:image/png;base64,AAAA', origin)).toBe(true)
    expect(canAnnotate('/api/media/abc.png', origin)).toBe(true)
    expect(canAnnotate(`${origin}/api/media/abc.png`, origin)).toBe(true)
    expect(canAnnotate('https://example.com/pic.png', origin)).toBe(false)
    expect(canAnnotate('//example.com/pic.png', origin)).toBe(false)
  })
})

describe('annotate keys', () => {
  test('A in the viewer starts annotating; Ctrl+A does not', () => {
    expect(viewerKeyAction({ key: 'a' })).toEqual({ type: 'annotate' })
    expect(viewerKeyAction({ key: 'a', ctrlKey: true })).toBeNull()
  })

  test('while annotating: Esc goes back, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo, Ctrl+S saves, letters pick tools', () => {
    expect(annotateKeyAction({ key: 'Escape' })).toEqual({ type: 'cancel' })
    expect(annotateKeyAction({ key: 'z', ctrlKey: true })).toEqual({ type: 'undo' })
    expect(annotateKeyAction({ key: 'Z', ctrlKey: true, shiftKey: true })).toEqual({ type: 'redo' })
    expect(annotateKeyAction({ key: 'y', metaKey: true })).toEqual({ type: 'redo' })
    expect(annotateKeyAction({ key: 's', ctrlKey: true })).toEqual({ type: 'save' })
    expect(annotateKeyAction({ key: 'h' })).toEqual({ type: 'tool', tool: 'highlighter' })
    expect(annotateKeyAction({ key: 'O' })).toEqual({ type: 'tool', tool: 'ellipse' })
    // Space no longer closes anything while annotating, and a stray digit is not a tool.
    expect(annotateKeyAction({ key: ' ' })).toBeNull()
    expect(annotateKeyAction({ key: '2' })).toBeNull()
  })
})
