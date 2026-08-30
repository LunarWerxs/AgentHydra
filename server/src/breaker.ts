// server/src/breaker.ts - THE CIRCUIT BREAKER: a bound on how many times the AUTOMATED
// machinery may repeat the same action on the same chat.
//
// WHY (measured by v1, 2026-08-28, and the mechanism still exists in the rebuild): the same
// finished chat was re-archived FOUR times in one evening. Every pass was individually
// correct - the archive executed and verified, the running app then re-saved its sidebar
// entry un-archived, the sweep saw a done-marked visible chat again, and round it went.
// Nothing anywhere COUNTED. A deterministic gate (chat-gate.ts) makes a WRONG verdict
// unlikely; it does nothing whatsoever about a CORRECT verdict repeated forever, because
// each pass really is right about the world it sees.
//
// THE LAW THIS LIVES UNDER, and the reason it is not a regression:
//   - It bounds the UNATTENDED path only (the sweep, the courier). A deed the owner or an AI
//     session asks for directly is never blocked - being asked is the point of asking.
//   - Every suppression is LOUD: the caller gets a row saying which action was withheld, how
//     many attempts it has seen, and when it will be allowed again. A silent brake would be
//     the false quiet this repo treats as its worst failure mode.
//   - Success CLEARS the count. The brake exists for futile repetition, not for work that is
//     landing.

import { db } from './db'

/** Attempts allowed per (kind, session) inside the window; the next one is suppressed. */
export const ATTEMPT_CAP = 4
/** The sliding window. Long enough to catch an evening-long loop, short enough that a chat
 *  genuinely worked on hours later is not still being punished for this morning. */
export const ATTEMPT_WINDOW_MS = 6 * 3600 * 1000

/** What the machinery can repeat. Kept explicit so a new action must opt in deliberately. */
export type BreakerKind = 'archive' | 'surface' | 'deliver'

export interface BreakerVerdict {
  suppressed: boolean
  /** Attempts already recorded inside the window (not counting the one being asked about). */
  attempts: number
  /** Set when suppressed: when the oldest attempt leaves the window and the cap frees up. */
  retryAfter: string | null
  why: string
}

function prune(nowMs: number): void {
  db.query('delete from action_attempt_log where at < ?').run(nowMs - ATTEMPT_WINDOW_MS)
}

function attemptsIn(kind: BreakerKind, sessionId: string, nowMs: number): number[] {
  return db
    .query<{ at: number }, [string, string, number]>(
      'select at from action_attempt_log where kind = ? and session_id = ? and at >= ? order by at asc',
    )
    .all(kind, sessionId, nowMs - ATTEMPT_WINDOW_MS)
    .map((r) => r.at)
}

/**
 * Should the unattended machinery skip this action right now? Read-only - call `noteAttempt`
 * when the action actually goes ahead.
 */
export function checkBreaker(
  kind: BreakerKind,
  sessionId: string,
  nowMs = Date.now(),
): BreakerVerdict {
  const at = attemptsIn(kind, sessionId, nowMs)
  if (at.length < ATTEMPT_CAP)
    return {
      suppressed: false,
      attempts: at.length,
      retryAfter: null,
      why: `${at.length} of ${ATTEMPT_CAP} attempts used in the last ${ATTEMPT_WINDOW_MS / 3600_000}h`,
    }
  const oldest = at[0] as number
  return {
    suppressed: true,
    attempts: at.length,
    retryAfter: new Date(oldest + ATTEMPT_WINDOW_MS).toISOString(),
    why:
      `'${kind}' has been attempted ${at.length} times on this chat in the last ` +
      `${ATTEMPT_WINDOW_MS / 3600_000}h without sticking - suppressed so the machinery stops ` +
      'repeating a futile cycle. A direct request from you is never blocked by this.',
  }
}

/** Record that the action went ahead. */
export function noteAttempt(kind: BreakerKind, sessionId: string, nowMs = Date.now()): void {
  prune(nowMs)
  // One row per attempt, always. An earlier cut keyed the table on (kind, session, at) and
  // therefore MERGED attempts inside the same millisecond - which is where a tight loop puts
  // them, so the counter under-counted exactly the case this module exists to catch.
  db.query('insert into action_attempt_log (kind, session_id, at) values (?, ?, ?)').run(
    kind,
    sessionId,
    nowMs,
  )
}

/** The action stuck: forget the history, because the brake is for futility, not for work. */
export function clearAttempts(kind: BreakerKind, sessionId: string): void {
  db.query('delete from action_attempt_log where kind = ? and session_id = ?').run(kind, sessionId)
}

/** Every chat currently being held back, for the status surfaces. */
export function suppressedChats(
  nowMs = Date.now(),
): Array<{ kind: BreakerKind; sessionId: string; attempts: number; retryAfter: string }> {
  const rows = db
    .query<{ kind: string; session_id: string; c: number; oldest: number }, [number]>(
      `select kind, session_id, count(*) c, min(at) oldest from action_attempt_log
       where at >= ? group by kind, session_id having c >= ${ATTEMPT_CAP}`,
    )
    .all(nowMs - ATTEMPT_WINDOW_MS)
  return rows.map((r) => ({
    kind: r.kind as BreakerKind,
    sessionId: r.session_id,
    attempts: r.c,
    retryAfter: new Date(r.oldest + ATTEMPT_WINDOW_MS).toISOString(),
  }))
}
