import { beforeEach, describe, expect, test } from 'bun:test'
import { aspectOf, galleryLayout } from '../../src/components/transcript/lib/gallery'
import { closeLightbox, lightbox, openLightbox, stepLightbox, tileKey } from '../../src/components/transcript/lib/media'
import { FIT_VIEW, clampPan, fitWidthZoom, snapZoomStep, toggleZoom, true100Zoom, viewerKeyAction, zoomStepAt } from '../../src/components/transcript/lib/viewer'

// Invented pictures: aspect ratios of a landscape, a portrait, a square, a wide banner and a 4:3.
const A = { land: 3 / 2, port: 2 / 3, sq: 1, wide: 3, std: 4 / 3 }
const WIDE = 900
const NARROW = 360

describe('galleryLayout', () => {
  test('one picture stays large, keeps its aspect ratio and never exceeds the column', () => {
    expect(galleryLayout([A.land], WIDE)).toEqual([{ width: 540, height: 360 }])
    expect(galleryLayout([A.land], NARROW)).toEqual([{ width: 360, height: 240 }])
    expect(galleryLayout([A.port], NARROW)).toEqual([{ width: 240, height: 360 }])
  })

  test('two pictures share the row, filling the width, without cropping', () => {
    for (const w of [WIDE, NARROW]) {
      const [a, b] = galleryLayout([A.land, A.port], w)
      expect(a!.height).toBe(b!.height)
      expect(a!.width + b!.width + 8).toBeLessThanOrEqual(w)
      // Filled to the full width, unless that would make the row taller than a lone picture may be.
      if (a!.height < 360) expect(a!.width + b!.width + 8).toBeGreaterThan(w - 3)
      expect(Math.abs(a!.width / a!.height - A.land)).toBeLessThan(0.03)
    }
  })

  test('three pictures: one row when wide, never too small when narrow (four wrap), every row inside the column', () => {
    const wide = galleryLayout([A.land, A.sq, A.std], WIDE)
    expect(new Set(wide.map((s) => s.height)).size).toBe(1)
    const narrow = galleryLayout([A.land, A.sq, A.std], NARROW)
    expect(narrow.every((s) => s.height >= 80)).toBe(true)
    const four = galleryLayout([A.land, A.sq, A.std, A.port], NARROW)
    expect(new Set(four.map((s) => s.height)).size).toBeGreaterThan(1)
    for (const s of four) expect(s.width).toBeLessThanOrEqual(NARROW)
    for (const s of [...wide, ...narrow]) expect(s.width).toBeLessThanOrEqual(WIDE)
    for (const s of narrow) expect(s.width).toBeLessThanOrEqual(NARROW)
  })

  test('five pictures wrap into rows that each fit the column at both widths', () => {
    const aspects = [A.land, A.port, A.sq, A.wide, A.std]
    for (const w of [WIDE, NARROW]) {
      const sizes = galleryLayout(aspects, w)
      expect(sizes).toHaveLength(5)
      // Group by consecutive equal heights = rows; a row's widths plus gaps never pass the column.
      const rows: number[][] = []
      let last = -1
      for (const s of sizes) {
        if (s.height !== last) rows.push([])
        rows.at(-1)!.push(s.width)
        last = s.height
      }
      for (const r of rows) expect(r.reduce((x, y) => x + y, 0) + 8 * (r.length - 1)).toBeLessThanOrEqual(w)
      for (const [i, s] of sizes.entries()) expect(Math.abs(s.width / s.height - aspects[i]!)).toBeLessThan(0.05)
    }
    expect(galleryLayout(aspects, NARROW).length).toBe(5)
  })

  test('the last row keeps the target height instead of stretching one lone picture to the full width', () => {
    const sizes = galleryLayout([A.wide, A.wide, A.wide, A.port], WIDE)
    expect(sizes.at(-1)!.height).toBeLessThanOrEqual(180)
  })

  test('a picture that has not loaded counts as 4:3', () => {
    expect(aspectOf(0, 0)).toBeCloseTo(4 / 3)
    expect(aspectOf(200, 100)).toBe(2)
  })
})

