// server/src/core/loop-yield.ts - hand the daemon's one thread back between slices of a long job.
//
// ⛔ WHY (2026-09-27). The tray watchdog (misc/AgentHydra-Tray.json) tree-kills a daemon that
// leaves GET /api/health unanswered for three probes 5 s apart, each allowed 400 ms. A timer-started
// warm-up and a request share that one thread, so anything that runs synchronously past the budget
// is a kill waiting for a busy moment, however "background" it is. stall-sentinel.ts caught two on
// the live daemon the day it shipped: 3.7 s at boot and 4.7 s under load.
//
// Awaiting a promise that is already settled does NOT hand anything back: it resumes in the same
// turn, before any socket is read. Neither does a `for await` over a stream whose next chunk is
// already buffered. A loop over in-memory work has to give the turn up on purpose, and it should do
// so by the clock rather than every N items, because N items of a transcript range from a few
// bytes to megabytes.

/** Resolve on a later turn of the event loop, after the I/O that is waiting (a request) is served. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** How long one slice may run before it hands the turn back. Far under the watchdog's 400 ms, so
 *  several sliced jobs and a request handler can share a turn and a probe still gets through. */
export const SLICE_MS = 25

export interface TimeSlice {
  /** True once this slice has run for its budget. Cheap enough to ask on every item. */
  due(): boolean
  /** Give the turn back, then start a new slice. */
  pause(): Promise<void>
}

/** One long loop's clock: `if (slice.due()) await slice.pause()` between items. */
export function timeSlice(budgetMs = SLICE_MS): TimeSlice {
  let since = performance.now()
  return {
    due: () => performance.now() - since >= budgetMs,
    pause: async () => {
      await yieldToLoop()
      since = performance.now()
    },
  }
}
