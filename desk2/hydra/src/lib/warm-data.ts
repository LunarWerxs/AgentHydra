// Hydra Desk 2: the one place that keeps every tab's data warm. Each kind of data (CLI instances,
// desktop instances, analytics, HSwarm, CliMayte) has ONE shared store and ONE refresh function here;
// the pages only read the store. This module decides when it is asked again:
//   - once in the background after the window is up (startWarm, staggered so the daemon is not hit by
//     every kind in the same moment),
//   - about every 2 minutes while Desk is open, never while the document is hidden, and catching up
//     as soon as it is visible again,
//   - right when a page is opened or the Desk pane is shown (refreshForView).
// A kind never has two requests in flight (an overlapping ask shares the running one) and is never
// asked twice within MIN_GAP_MS, so a page and its children opening together cost one request.

export type WarmKind = 'cli' | 'desktop' | 'analytics' | 'hswarm' | 'climayte' | 'routing'

/** How often a kind is refreshed in the background (never below a minute). */
export const WARM_MS = 120_000
/** A refresh finished less than this long ago answers a "viewed it" ask without another request. */
const MIN_GAP_MS = 5_000
/** How often the scheduler looks at what is due; the kinds themselves wait WARM_MS between requests. */
const TICK_MS = 30_000
/** Gap between the first background loads of the kinds. */
const STAGGER_MS = 1_500

interface Entry {
  fetch: () => Promise<unknown>
  inflight: Promise<void> | null
  /** When the last attempt finished (0 = never). */
  at: number
}
const entries = new Map<WarmKind, Entry>()
let timer: number | null = null
let started = false

/** Declares how a kind is refreshed. Called once per kind, at module load. */
export function registerWarm(kind: WarmKind, fetch: () => Promise<unknown>): void {
  entries.set(kind, { fetch, inflight: null, at: 0 })
}

/** Refreshes a kind now. An overlapping ask shares the request already running; `viewed` asks (a page
 *  opened) are answered by a refresh from the last few seconds. */
export function refreshWarm(kind: WarmKind, opts: { viewed?: boolean } = {}): Promise<void> {
  const e = entries.get(kind)
  if (!e) return Promise.resolve()
  if (e.inflight) return e.inflight
  if (opts.viewed && Date.now() - e.at < MIN_GAP_MS) return Promise.resolve()
  const run: Promise<void> = Promise.resolve()
    .then(e.fetch)
    .then(() => {})
    .catch(() => {
      // A failed read leaves the store as it was; the stores keep their own error state.
    })
    .finally(() => {
      e.at = Date.now()
      e.inflight = null
    })
  e.inflight = run
  return run
}

/** The kinds a view shows. */
const VIEW_KINDS: Record<string, readonly WarmKind[]> = {
  'instances-home': ['cli', 'desktop', 'climayte', 'hswarm'],
  analytics: ['analytics'],
  hswarm: ['hswarm', 'climayte', 'routing'],
  cli: ['cli', 'desktop'],
  desktop: ['desktop', 'cli'],
}

/** A page was opened (or the pane was shown on it): refresh what it shows, right then. */
export function refreshForView(view: string): void {
  for (const k of VIEW_KINDS[view] ?? []) void refreshWarm(k, { viewed: true })
}

function refreshDue(): void {
  if (document.visibilityState === 'hidden') return
  const now = Date.now()
  for (const [kind, e] of entries) if (!e.inflight && now - e.at >= WARM_MS) void refreshWarm(kind)
}

/** Loads every kind once, a few seconds apart, then keeps them fresh. Safe to call twice. */
export function startWarm(): void {
  if (started) return
  started = true
  let i = 0
  for (const kind of entries.keys()) {
    window.setTimeout(() => {
      // Hidden at that moment: the visibility catch-up below loads it when it is shown.
      if (document.visibilityState !== 'hidden') void refreshWarm(kind)
    }, i++ * STAGGER_MS)
  }
  timer = window.setInterval(refreshDue, TICK_MS)
  document.addEventListener('visibilitychange', refreshDue)
}

export function stopWarm(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  started = false
  document.removeEventListener('visibilitychange', refreshDue)
}
