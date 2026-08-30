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
//   delivered   the transcript gained TIMESTAMPED message records after the staging instant
//               - a delivered prompt lands as queue/user/assistant records, and the app's
//               timestamp-free bookkeeping appends (atis-latch, mode) move nothing.
//   deaf        a live process started after staging but the transcript never moved (the
//               banked engine-never-started orphan flavor). SEMI-terminal: late movement
//               upgrades it to delivered.
//   expired     pending for 24h - given up, reason kept, same convention as import retries.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
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
  // Supersede EVERY still-open row for this session, not just 'pending': deaf is equally
  // deliverable (deliverableDeliveries), so retiring only pending left a session with TWO
  // live rows - the courier would then deliver the same chat twice (review-confirmed).
  db.query(
    "update deliveries set state = 'superseded', resolved_at = ?, evidence = ? where session_id = ? and state in ('pending', 'deaf')",
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

/** How much transcript tail the receipt scan reads. Big enough to clear a large trailing
 *  tool-result record, small enough to stay a single cheap read. */
const RECEIPT_TAIL_BYTES = 512 * 1024

/**
 * The newest TIMESTAMPED record in a transcript - the delivery receipt.
 *
 * NOT the file mtime (measured live, 2026-08-30, drill chat 616ecfe8): the app appends
 * bookkeeping records (`atis-latch`, `mode`) to an imported chat's transcript with no
 * delivery anywhere near it, and a bare-mtime receipt read that as delivered. Real message
 * traffic - the queue-operation enqueue a native send writes, and the user/assistant turn
 * records that follow - carries a `timestamp` field; the bookkeeping records carry none. So
 * the receipt is the newest parseable timestamp in the tail, and an app touch moves nothing.
 */
/** Record types the APP appends as bookkeeping - never message traffic, never a receipt.
 *  Today they carry no timestamp; if one ever does, the schema assumption this receipt
 *  rests on has inverted, so that is warned about rather than silently absorbed. */
const BOOKKEEPING_TYPES = new Set(['atis-latch', 'mode'])

export function lastTranscriptMessageAt(
  path: string,
  tailBytes = RECEIPT_TAIL_BYTES,
): number | null {
  let fd: number
  let size: number
  try {
    size = statSync(path).size
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const scan = (want: number): number | null => {
      const buf = Buffer.alloc(want)
      readSync(fd, buf, 0, want, size - want)
      let newest: number | null = null
      for (const line of buf.toString('utf8').split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{') || !t.includes('"timestamp"')) continue
        try {
          const rec = JSON.parse(t) as { timestamp?: unknown; type?: unknown }
          if (typeof rec.timestamp !== 'string') continue
          if (typeof rec.type === 'string' && BOOKKEEPING_TYPES.has(rec.type)) {
            console.warn(
              `[agenthydra] bookkeeping record '${rec.type}' carries a timestamp - the receipt schema assumption may have inverted (${path})`,
            )
            continue
          }
          const ms = Date.parse(rec.timestamp)
          if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms
        } catch {
          // A line cut by the tail window or mid-write - skip it, never guess.
        }
      }
      return newest
    }
    const fast = scan(Math.min(size, tailBytes))
    if (fast !== null || size <= tailBytes) return fast
    // The tail window can be one giant trailing tool-result line with the real records
    // buried before it (review-confirmed false 'never delivered') - re-scan the whole file
    // before concluding there is no receipt.
    return scan(size)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function realLastActivity(sessionId: string, _nowMs: number): number | null {
  const path = findTranscriptById(join(homedir(), '.claude'), sessionId)
  if (!path) return null
  return lastTranscriptMessageAt(path)
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
            ? ' (no timestamped transcript activity found by expiry: the transcript may be missing, rolled over, or its tail unreadable)'
            : ''),
        row.id,
      )
    }
  }
}

/**
 * How long a SETTLED row is kept. The ledger is evidence, not an archive: a delivered or
 * expired row answers "did that prompt land?" for as long as anyone would ask, and then it is
 * noise. Nothing pruned it before, so it grew forever on a daemon that runs for months
 * (readiness audit). OPEN rows (pending/deaf) are never pruned at any age - they are work.
 */
const KEEP_SETTLED_MS = 30 * 24 * 3600 * 1000

/** Drop settled rows older than the retention window. Returns how many went. */
export function pruneDeliveries(nowMs = Date.now()): number {
  const cutoff = nowMs - KEEP_SETTLED_MS
  const before = db.query<{ c: number }, []>('select count(*) c from deliveries').get()?.c ?? 0
  db.query(
    "delete from deliveries where state in ('delivered', 'expired', 'superseded') and coalesce(resolved_at, staged_at) < ?",
  ).run(cutoff)
  const after = db.query<{ c: number }, []>('select count(*) c from deliveries').get()?.c ?? 0
  return before - after
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

/**
 * Rows the COMPOSER transport can still carry: pending PLUS deaf.
 *
 * Deaf means "a process started after staging but the transcript never moved". That was a
 * dead end for the send_message transport - messages queue into an engine that never
 * started - and the banked law forbids re-messaging such a chat THAT way. It is NOT a dead
 * end for the composer: driving the app's own composer makes the APP run the turn, engine
 * state irrelevant. Measured repeatedly on 2026-08-30 - every drill target was a freshly
 * imported chat carrying exactly this phantom live entry, and every one answered.
 *
 * This matters in production, not just in drills: surfacing a chat imports it, the import
 * parks a live registry entry for ~15-20 minutes, and the row staged moments earlier is
 * therefore reconciled DEAF within one tick. Delivering only 'pending' would strand the
 * common case.
 */
export function deliverableDeliveries(deps: DeliveryDeps = {}): DeliveryRow[] {
  reconcileDeliveries(deps)
  return db
    .query<DeliveryRow, []>(
      // OLDEST FIRST. The per-pass cap counts every attempt, including free refusals, so
      // newest-first let a steady trickle of new rows starve an older one forever
      // (review-confirmed). Delivery is a queue; the display list stays newest-first.
      "select * from deliveries where state in ('pending', 'deaf') order by staged_at asc",
    )
    .all()
}
