// server/src/core/login-sync-pace.ts — when the login sync's next pass is due.
//
// Measured 2026-10-03: with both PCs idle the store was still read about 2,300 rows an hour, because
// every 30 s pass reads the one-row head from D1 (the Worker is on *.workers.dev, where the Cache API
// is a no-op, so most free-plan isolates have no head of their own). The owner's budget is about 1,400
// rows a day, so an idle PC polls less: after a pass that found nothing new from the store and had
// nothing to upload, the next is due after BASE_MS, then twice that, and so on up to IDLE_MAX_MS.
//
// The daemon still ticks every BASE_MS, and a tick costs the store nothing: it runs a pass only when
// one is due, or when something here changed (cli-login-sync.ts: a CliMayte worker is live, a login
// file moved). Back to BASE_MS at once after a pass that was not quiet, after nudge() (a local change:
// nudgeLoginSync) and after a manual sync or a launch.
//
// QUIET MEANS NO WORK OF THIS PC'S OWN (2026-10-04): news that only came DOWN from the store (the other
// PC's queue moved, a remote login row changed) is not work and does not hold the 30 s pace. Measured
// 2026-10-04: two busy PCs kept each other at 30 s all day (a busy hour read 2,100 to 2,900 rows). Not
// quiet: a pending upload (this PC's queue snapshot went up with news), a login pushed or landed, a
// failed pass, a moved login file (nudge), a manual sync or a launch. News that arrives is read on the
// next due pass, at most IDLE_MAX_MS later. Active-hour test (login-sync-quiet-hour.test.ts: 40 worker
// shape changes, 4 login refreshes, the other PC idle): 79 rows read an hour, 176 before this.
//
// LIVENESS RIDES THE POLLS: every changes poll names this PC, the store's Worker stamps it seen, and
// the other PC treats it as gone after REMOTE_STALE_MS (20 min, climayte-remote.ts) without a stamp.
// IDLE_MAX_MS (5 min) is well inside that: a pass, and so a poll, is due at least every 5 minutes.

/** How often the loop ticks, and the wait of a PC with something to do or just back from a change. */
export const BASE_MS = 30_000
/** The longest an idle PC waits between passes. */
export const IDLE_MAX_MS = 300_000

export class SyncPace {
  private wait = BASE_MS
  private dueAt = 0
  private dirty = false

  /** A pass is due (the first one always is). */
  due(now: number): boolean {
    return now >= this.dueAt
  }

  /** A local change: a pass is due now (the next tick runs it), and the wait starts over. */
  nudge(): void {
    this.dirty = true
    this.dueAt = 0
    this.wait = BASE_MS
  }

  /** A pass finished at `now`. Not quiet (it found or sent something), or nudged since it began: the
   *  next is due in BASE_MS. Quiet: in the current wait, which then doubles up to IDLE_MAX_MS. */
  afterPass(quiet: boolean, now: number): void {
    const nudged = this.dirty
    this.dirty = false
    if (!quiet || nudged) {
      this.wait = BASE_MS
      this.dueAt = nudged ? 0 : now + BASE_MS
      return
    }
    this.dueAt = now + this.wait
    this.wait = Math.min(this.wait * 2, IDLE_MAX_MS)
  }
}
