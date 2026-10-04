// server/src/core/map-pool.ts - Promise.all with a ceiling on how many run at once.
//
// In core/ so every reader can share it without an import cycle or a database handle: the session
// list (sessions.ts), the whole-store sweep (transcript.ts) and the desktop chat-store scan
// (core/chat-store-scan.ts, which must stay free of db.ts) each had or needed their own copy.

const YIELD_AFTER_MS = 20

/** Map `items` through `fn`, at most `width` at a time. Results stay in input order. */
export async function mapPool<T, R>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let sliceStart = performance.now()
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T)
      // A fn that answers from a cache never waits on I/O, and awaiting an already-settled promise
      // only turns the microtask queue, so a pool over thousands of cached items would run as one
      // block. By the clock, not by count: after YIELD_AFTER_MS of running, take a real turn of
      // the loop (a timer, so timers and HTTP both get theirs).
      if (performance.now() - sliceStart >= YIELD_AFTER_MS) {
        await new Promise<void>((r) => setTimeout(r, 0))
        sliceStart = performance.now()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}
