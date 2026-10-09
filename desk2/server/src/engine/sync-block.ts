/** A synchronous call that holds the server's one thread for this long is written to the timings log as `sync_block`. */
export const SYNC_BLOCK_MS = 50

export interface SyncBlock {
  label: string
  ms: number
}

let sink: ((block: SyncBlock) => void) | null = null

export function setSyncBlockSink(fn: ((block: SyncBlock) => void) | null): void {
  sink = fn
}

/** Runs a synchronous call, reporting it to the sink when it blocked the thread for SYNC_BLOCK_MS or more. */
export function timedSync<T>(label: string, fn: () => T): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - started
    if (ms >= SYNC_BLOCK_MS) sink?.({ label, ms: Math.round(ms) })
  }
}
