// server/src/core/stat-stamp.ts - "is this file still the bytes I parsed?", answered from a stat.
//
// Shared by every per-file parse cache that the daemon re-validates on each scan (the desktop chat
// store in core/chat-store-scan.ts, the zswarm's job.json files in zswarm-sessions.ts), so the one
// subtle rule below has one owner.

import type { Stats } from 'node:fs'

/** The stat a parse was taken at, and when. */
export interface StatStamp {
  mtimeMs: number
  ctimeMs: number
  size: number
  /** When the file was read. See RACY_MS. */
  readAt: number
}

/**
 * A file changed less than this long before it was read is re-read on the next scan anyway -
 * git's "racily clean" rule. A file's timestamps only advance with the clock tick, so a second
 * same-size write inside the tick of the first leaves mtime, ctime and size ALL identical
 * (measured 2026-09-27, Bun on NTFS: two back-to-back writes, byte-identical stat in 2 runs of 3),
 * and a read that fell between the two would be served forever. Once a read is RACY_MS past the
 * file's last change, any later write carries a later timestamp and the stat catches it.
 *
 * ctime is in the stamp because nothing can set it: a writer that restores a file's mtime still
 * moves its ctime.
 */
const RACY_MS = 1_000

export function stampOf(st: Stats, readAt = Date.now()): StatStamp {
  return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, readAt }
}

/** Whether a parse taken at `stamp` still describes a file that stats as `st` now. */
export function unchangedSince(stamp: StatStamp | undefined, st: Stats): boolean {
  return (
    !!stamp &&
    stamp.mtimeMs === st.mtimeMs &&
    stamp.ctimeMs === st.ctimeMs &&
    stamp.size === st.size &&
    Math.max(stamp.mtimeMs, stamp.ctimeMs) < stamp.readAt - RACY_MS
  )
}
