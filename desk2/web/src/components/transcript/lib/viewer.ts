// The picture viewer's behaviour, ported from SageThumbs 2K's Quick-Look-style preview (window/keys.rs,
// window/zoom.rs): key routing, wheel/keyboard zoom anchored on a point with snapping to fit and to true
// 100%, fit-width, pan clamped so no empty margin shows. Pure; Lightbox.vue draws it.

export interface ViewState {
  /** Zoom relative to fit: 1 = the picture fitted to the window. */
  zoom: number
  panX: number
  panY: number
}

export interface Geometry {
  /** The picture's natural size. */
  iw: number
  ih: number
  /** The window area it sits in. */
  cw: number
  ch: number
}

export const FIT_VIEW: ViewState = { zoom: 1, panX: 0, panY: 0 }
/** One wheel notch or key press multiplies the zoom by this (zoom.rs). */
export const ZOOM_STEP = 1.2
/** A step landing within this fraction of fit or true 100% snaps onto it (zoom.rs ZOOM_SNAP_TOLERANCE). */
export const SNAP_TOLERANCE = 0.03

/** The scale that fits the picture into the area; a small picture is not blown up past its own size. */
export function fitScale({ iw, ih, cw, ch }: Geometry): number {
  if (iw <= 0 || ih <= 0 || cw <= 0 || ch <= 0) return 1
  return Math.min(1, cw / iw, ch / ih)
}

/** If the step old -> next crosses `anchor` (widened by the tolerance), land on it exactly. */
export function snapZoomStep(old: number, next: number, anchor: number, tolerance = SNAP_TOLERANCE): number {
  const band = anchor * tolerance
  if (Math.abs(old - anchor) <= band) return next
  const [lo, hi] = old < next ? [old, next] : [next, old]
  return lo <= anchor + band && hi >= anchor - band ? anchor : next
}

/** The zoom (relative to fit) that shows one picture pixel per screen pixel; never below 1. */
export function true100Zoom(fit: number): number {
  return Math.max(1 / fit, 1)
}

/** The most a step may zoom to: true 100%, but at least 8x. */
export function zoomCeiling(full: number): number {
  return Math.max(full, 8)
}

/** The zoom that makes the picture as wide as the area (a tall picture in a wide window); 1 when fit already is. */
export function fitWidthZoom(g: Geometry): number {
  if (g.iw <= 0) return 1
  const fit = fitScale(g)
  return Math.max(1, g.cw / g.iw / fit)
}

/** Keep the zoomed picture covering the area: no empty margin past its edges. */
export function clampPan(view: ViewState, g: Geometry): ViewState {
  const scale = fitScale(g) * view.zoom
  const maxX = Math.max(0, (g.iw * scale - g.cw) / 2)
  const maxY = Math.max(0, (g.ih * scale - g.ch) / 2)
  return { zoom: view.zoom, panX: Math.min(maxX, Math.max(-maxX, view.panX)), panY: Math.min(maxY, Math.max(-maxY, view.panY)) }
}

/** Zoom by `delta` notches keeping the picture point under `pt` (offsets from the area's centre) fixed. */
export function zoomStepAt(view: ViewState, delta: number, g: Geometry, pt: { x: number; y: number } = { x: 0, y: 0 }): ViewState {
  const fit = fitScale(g)
  const raw = view.zoom * ZOOM_STEP ** delta
  const full = true100Zoom(fit)
  const toFit = snapZoomStep(view.zoom, raw, 1)
  const snapped = Math.abs(toFit - raw) > Number.EPSILON ? toFit : snapZoomStep(view.zoom, raw, full)
  const zoom = Math.min(zoomCeiling(full), Math.max(1, snapped))
  if (Math.abs(zoom - view.zoom) < 1e-6) return view
  const ratio = zoom / view.zoom
  // The point under the cursor stays put: pan' = pt - (pt - pan) * ratio.
  return clampPan({ zoom, panX: pt.x - (pt.x - view.panX) * ratio, panY: pt.y - (pt.y - view.panY) * ratio }, g)
}

/** Toggle between fit and `target` zoom, recentred (Ctrl+0 -> true 100%, W -> fit-width). */
export function toggleZoom(view: ViewState, target: number): ViewState {
  return view.zoom <= 1.01 ? { zoom: target, panX: 0, panY: 0 } : FIT_VIEW
}

/** The percentage the picture is shown at, for the corner label. */
export function zoomPercent(view: ViewState, g: Geometry): number {
  return Math.round(fitScale(g) * view.zoom * 100)
}

/** What a key does in the open viewer. */
export type ViewerAction =
  | { type: 'close' }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'zoom'; delta: 1 | -1 }
  | { type: 'toggle100' }
  | { type: 'fitWidth' }
  | { type: 'fullscreen' }
  | { type: 'annotate' }

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/**
 * Route one key press. Space, Esc and Enter close (keys.rs keydown_lifecycle); Left/Right and PgUp/PgDn flip
 * to the previous/next picture of the message; + and - (with or without Ctrl) zoom a step; 0 or 1 toggle
 * fit and true 100% (Ctrl+0 in SageThumbs); W toggles fit-width; F or F11 toggles full screen; A starts annotating.
 */
export function viewerKeyAction(e: KeyLike): ViewerAction | null {
  if (e.altKey) return null
  const mod = !!(e.ctrlKey || e.metaKey)
  switch (e.key) {
    case ' ':
    case 'Spacebar':
    case 'Escape':
    case 'Enter':
      return mod ? null : { type: 'close' }
    case 'ArrowRight':
    case 'PageDown':
      return { type: 'step', delta: 1 }
    case 'ArrowLeft':
    case 'PageUp':
      return { type: 'step', delta: -1 }
    case '+':
    case '=':
      return { type: 'zoom', delta: 1 }
    case '-':
    case '_':
      return { type: 'zoom', delta: -1 }
    case '0':
    case '1':
      return { type: 'toggle100' }
    case 'w':
    case 'W':
      return mod ? null : { type: 'fitWidth' }
    case 'f':
    case 'F':
      return mod ? null : { type: 'fullscreen' }
    case 'F11':
      return { type: 'fullscreen' }
    case 'a':
    case 'A':
      return mod ? null : { type: 'annotate' }
    default:
      return null
  }
}

/** The index one step on, stopping at both ends (SageThumbs never wraps). */
export function stepIndex(index: number, count: number, delta: number): number {
  return Math.min(count - 1, Math.max(0, index + delta))
}
