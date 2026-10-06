// Keep windows running for Free Claude logins (owner, 2026-10-06: "we should have the Keep Windows Running
// option on the free as well ... at least for the Claude ones"). It mirrors AgentHydra's CLI keepalive
// (server/src/session-keepalive.ts): an idle account's five-hour window only starts with a message, so
// one throwaway incognito message ('nudge') starts it, unless the reading says it should be left alone.

import type { FreeInstance, FreeSettings } from '@shared/free-instances'

export const NUDGE_EVERY_MS = 10 * 60_000
export const FIVE_HOURS_MS = 5 * 3_600_000
export const RETRY_AFTER_FAIL_MS = 60 * 60_000

/** Whether this account should get a nudge now: pure, so every rule is one line of a table test. */
export function nudgeDue(i: FreeInstance, s: FreeSettings, now: number): boolean {
  // Off until the owner switches it on: a nudge spends real quota.
  if (!s.keepWindows) return false
  // Only signed-in Claude logins have a five-hour window to start.
  if (i.provider !== 'claude' || !i.loggedIn) return false
  // An unreadable reading is a skip, never a guess.
  if (!i.usage) return false
  const five = i.usage.windows.find(w => w.id.startsWith('five_hour'))
  const week = i.usage.windows.find(w => w.id.startsWith('seven_day'))
  // Its five-hour window already runs: that is the whole goal.
  if (five?.resets_at && Date.parse(five.resets_at) > now) return false
  // Burning the last of a weekly cap to start a five-hour clock is backwards.
  if (week?.used_percent != null && week.used_percent >= s.weeklyFloorPct) return false
  // A reading lags a nudge: give the one just sent time to show.
  if (i.nudge?.ok && now - i.nudge.at < FIVE_HOURS_MS) return false
  // A failed nudge is retried later, not every pass.
  if (i.nudge && !i.nudge.ok && now - i.nudge.at < RETRY_AFTER_FAIL_MS) return false
  return true
}
