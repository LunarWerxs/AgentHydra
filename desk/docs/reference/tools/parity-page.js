// Runs inside headless Edge (served by parity.ts at /__parity/tool.html). The browser decodes the
// reference (png or webp), scales our screenshot into place, and writes the comparison images as
// data URLs. The pixel diff is a port of pixelmatch 5 (ISC, Mapbox): YIQ colour distance with
// anti-aliasing detection, so text edges that differ only by smoothing are painted yellow and not counted.

function rgb2y(r, g, b) { return r * 0.29889531 + g * 0.58662247 + b * 0.11448223 }
function rgb2i(r, g, b) { return r * 0.59597799 - g * 0.2741761 - b * 0.32180189 }
function rgb2q(r, g, b) { return r * 0.21147017 - g * 0.52261711 + b * 0.31114694 }
function blend(c, a) { return 255 + (c - 255) * a }

function colorDelta(img1, img2, k, m, yOnly) {
  let r1 = img1[k], g1 = img1[k + 1], b1 = img1[k + 2], a1 = img1[k + 3]
  let r2 = img2[m], g2 = img2[m + 1], b2 = img2[m + 2], a2 = img2[m + 3]
  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0
  if (a1 < 255) { a1 /= 255; r1 = blend(r1, a1); g1 = blend(g1, a1); b1 = blend(b1, a1) }
  if (a2 < 255) { a2 /= 255; r2 = blend(r2, a2); g2 = blend(g2, a2); b2 = blend(b2, a2) }
  const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2), y = y1 - y2
  if (yOnly) return y
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2)
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2)
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
  return y1 > y2 ? -delta : delta
}

function hasManySiblings(img, x1, y1, width, height) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue
      const pos2 = (y * width + x) * 4
      if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] && img[pos + 2] === img[pos2 + 2] && img[pos + 3] === img[pos2 + 3]) zeroes++
      if (zeroes > 2) return true
    }
  }
  return false
}

function antialiased(img, x1, y1, width, height, img2) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true)
      if (delta === 0) {
        zeroes++
        if (zeroes > 2) return false
      } else if (delta < min) { min = delta; minX = x; minY = y }
      else if (delta > max) { max = delta; maxX = x; maxY = y }
    }
  }
  if (min === 0 || max === 0) return false
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height)) ||
    (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height))
}

/** Diff two equal-size RGBA buffers inside `mask` (a rect); returns the count and a per-pixel hit map. */
function pixelmatch(img1, img2, output, width, height, threshold, mask) {
  const maxDelta = 35215 * threshold * threshold
  const hits = new Uint8Array(width * height)
  let diff = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = (y * width + x) * 4
      const inside = x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height
      const delta = inside ? colorDelta(img1, img2, pos, pos, false) : 0
      let r, g, b
      if (Math.abs(delta) > maxDelta) {
        if (antialiased(img1, x, y, width, height, img2) || antialiased(img2, x, y, width, height, img1)) {
          r = 255; g = 255; b = 0
        } else {
          r = 255; g = 0; b = 0
          hits[y * width + x] = 1
          diff++
        }
      } else {
        const v = blend(rgb2y(img1[pos], img1[pos + 1], img1[pos + 2]), (0.1 * img1[pos + 3]) / 255)
        r = g = b = inside ? v : v * 0.6
      }
      output[pos] = r; output[pos + 1] = g; output[pos + 2] = b; output[pos + 3] = 255
    }
  }
  return { diff, hits }
}

async function load(url) {
  const img = new Image()
  img.src = url
  await img.decode()
  return img
}

function canvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function label(g, text, x, y, w) {
  g.save()
  g.fillStyle = '#2a2a2a'
  g.fillRect(x, y, w, 22)
  g.fillStyle = '#f0efec'
  g.font = '12px Segoe UI, sans-serif'
  g.textBaseline = 'middle'
  let t = text
  while (t.length > 4 && g.measureText(t).width > w - 12) t = t.slice(0, -2)
  g.fillText(t === text ? t : t + '…', x + 6, y + 11)
  g.restore()
}

function sideBySide(left, right, leftLabel, rightLabel) {
  const gap = 12
  const c = canvas(left.width + gap + right.width, Math.max(left.height, right.height) + 22)
  const g = c.getContext('2d')
  g.fillStyle = '#ff00ff'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#000'
  g.fillRect(left.width, 0, gap, c.height)
  label(g, leftLabel, 0, 0, left.width)
  label(g, rightLabel, left.width + gap, 0, right.width)
  g.drawImage(left, 0, 22)
  g.drawImage(right, left.width + gap, 22)
  return c
}

