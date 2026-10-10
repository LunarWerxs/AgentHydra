/** A synchronous call that holds the server's one thread for this long is written to the timings log as `sync_block`. */
export const SYNC_BLOCK_MS = 50

export interface SyncBlock {
  label: string
  ms: number
  /** The first frame outside this file and write-flushed.ts, as `server/src/engine/queue.ts:662` (relative to desk2/). */
  caller?: string
}

let sink: ((block: SyncBlock) => void) | null = null

export function setSyncBlockSink(fn: ((block: SyncBlock) => void) | null): void {
  sink = fn
}

const WRAPPERS = /[\\/](sync-block|write-flushed)\.ts$/
const FRAME = /(?:\(|\bat )(?:file:\/\/\/)?(.+?):(\d+):\d+\)?\s*$/

function callerOf(stack: string | undefined): string | undefined {
  for (const line of (stack ?? '').split('\n')) {
    const m = FRAME.exec(line.trim())
    if (!m || WRAPPERS.test(m[1]!)) continue
    const path = m[1]!.replace(/\\/g, '/')
    const i = path.lastIndexOf('/desk2/')
    return `${i >= 0 ? path.slice(i + '/desk2/'.length) : path}:${m[2]}`
  }
  return undefined
}

/** Runs a synchronous call, reporting it to the sink when it blocked the thread for SYNC_BLOCK_MS or more. */
export function timedSync<T>(label: string, fn: () => T): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - started
    if (ms >= SYNC_BLOCK_MS) sink?.({ label, ms: Math.round(ms), caller: callerOf(new Error().stack) })
  }
}
