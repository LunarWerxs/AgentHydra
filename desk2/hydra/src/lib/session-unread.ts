// Unread sessions (owner, 2026-10-04): a session that moved since you last opened it has a bold
// title in the list. The rule is here; composables/useUnreadSessions.ts keeps the marks.

/** When each session was last seen (its last_activity_at then), and when this browser started
 *  keeping track: a session that moved before that is read, so nothing turns bold on first use. */
export interface SeenState {
  since: number
  seen: Record<string, number>
}

/** Marks older than this are dropped, so the map does not grow with every session ever opened. */
export const UNREAD_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

export function unreadKey(s: { source: string; session_id: string }): string {
  return `${s.source}:${s.session_id}`
}

/** It moved after you last opened it, and after this browser started keeping track. */
export function isUnread(state: SeenState, key: string, lastActivityAt: number): boolean {
  return lastActivityAt > Math.max(state.seen[key] ?? 0, state.since)
}

/** Seen up to its newest activity; a mark only moves forward. */
export function markSeen(state: SeenState, key: string, lastActivityAt: number): SeenState {
  if ((state.seen[key] ?? 0) >= lastActivityAt) return state
  return { since: state.since, seen: { ...state.seen, [key]: lastActivityAt } }
}

/** Drops marks older than the horizon and moves the tracking start up to it, so a session read
 *  before the prune stays read. Only one that went unread over 30 days ago stops being bold. */
export function pruneSeen(state: SeenState, now: number): SeenState {
  const horizon = now - UNREAD_HORIZON_MS
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => at >= horizon))
  if (Object.keys(seen).length === Object.keys(state.seen).length && state.since >= horizon)
    return state
  return { since: Math.max(state.since, horizon), seen }
}
