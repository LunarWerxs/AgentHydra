// How long a row's content takes to open or close (parts/Collapse.vue), and whether to animate at all. The
// transcript keeps a clicked row still for as long as that takes (TranscriptView's holdRow).
export const COLLAPSE_MS = 180

export function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
