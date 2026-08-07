// server/src/update-progress.ts — what the self-update is doing RIGHT NOW.
//
// Written for a specific complaint: clicking the version text to update "just sat there spinning
// for a very long time". The spinner was not stuck — it was bound to one unresolved POST
// /api/update/apply, and that request legitimately covers minutes of work (a ~100 MB release
// download, or on a source checkout a git pull plus `bun install` plus a web build). With no
// intermediate signal, a long-but-healthy update and a hung one look identical, so the only honest
// reading available to the user was "it's broken".
//
// So: the apply publishes where it is, here, and the UI polls it. That is all this module is — a
// single in-memory record with a monotonic sequence number. Deliberately NOT persisted and
// deliberately not per-client:
//
//  * An apply is a singleton by construction (auto-update.ts guards overlap, and the compiled path
//    swaps the running executable), so there is exactly one thing to report at a time.
//  * It must survive nothing. A daemon that restarts mid-apply has, by definition, finished the
//    part worth reporting; resurrecting a stale "downloading 40%" after a relaunch would be a lie.
//
// The compiled path can be specific (it owns its own download loop, so it reports real bytes). The
// source path cannot: `git pull` / `bun install` / the web build run inside the shared kit engine
// (updater-engine.mjs, synced — not ours to edit), so it reports the coarse phase it is in and an
// honest note about why that phase can take minutes. Coarse and true beats precise and invented.

/** Where an apply currently is. `idle` means nothing has run since the daemon booted. */
export type UpdatePhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'installing'
  | 'building'
  | 'done'
  | 'failed'

export interface UpdateProgress {
  phase: UpdatePhase
  /** One human sentence for this phase — rendered as-is by the UI. */
  message: string
  /** When the CURRENT apply began, so the UI can show elapsed time. Null while idle. */
  startedAt: number | null
  /** Bytes received / expected, when the phase is a download and the server sent a length. */
  receivedBytes: number | null
  totalBytes: number | null
  /** Bumped on every mutation, so a poller can tell "still on the same phase" from "stalled". */
  seq: number
}

const IDLE: UpdateProgress = {
  phase: 'idle',
  message: '',
  startedAt: null,
  receivedBytes: null,
  totalBytes: null,
  seq: 0,
}

let current: UpdateProgress = { ...IDLE }

/** The live record. Returned by value so a caller cannot mutate the module's state through it. */
export function updateProgress(): UpdateProgress {
  return { ...current }
}

/** Begin a new apply. Clears any bytes left over from a previous run so a fresh download cannot
 *  inherit the last one's totals. */
export function beginUpdateProgress(message: string, now = Date.now()): void {
  current = {
    phase: 'preparing',
    message,
    startedAt: now,
    receivedBytes: null,
    totalBytes: null,
    seq: current.seq + 1,
  }
}

/** Move to a phase. Byte counters reset unless this phase is itself a download — carrying them
 *  forward would leave "62 MB of 96 MB" pinned under a message about extracting. */
export function setUpdatePhase(phase: UpdatePhase, message: string): void {
  current = {
    ...current,
    phase,
    message,
    receivedBytes: phase === 'downloading' ? current.receivedBytes : null,
    totalBytes: phase === 'downloading' ? current.totalBytes : null,
    seq: current.seq + 1,
  }
}

/** Report download progress. `total` may be null when the server sends no content-length, in which
 *  case the UI shows bytes received without a percentage rather than inventing a denominator. */
export function setUpdateBytes(received: number, total: number | null): void {
  current = { ...current, receivedBytes: received, totalBytes: total, seq: current.seq + 1 }
}

/** Terminal states. Kept (rather than reset to idle) so the UI's last poll can still read the
 *  outcome — the next apply calls beginUpdateProgress and overwrites it. */
export function finishUpdateProgress(ok: boolean, message: string): void {
  current = {
    ...current,
    phase: ok ? 'done' : 'failed',
    message,
    receivedBytes: null,
    totalBytes: null,
    seq: current.seq + 1,
  }
}

/** Test seam. */
export function resetUpdateProgress(): void {
  current = { ...IDLE }
}
