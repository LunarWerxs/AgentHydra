// The Free accounts' rolling refresh (owner, 2026-10-06: "the five-hour and week things keep spinning every time I
// view the page. They're supposed to refresh on a rolling refresh and only display changes like on the others").
// The window used to check every account it found stale each time it opened, with a spinner on each row. Desk now
// reads them itself, one account per tick whether or not the window is open, as background work the window does not
// spin for (FreeJob.auto); the window only shows the readings that changed.

import type { FreeInstance } from '@shared/free-instances'

/** How often Desk looks for the next read. One account per tick, so the reads roll through the accounts. */
export const REFRESH_TICK_MS = 60_000
/** A Claude account's usage moves with every message it sends: read it again after this long. */
export const USAGE_EVERY_MS = 15 * 60_000
/** A login is checked again after this long. A check also reads the usage and the private chat list. */
export const LOGIN_EVERY_MS = 60 * 60_000

export interface FreeRead { id: string; command: 'auth' | 'usage' }

/** The one read the next tick starts, the most overdue account first; null when none is due. Pure, so every rule is a
 *  line of a table test. */
export function nextRead(instances: readonly FreeInstance[], busy: (id: string) => boolean, now: number): FreeRead | null {
  let best: (FreeRead & { overdue: number }) | null = null
  for (const i of instances) {
    if (busy(i.id)) continue
    // Never checked (a login another PC shared, an account added before checks): check it first. Signed out after a
    // check: nothing to read until someone signs in again.
    const login = i.checkedAt == null ? Number.POSITIVE_INFINITY : i.loggedIn ? now - i.checkedAt - LOGIN_EVERY_MS : Number.NEGATIVE_INFINITY
    // ChatGPT's free text has no window to move, so only a Claude login's usage is read between checks.
    const usage = i.loggedIn && i.provider === 'claude' ? now - (i.usageReadAt ?? i.checkedAt ?? 0) - USAGE_EVERY_MS : Number.NEGATIVE_INFINITY
    const read: FreeRead & { overdue: number } = login >= usage ? { id: i.id, command: 'auth', overdue: login } : { id: i.id, command: 'usage', overdue: usage }
    if (read.overdue >= 0 && (!best || read.overdue > best.overdue)) best = read
  }
  return best && { id: best.id, command: best.command }
}