describe('viewer keys', () => {
  beforeEach(closeLightbox)
  const group = [1, 2, 3, 4, 5].map((n) => ({ src: `/api/media/${n}.png`, alt: `pic ${n}` }))
  const press = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean }> = {}) => {
    const a = viewerKeyAction({ key, ...mods })
    if (a?.type === 'close') closeLightbox()
    if (a?.type === 'step') stepLightbox(a.delta)
    return a
  }

  test('space on a focused tile opens the viewer on that picture; space closes it', () => {
    let prevented = 0
    tileKey({ key: ' ', type: 'keydown', preventDefault: () => prevented++ }, () => openLightbox(group[2]!.src, group[2]!.alt, group))
    expect(lightbox.value?.index).toBe(2)
    press(' ')
    expect(lightbox.value).toBeNull()
    // The release of that space must not click the tile again.
    tileKey({ key: ' ', type: 'keyup', preventDefault: () => prevented++ }, () => openLightbox(group[2]!.src))
    expect(lightbox.value).toBeNull()
    expect(prevented).toBe(2)
  })

  test('other keys on a tile are left alone', () => {
    let opened = false
    let prevented = false
    tileKey({ key: 'a', type: 'keydown', preventDefault: () => (prevented = true) }, () => (opened = true))
    expect(opened || prevented).toBe(false)
  })

  test('Esc and Enter close', () => {
    openLightbox(group[0]!.src, '', group)
    press('Escape')
    expect(lightbox.value).toBeNull()
    openLightbox(group[0]!.src, '', group)
    press('Enter')
    expect(lightbox.value).toBeNull()
  })

  test('arrows step through the message and stop at both ends', () => {
    openLightbox(group[2]!.src, '', group)
    press('ArrowRight')
    expect(lightbox.value?.index).toBe(3)
    press('ArrowRight')
    press('ArrowRight')
    press('ArrowRight')
    expect(lightbox.value?.index).toBe(4)
    for (let i = 0; i < 8; i++) press('ArrowLeft')
    expect(lightbox.value?.index).toBe(0)
    expect(lightbox.value).not.toBeNull()
  })

  test('a lone picture, or one outside the group, opens alone as before', () => {
    openLightbox('/api/media/x.png', 'x')
    expect(lightbox.value).toEqual({ items: [{ src: '/api/media/x.png', alt: 'x' }], index: 0 })
    openLightbox('/api/media/y.png', 'y', group)
    expect(lightbox.value?.items).toHaveLength(1)
    press('ArrowRight')
    expect(lightbox.value?.index).toBe(0)
  })

  test('zoom, 100% and fit-width keys; Alt chords and unknown keys are not the viewer’s', () => {
    expect(press('+')).toEqual({ type: 'zoom', delta: 1 })
    expect(press('-')).toEqual({ type: 'zoom', delta: -1 })
    expect(press('0', { ctrlKey: true })).toEqual({ type: 'toggle100' })
    expect(press('1')).toEqual({ type: 'toggle100' })
    expect(press('w')).toEqual({ type: 'fitWidth' })
    expect(press('ArrowLeft', { altKey: true })).toBeNull()
    expect(press('q')).toBeNull()
  })
})

describe('zoom and pan', () => {
  const g = { iw: 2000, ih: 1000, cw: 800, ch: 600 } // fit = 0.4, true 100% = 2.5x

  test('a step snaps onto true 100% and onto fit instead of stepping past', () => {
    expect(snapZoomStep(2.4, 2.88, 2.5)).toBe(2.5)
    expect(snapZoomStep(1.1, 0.9, 1)).toBe(1)
    expect(snapZoomStep(2.5, 3, 2.5)).toBe(3)
    expect(true100Zoom(0.4)).toBeCloseTo(2.5)
    expect(true100Zoom(2)).toBe(1)
  })

  test('zooming out never goes below fit, and a zoomed picture keeps the point under the pointer', () => {
    expect(zoomStepAt(FIT_VIEW, -1, g)).toBe(FIT_VIEW)
    const z = zoomStepAt(FIT_VIEW, 3, g, { x: 100, y: 0 })
    expect(z.zoom).toBeGreaterThan(1.7)
    expect(z.panX).toBeLessThan(0) // zooming at a point right of centre moves the picture left
  })

  test('pan is clamped so no empty margin shows; fit-width and toggles', () => {
    const c = clampPan({ zoom: 2, panX: 99999, panY: -99999 }, g)
    expect(c.panX).toBe((2000 * 0.8 - 800) / 2)
    expect(c.panY).toBe(-Math.max(0, (1000 * 0.8 - 600) / 2))
    expect(fitWidthZoom({ iw: 1000, ih: 2000, cw: 800, ch: 400 })).toBe(4)
    expect(fitWidthZoom(g)).toBe(1)
    expect(toggleZoom(FIT_VIEW, 2.5).zoom).toBe(2.5)
    expect(toggleZoom({ zoom: 2.5, panX: 5, panY: 5 }, 2.5)).toEqual(FIT_VIEW)
  })
})
