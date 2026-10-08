// How each Free account's messages ended over the last hour, so a row is marked only when the account is really
// failing (owner, 2026-10-08: "We should not be having red exclamation points ... unless the account is dead ...
// if 90 or 100% within the last hour fail, we probably should look into it"). One refused send (a rate limit, a
// rejected request) is a note in the row's hover, never a mark on it.
import type { FreeHealth } from '@shared/free-instances'

export const HEALTH_WINDOW_MS = 60 * 60_000
/** At least this share of the hour's messages failed, out of at least FAILING_MIN_SENDS, marks the row. */
export const FAILING_SHARE = 0.9
export const FAILING_MIN_SENDS = 5

export interface SendOutcome {
  at: number
  /** The failure's message, or null for a message that was answered. */
  error: string | null
}

/** The hour's outcomes with this one added; older ones dropped. */
export function addOutcome(list: readonly SendOutcome[] | undefined, outcome: SendOutcome, now = Date.now()): SendOutcome[] {
  return [...(list ?? []).filter(o => now - o.at < HEALTH_WINDOW_MS), outcome]
}

/** The hour in numbers; null when the account sent nothing in it. */
export function healthOf(list: readonly SendOutcome[] | undefined, now = Date.now()): FreeHealth | null {
  const hour = (list ?? []).filter(o => now - o.at < HEALTH_WINDOW_MS)
  if (!hour.length) return null
  const reasons: Record<string, number> = {}
  for (const o of hour) if (o.error) reasons[o.error] = (reasons[o.error] ?? 0) + 1
  const failed = hour.length - hour.filter(o => !o.error).length
  return { sent: hour.length, failed, failing: hour.length >= FAILING_MIN_SENDS && failed / hour.length >= FAILING_SHARE, reasons }
}
