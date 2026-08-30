// server/src/deliveries.ts - THE DELIVERY LEDGER: the deterministic half of "the delivery
// half" (rebuild backlog, 2026-08-30). The act path SURFACES a chat dormant and hands its
// resume prompt to the caller - and until now nothing tracked whether that delivery ever
// happened. A surfaced chat whose prompt nobody sent sits dormant forever, indistinguishable
// from delivered-and-thinking: exactly the one-shot-then-log silent-loss shape the
// import-retry lesson banked ("when a correct guard's refusal is the COMMON case, arm and
// retry").
//
// WHO SENDS stays exactly where the measured boundary and the owner's bans put it: an AI
// session's native per-instance send (mcp ccd_session_mgmt send_message - proven 5-for-5) or
// a live peer SendMessage; NEVER the daemon (no channel by design), NEVER a relay through the
// owner's working chats (banned 2026-08-28), NEVER headless. This module only STAGES, TRACKS,
// VERIFIES and ESCALATES:
//
//   pending     staged, not yet observed delivered.
//   superseded  a re-surface staged a newer prompt; the old attempt is history, never erased.
//   delivered   the transcript's exact mtime moved past the staging instant - a delivered
//               prompt lands as a user turn, so that is the deterministic receipt.
//   deaf        a live process started after staging but the transcript never moved (the
//               banked engine-never-started orphan flavor). SEMI-terminal: late movement
//               upgrades it to delivered.
//   expired     pending for 24h - given up, reason kept, same convention as import retries.

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { db } from './db'
import { findTranscriptById, readLiveRegistry } from './live-registry'

export type DeliveryState = 'pending' | 'delivered' | 'deaf' | 'expired' | 'superseded'

export const DELIVERY_STATES: readonly DeliveryState[] = [
  'pending',
  'delivered',
  'deaf',
  'expired',
  'superseded',
]

/** The route's state-filter contract, pure and pinned by tests. */
export function parseDeliveryState(
  v: unknown,
): { ok: true; state: DeliveryState | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, state: undefined }
  if (typeof v === 'string' && (DELIVERY_STATES as readonly string[]).includes(v))
    return { ok: true, state: v as DeliveryState }
  return { ok: false, error: `state must be one of ${DELIVERY_STATES.join(', ')}` }
}

export interface DeliveryRow {
  id: string
  session_id: string
  prompt: string
  instance_ref: string | null
  state: DeliveryState
  staged_at: number
  resolved_at: number | null
  evidence: string | null
}

const EXPIRE_MS = 24 * 3600 * 1000

/** Stage (or restage) the prompt for a just-surfaced chat: one PENDING row per session. An
 *  earlier pending row is SUPERSEDED with the reason kept, never deleted (review-confirmed:
 *  a hard delete erased the record that an attempt was ever staged - the exact silent loss
 *  this ledger exists to prevent). Resolved history is never touched. */
export function stageDelivery(opts: {
  sessionId: string
  prompt: string
  instanceRef: string | null
  nowMs?: number
}): void {
  const now = opts.nowMs ?? Date.now()
  db.query(
    "update deliveries set state = 'superseded', resolved_at = ?, evidence = ? where session_id = ? and state = 'pending'",
  ).run(now, 'replaced by a newer staging before any delivery was observed', opts.sessionId)
  db.query(
    "insert into deliveries (id, session_id, prompt, instance_ref, state, staged_at) values (?, ?, ?, ?, 'pending', ?)",
  ).run(crypto.randomUUID(), opts.sessionId, opts.prompt, opts.instanceRef, now)
}

export interface DeliveryDeps {
  nowMs?: number
  /** Last transcript activity for a session, ms since epoch; null = no transcript found. */
  lastActivity?: (sessionId: string, nowMs: number) => number | null
  /** Live process start time for a session, ms; null = not live. */
  liveSince?: (sessionId: string) => number | null
}

function realLastActivity(sessionId: string, _nowMs: number): number | null {
  // The transcript file's EXACT mtime, never a reconstruction: the first cut derived this
  // from second-rounded quietSecs, and the rounding both fabricated receipts (an activity
  // computed up to ~500ms later than the true write) and erased real ones (review-confirmed,
  // both directions). A delivered prompt lands as a user turn, which moves the mtime.
  const path = findTranscriptById(join(homedir(), '.claude'), sessionId)
  if (!path) return null
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function realLiveSince(sessionId: string): number | null {
  const entry = readLiveRegistry(join(homedir(), '.claude')).find((s) => s.sessionId === sessionId)
  return entry ? entry.startedAt : null
}

/** Settle every open row from observable evidence. Deterministic, idempotent, cheap. 'deaf'
 *  is SEMI-terminal (review-confirmed: a slow-booting engine can deliver moments after the
 *  first pass labeled it deaf): late transcript movement upgrades deaf -> delivered.
 *  delivered/expired/superseded never re-settle. */
export function reconcileDeliveries(deps: DeliveryDeps = {}): void {
  const now = deps.nowMs ?? Date.now()
  const lastActivity = deps.lastActivity ?? realLastActivity
  const liveSince = deps.liveSince ?? realLiveSince
  const open = db
    .query<DeliveryRow, []>("select * from deliveries where state in ('pending', 'deaf')")
    .all()
  for (const row of open) {
    const activity = lastActivity(row.session_id, now)
    if (activity !== null && activity > row.staged_at) {
      db.query(
        "update deliveries set state = 'delivered', resolved_at = ?, evidence = ? where id = ?",
      ).run(
        now,
        `transcript moved at ${new Date(activity).toISOString()}, after staging` +
          (row.state === 'deaf'
            ? ' (the engine started late; the earlier deaf label was premature)'
            : ''),
        row.id,
      )
      continue
    }
    if (row.state === 'deaf') continue // still deaf; nothing new to say
    const live = liveSince(row.session_id)
    if (live !== null && live > row.staged_at) {
      // A process started after staging but the transcript never moved: the engine did not
      // start. Deaf, not delivered - the reviver must not message into the void again.
      db.query(
        "update deliveries set state = 'deaf', resolved_at = ?, evidence = ? where id = ?",
      ).run(
        now,
        `a process started ${new Date(live).toISOString()} but the transcript never moved - engine never started (the live-but-deaf orphan flavor)`,
        row.id,
      )
      continue
    }
    if (now - row.staged_at > EXPIRE_MS) {
      db.query(
        "update deliveries set state = 'expired', resolved_at = ?, evidence = ? where id = ?",
      ).run(
        now,
        'pending for 24h with no delivery observed - given up, reason kept' +
          (activity === null
            ? ' (no transcript found at expiry: it may have vanished or rolled over)'
            : ''),
        row.id,
      )
    }
  }
}

/** The ledger, newest first; reconciles first so the answer is current, never a stale read. */
export function listDeliveries(state?: DeliveryState, deps: DeliveryDeps = {}): DeliveryRow[] {
  reconcileDeliveries(deps)
  return state
    ? db
        .query<DeliveryRow, [string]>(
          'select * from deliveries where state = ? order by staged_at desc',
        )
        .all(state)
    : db.query<DeliveryRow, []>('select * from deliveries order by staged_at desc').all()
}

/** The rows prestart shows: what is staged and still waiting on a sender. */
export function pendingDeliveries(deps: DeliveryDeps = {}): DeliveryRow[] {
  return listDeliveries('pending', deps)
}
