// web/src/lib/usage-catchup.ts — "which quota readings are actually worth re-checking right now?"
//
// The Instances tab used to answer that with "all of them", the moment the lists arrived: one
// forced probe per instance, fired from a single unbounded Promise.all. Measured 2026-08-07 on a
// 15-instance install, that was FOURTEEN simultaneous probes at t+0.5s, the slowest taking 8.8
// seconds to come back — a thundering herd against Anthropic's usage endpoint on every single open
// of the app, to refresh numbers that in the overwhelming majority of cases had been refreshed
// minutes earlier and were already on screen.
//
// The premise it was written under no longer holds. The server keeps its usage cache in a real file
// (server/src/usage-cache.ts) that survives a restart, and re-sweeps it on its own timer
// (server/src/usage-refresh.ts, 15 min by default, sequential with a 750ms stagger). So a freshly
// opened window is NOT looking at an empty table waiting to be filled — it is looking at the last
// known readings, and the only honest question left is which of them have aged out.
//
// Hence: a staleness gate, a concurrency cap and a stagger. "Not slowly, but not all at once."
//
// The gate is deliberately generous about what counts as fresh and strict about what counts as
// unknown:
//  * NO snapshot at all is always worth a probe — that is a genuinely blank cell, the one case
//    where waiting on the server's timer means staring at "—" for up to 15 minutes.
//  * A snapshot whose capturedAt cannot be parsed counts as unknown, not as fresh. Treating a
//    malformed timestamp as recent would pin a broken reading on screen indefinitely.

import type { UsageSnapshot } from '@/lib/api'

/**
 * How old a cached reading may be before an opening window re-checks it.
 *
 * Ten minutes, which sits deliberately BELOW the server's 15-minute default sweep: the point is to
 * catch the window that opened just before a sweep was due, not to duplicate the sweep. Above the
 * sweep interval this gate would essentially never fire; far below it, every window open turns back
 * into the herd this module exists to prevent.
 */
export const USAGE_CATCHUP_MAX_AGE_MS = 10 * 60 * 1000

/** Probes in flight at once. Two, not the four used for identity resolves: this is speculative
 *  background catch-up that nobody asked for, and it must never compete with a probe the user
 *  actually clicked. */
export const USAGE_CATCHUP_CONCURRENCY = 2

/** Gap between starting one probe and the next, mirroring the server sweep's own 750ms stagger.
 *  Turns a burst into a trickle without making the catch-up feel like it stalled. */
export const USAGE_CATCHUP_STAGGER_MS = 400

/**
 * Is this reading missing or old enough to be worth one probe?
 *
 * `now` and `maxAgeMs` are parameters rather than reads of the ambient clock so the rule is
 * testable without faking time.
 */
export function needsUsageCatchup(
  snap: UsageSnapshot | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = USAGE_CATCHUP_MAX_AGE_MS,
): boolean {
  if (!snap) return true
  const captured = Date.parse(snap.capturedAt)
  if (!Number.isFinite(captured)) return true
  return now - captured >= maxAgeMs
}

/** The subset of `rows` whose cached reading has aged out. Order is preserved, so the rows nearest
 *  the top of the table are the ones that refresh first. */
export function selectUsageCatchup<T>(
  rows: readonly T[],
  snapOf: (row: T) => UsageSnapshot | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = USAGE_CATCHUP_MAX_AGE_MS,
): T[] {
  return rows.filter((row) => needsUsageCatchup(snapOf(row), now, maxAgeMs))
}

/**
 * Run `check` over `items` a few at a time, pausing between starts.
 *
 * Resolves once every item has been attempted. A failing check is swallowed: this is best-effort
 * catch-up, and one instance that cannot be reached must not abandon the rest of the queue.
 *
 * `sleep` is injectable so a test can drive the stagger without waiting on real timers.
 */
export async function runUsageCatchup<T>(
  items: readonly T[],
  check: (item: T) => Promise<unknown>,
  opts: {
    concurrency?: number
    staggerMs?: number
    sleep?: (ms: number) => Promise<void>
    signal?: { aborted: boolean }
  } = {},
): Promise<number> {
  const concurrency = Math.max(1, opts.concurrency ?? USAGE_CATCHUP_CONCURRENCY)
  const staggerMs = Math.max(0, opts.staggerMs ?? USAGE_CATCHUP_STAGGER_MS)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const queue = items.slice()
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async (_, lane) => {
    // Fan the lanes out rather than starting them together, so even the first tick is staggered.
    if (lane > 0 && staggerMs) await sleep(staggerMs * lane)
    for (;;) {
      if (opts.signal?.aborted) return
      const item = queue.shift()
      if (!item) return
      try {
        await check(item)
      } catch {
        // Best-effort — the row keeps its last known reading and the next open tries again.
      }
      done += 1
      if (queue.length && staggerMs) await sleep(staggerMs)
    }
  })
  await Promise.all(workers)
  return done
}