function zoomed(src, r, zoom) {
  const c = canvas(r.width * zoom, r.height * zoom)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(src, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height)
  return c
}

const url = (c) => c.toDataURL('image/png')

/**
 * o: { refUrl, oursUrl, place: {x,y,width,height} | null, threshold, tile, worst, crop: {x,y,width,height} | null,
 *      zoom, realLabel, oursLabel }
 */
window.parityProcess = async function parityProcess(o) {
  const [ref, ours] = await Promise.all([load(o.refUrl), load(o.oursUrl)])
  const W = ref.naturalWidth
  const H = ref.naturalHeight
  const place = o.place ?? { x: 0, y: 0, width: W, height: H }
  // The compared region: where our render lands, clipped to the reference (a window may hang off-screen).
  const cx = Math.max(0, Math.round(place.x))
  const cy = Math.max(0, Math.round(place.y))
  const cmp = {
    x: cx,
    y: cy,
    width: Math.min(W, Math.round(place.x + place.width)) - cx,
    height: Math.min(H, Math.round(place.y + place.height)) - cy
  }

  const realC = canvas(W, H)
  const rg = realC.getContext('2d')
  rg.drawImage(ref, 0, 0)

  const oursC = canvas(W, H)
  const og = oursC.getContext('2d')
  og.drawImage(ref, 0, 0)
  og.fillStyle = 'rgba(0,0,0,0.75)'
  og.fillRect(0, 0, W, H)
  og.clearRect(place.x, place.y, place.width, place.height)
  og.imageSmoothingEnabled = true
  og.imageSmoothingQuality = 'high'
  og.drawImage(ours, place.x, place.y, place.width, place.height)

  const a = rg.getImageData(0, 0, W, H)
  const b = og.getImageData(0, 0, W, H)
  const diffC = canvas(W, H)
  const dg = diffC.getContext('2d')
  const out = dg.createImageData(W, H)
  const { diff, hits } = pixelmatch(a.data, b.data, out.data, W, H, o.threshold, cmp)
  dg.putImageData(out, 0, 0)

  const T = o.tile
  const tiles = []
  for (let ty = cmp.y; ty < cmp.y + cmp.height; ty += T) {
    for (let tx = cmp.x; tx < cmp.x + cmp.width; tx += T) {
      const w = Math.min(T, cmp.x + cmp.width - tx)
      const h = Math.min(T, cmp.y + cmp.height - ty)
      let n = 0
      for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) n += hits[y * W + x]
      if (n) tiles.push({ x: tx, y: ty, width: w, height: h, pixels: n, percent: +((100 * n) / (w * h)).toFixed(1) })
    }
  }
  tiles.sort((p, q) => q.pixels - p.pixels)

  const overC = canvas(W, H)
  const vg = overC.getContext('2d')
  vg.drawImage(realC, 0, 0)
  vg.globalAlpha = 0.5
  vg.drawImage(oursC, 0, 0)

  const result = {
    width: W,
    height: H,
    oursSource: { width: ours.naturalWidth, height: ours.naturalHeight },
    place,
    compared: cmp,
    diffPixels: diff,
    comparedPixels: cmp.width * cmp.height,
    mismatchPercent: +((100 * diff) / (cmp.width * cmp.height)).toFixed(2),
    worst: tiles.slice(0, o.worst),
    images: {
      real: url(realC),
      ours: url(oursC),
      side: url(sideBySide(realC, oursC, o.realLabel, o.oursLabel)),
      diff: url(diffC),
      overlay: url(overC)
    }
  }
  if (o.crop) {
    const r = {
      x: Math.max(0, Math.min(W - 1, o.crop.x)),
      y: Math.max(0, Math.min(H - 1, o.crop.y)),
      width: o.crop.width,
      height: o.crop.height
    }
    r.width = Math.max(1, Math.min(r.width, W - r.x))
    r.height = Math.max(1, Math.min(r.height, H - r.y))
    const zr = zoomed(realC, r, o.zoom)
    const zo = zoomed(oursC, r, o.zoom)
    const tag = `${r.x},${r.y},${r.width}x${r.height} x${o.zoom}`
    result.crop = r
    result.images['real-zoom'] = url(zr)
    result.images['ours-zoom'] = url(zo)
    result.images['diff-zoom'] = url(zoomed(diffC, r, o.zoom))
    result.images['side-zoom'] = url(sideBySide(zr, zo, `REAL ${tag}`, `OURS ${tag}`))
  }
  return result
}
window.parityToolReady = true
