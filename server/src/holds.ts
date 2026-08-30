// server/src/holds.ts - HANDS OFF THIS CHAT. A per-session opt-out from the automation.
//
// WHY (owner request 2026-08-30, and v1 had it as setSessionHold): the fleet-wide switches are
// too blunt. Turning the sweep off to protect ONE delicate thread stops the machinery tending
// the other twenty; leaving it on means a chat the owner is personally mid-thought in can be
// archived or resumed under him. A hold is the small, honest instrument between those.
//
// WHAT A HOLD STOPS, and what it deliberately does NOT:
//   - The UNATTENDED machinery skips the chat entirely: no archive, no surface, no delivery.
//   - A deed the owner or an AI session asks for DIRECTLY still runs. A hold is "leave this
//     alone on your own initiative", not a lock - being asked is the point of asking, and a
//     hold you cannot override is a hold that gets deleted in frustration later.
//   - Nothing about the chat is hidden. It still appears in reports, still gets gated, still
//     shows up in the pre-start check WITH its hold and reason, because a chat that silently
//     vanished from the fleet view would be worse than one that is acted on.
//
// The reason is stored, not just the flag: "why is nothing happening to this chat?" is the
// question a hold creates, and it should answer itself six weeks later.

import { db } from './db'

export interface Hold {
  sessionId: string
  reason: string
  heldAt: string
}

/** Put a chat out of the automation's reach. An empty reason is refused - an unexplained hold
 *  is indistinguishable from a bug when someone finds it later. */
export function holdSession(
  sessionId: string,
  reason: string,
  nowMs = Date.now(),
): { ok: true; hold: Hold } | { ok: false; error: string } {
  const id = sessionId.trim()
  const why = reason.trim()
  if (!id) return { ok: false, error: 'session_id is required' }
  if (!why)
    return {
      ok: false,
      error: 'a reason is required - an unexplained hold reads as a bug to whoever finds it',
    }
  db.query(
    `insert into session_holds (session_id, reason, held_at) values (?, ?, ?)
     on conflict(session_id) do update set reason = excluded.reason, held_at = excluded.held_at`,
  ).run(id, why, nowMs)
  return { ok: true, hold: { sessionId: id, reason: why, heldAt: new Date(nowMs).toISOString() } }
}

/** Hand the chat back to the automation. Releasing something not held is fine, not an error:
 *  the caller's intent (this chat should not be held) is satisfied either way. */
export function releaseSession(sessionId: string): { ok: true; wasHeld: boolean } {
  const had = isHeld(sessionId) !== null
  db.query('delete from session_holds where session_id = ?').run(sessionId.trim())
  return { ok: true, wasHeld: had }
}

/** The hold on this chat, or null. */
export function isHeld(sessionId: string): Hold | null {
  const row = db
    .query<{ session_id: string; reason: string; held_at: number }, [string]>(
      'select session_id, reason, held_at from session_holds where session_id = ?',
    )
    .get(sessionId.trim())
  return row
    ? { sessionId: row.session_id, reason: row.reason, heldAt: new Date(row.held_at).toISOString() }
    : null
}

/** Every held chat, newest first - the pre-start check lists these so a hold is never a
 *  mystery gap in the fleet's activity. */
export function listHolds(): Hold[] {
  return db
    .query<{ session_id: string; reason: string; held_at: number }, []>(
      'select session_id, reason, held_at from session_holds order by held_at desc',
    )
    .all()
    .map((r) => ({
      sessionId: r.session_id,
      reason: r.reason,
      heldAt: new Date(r.held_at).toISOString(),
    }))
}
