// server/src/orchestrator-breaker.ts — the CIRCUIT BREAKER: loop detection over the proposal
// ledger, revive deliveries, and reviewer rulings.
//
// WHY THIS EXISTS (measured 2026-08-28, docs/todo/orchestrator-survey-2026-08-28.md tier 1):
// the same finished chat was re-archived FOUR times in one evening (each archive executed and
// verified honestly; the running app then re-saved its sidebar entry un-archived, the janitor
// saw a done-marked visible chat again, and the cycle restarted), and the same idle item was
// re-proposed and re-rejected THREE times in ~40 minutes. Every individual pass was correct;
// nothing anywhere COUNTED, so the system happily ran the same correct futile cycle forever.
// Pattern sources: systemd's StartLimitIntervalSec/StartLimitBurst restart-storm brake,
// claude_code_agent_farm's exponential backoff, CrewAI's max_iterations, Cloudzy's
// hash-the-repeated-action sliding window.
//
// THE LAW THIS MODULE LIVES UNDER: the breaker suppresses PROPOSING and paces DELIVERY; it
// never overrides a ruling. An open proposal still gets decided, an approved one still gets
// executed, a reviewer's reject still lands. What stops is the machinery ASKING again — and
// every stop is loud: one owner-facing attention item per tripped loop (kind 'loop_break'),
// plus a suppression line in the worklist and the dry run. A silent brake would be the false
// quiet this repo documents as its worst failure mode.
//
// All state lives in orchestrator_kv (prefix 'breaker:'), so counts survive daemon restarts —
// an in-memory counter would reset on exactly the restart that a storm tends to cause.

import { db } from './db'
import type { AttentionItem } from './types'

// --- tuning --------------------------------------------------------------------------------------

/** New proposal rows allowed per (kind, sessionId) inside the window; the next one trips. */
export const PROPOSAL_ATTEMPT_CAP = 4
/** The sliding window for both the attempt counters and the resolution repeat-hash. */
export const ATTEMPT_WINDOW_MS = 6 * 3600 * 1000
/** Identical (itemId, decision) rulings inside the window before the item is withheld. */
export const RESOLUTION_REPEAT_CAP = 3
/** Revive-delivery backoff: base doubles per unverified delivery, capped. agent_farm uses
 *  10s→5min for process restarts; a chat revive is a whole seeded turn, so ours runs
 *  2min→30min. Reset the moment a delivery VERIFIES (transcript moved). */
export const REVIVE_BACKOFF_BASE_MS = 2 * 60_000
export const REVIVE_BACKOFF_MAX_MS = 30 * 60_000

/** Stored attempt timestamps are capped; `total` keeps the honest lifetime count. */
const MAX_STORED_ATTEMPTS = 20

// --- kv plumbing ---------------------------------------------------------------------------------

function kvGet(key: string): string | null {
  return (
    db
      .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
      .get(key)?.value ?? null
  )
}
function kvSet(key: string, value: string, nowMs: number): void {
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date(nowMs).toISOString())
}
function kvDelete(key: string): void {
  db.query('delete from orchestrator_kv where key = ?').run(key)
}

interface AttemptLog {
  /** ISO timestamps, oldest first, pruned to the window, capped at MAX_STORED_ATTEMPTS. */
  at: string[]
  /** Lifetime attempts, never pruned. */
  total: number
}

export interface TripRecord {
  scope: 'proposal' | 'resolution'
  /** proposal scope */
  kind?: string
  sessionId?: string
  title?: string | null
  /** resolution scope */
  itemId?: string
  decision?: string
  /** Attempts inside the window as of lastAt. */
  count: number
  total: number
  /** How many asks the breaker has refused since tripping. */
  suppressed: number
  firstAt: string
  lastAt: string
  trippedAt: string
}

function attemptKey(kind: string, sessionId: string): string {
  return `breaker:att:${kind}:${sessionId}`
}
function proposalTripKey(kind: string, sessionId: string): string {
  return `breaker:trip:p:${kind}:${sessionId}`
}
function resolutionTripKey(itemId: string): string {
  return `breaker:trip:r:${itemId}`
}
function reviveKey(sessionId: string): string {
  return `breaker:revive:${sessionId}`
}

function readJson<T>(key: string): T | null {
  const raw = kvGet(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function pruneToWindow(log: AttemptLog, nowMs: number): AttemptLog {
  const floor = nowMs - ATTEMPT_WINDOW_MS
  return { at: log.at.filter((iso) => Date.parse(iso) > floor), total: log.total }
}

function appendAttempt(log: AttemptLog, nowMs: number): AttemptLog {
  const at = [...log.at, new Date(nowMs).toISOString()]
  return { at: at.slice(-MAX_STORED_ATTEMPTS), total: log.total + 1 }
}

// --- (1) proposal attempt counters ---------------------------------------------------------------

/**
 * The gate proposeAction calls right before INSERTING a new row (never on an open-row refresh:
 * refreshing the case on a row the reviewer already owes a ruling on is not a new ask). Counts
 * the attempt; when the pair has already used its PROPOSAL_ATTEMPT_CAP inside the window, the
 * insert is refused, the trip record is written/updated, and the loop becomes ONE owner-facing
 * attention item instead of proposal number five.
 *
 * Suppressed attempts keep counting into the window on purpose: while the underlying condition
 * persists (the janitor re-wanting the same archive every tick), the window slides and the pair
 * stays suppressed with a single live escalation. The moment the condition clears — typically
 * that app restarting, which finally honors the archive flag — attempts stop, the window drains,
 * and the pair is proposable again.
 */
export function gateProposalAttempt(
  opts: { kind: string; sessionId: string; title?: string | null },
  nowMs: number = Date.now(),
): { allowed: boolean; count: number } {
  const aKey = attemptKey(opts.kind, opts.sessionId)
  const log = pruneToWindow(readJson<AttemptLog>(aKey) ?? { at: [], total: 0 }, nowMs)
  if (log.at.length >= PROPOSAL_ATTEMPT_CAP) {
    const next = appendAttempt(log, nowMs)
    kvSet(aKey, JSON.stringify(next), nowMs)
    const tKey = proposalTripKey(opts.kind, opts.sessionId)
    const prior = readJson<TripRecord>(tKey)
    const nowIso = new Date(nowMs).toISOString()
    const trip: TripRecord = {
      scope: 'proposal',
      kind: opts.kind,
      sessionId: opts.sessionId,
      title: opts.title ?? prior?.title ?? null,
      count: next.at.length,
      total: next.total,
      suppressed: (prior?.suppressed ?? 0) + 1,
      firstAt: prior?.firstAt ?? next.at[0] ?? nowIso,
      lastAt: nowIso,
      trippedAt: prior?.trippedAt ?? nowIso,
    }
    kvSet(tKey, JSON.stringify(trip), nowMs)
    return { allowed: false, count: next.at.length }
  }
  const next = appendAttempt(log, nowMs)
  kvSet(aKey, JSON.stringify(next), nowMs)
  return { allowed: true, count: next.at.length }
}

// --- (2) revive-delivery backoff -----------------------------------------------------------------

interface ReviveBackoff {
  /** Unverified deliveries so far. */
  attempts: number
  lastAt: string
}

/** Delay owed AFTER the nth unverified delivery (n = attempts recorded so far). */
function backoffDelayMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(REVIVE_BACKOFF_BASE_MS * 2 ** (attempts - 1), REVIVE_BACKOFF_MAX_MS)
}

/** Record one revive delivery into this session (a step handed out, or a terminal launched). */
export function noteReviveDelivery(sessionId: string, nowMs: number = Date.now()): void {
  const prior = readJson<ReviveBackoff>(reviveKey(sessionId))
  const next: ReviveBackoff = {
    attempts: (prior?.attempts ?? 0) + 1,
    lastAt: new Date(nowMs).toISOString(),
  }
  kvSet(reviveKey(sessionId), JSON.stringify(next), nowMs)
}

/** A delivery VERIFIED (the target's transcript moved): the lineage is genuinely running again,
 *  so the next revive — if it ever dies again — starts from a clean slate. */
export function clearReviveBackoff(sessionId: string): void {
  kvDelete(reviveKey(sessionId))
}

/** Null when a revive may deliver now; otherwise where the backoff stands. */
export function reviveBackoffInfo(
  sessionId: string,
  nowMs: number = Date.now(),
): { attempts: number; nextAllowedAt: string; waitMs: number } | null {
  const b = readJson<ReviveBackoff>(reviveKey(sessionId))
  if (!b || b.attempts <= 0) return null
  const last = Date.parse(b.lastAt)
  if (Number.isNaN(last)) return null
  const nextAt = last + backoffDelayMs(b.attempts)
  if (nowMs >= nextAt) return null
  return {
    attempts: b.attempts,
    nextAllowedAt: new Date(nextAt).toISOString(),
    waitMs: nextAt - nowMs,
  }
}

/** The refusal line for a revive delivery still inside its backoff, or null to proceed. */
export function reviveBackoffRefusal(sessionId: string, nowMs: number = Date.now()): string | null {
  const info = reviveBackoffInfo(sessionId, nowMs)
  if (!info) return null
  return (
    `revive backoff: delivery ${info.attempts} into this session has not verified yet — ` +
    `next attempt allowed at ${info.nextAllowedAt} (${Math.ceil(info.waitMs / 60_000)}m). ` +
    'The approval stands; delivery is deferred, not refused.'
  )
}

// --- (3) resolution repeat-hash ------------------------------------------------------------------

/** FNV-1a 32-bit — the "hash the repeated action" key over (itemId, decision). */
export function actionHash(itemId: string, decision: string): string {
  const s = `${itemId}\n${decision}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Record one reviewer ruling on one item. When the SAME item draws the SAME decision
 * RESOLUTION_REPEAT_CAP times inside the window, the loop is folded into the owner escalation:
 * a trip record keyed by the item id, which buildWorklist/buildDryRun read to withhold the item
 * instead of offering it a fourth time. The ruling that trips is NOT undone — the breaker never
 * overrides a ruling, it stops the re-offering.
 */
export function noteResolution(
  itemId: string,
  decision: 'approve' | 'reject',
  nowMs: number = Date.now(),
): { count: number; tripped: boolean } {
  const key = `breaker:res:${actionHash(itemId, decision)}`
  const log = appendAttempt(
    pruneToWindow(readJson<AttemptLog>(key) ?? { at: [], total: 0 }, nowMs),
    nowMs,
  )
  kvSet(key, JSON.stringify(log), nowMs)
  const tripped = log.at.length >= RESOLUTION_REPEAT_CAP
  if (tripped) {
    const tKey = resolutionTripKey(itemId)
    const prior = readJson<TripRecord>(tKey)
    const nowIso = new Date(nowMs).toISOString()
    const trip: TripRecord = {
      scope: 'resolution',
      itemId,
      decision,
      count: log.at.length,
      total: log.total,
      suppressed: prior?.suppressed ?? 0,
      firstAt: prior?.firstAt ?? log.at[0] ?? nowIso,
      lastAt: nowIso,
      trippedAt: prior?.trippedAt ?? nowIso,
    }
    kvSet(tKey, JSON.stringify(trip), nowMs)
  }
  return { count: log.at.length, tripped }
}

/** The ACTIVE resolution trip for an item, or null. `countAsk: true` (the live worklist) counts
 *  the read as one more withheld offer and prunes an expired row; the default is a PURE read for
 *  the dry run, whose one promise is zero writes. */
export function resolutionTrip(
  itemId: string,
  nowMs: number = Date.now(),
  countAsk = false,
): TripRecord | null {
  const key = resolutionTripKey(itemId)
  const trip = readJson<TripRecord>(key)
  if (!trip) return null
  const last = Date.parse(trip.lastAt)
  if (Number.isNaN(last) || nowMs - last >= ATTEMPT_WINDOW_MS) {
    if (countAsk) kvDelete(key)
    return null
  }
  if (countAsk) {
    const bumped = { ...trip, suppressed: trip.suppressed + 1 }
    kvSet(key, JSON.stringify(bumped), nowMs)
    return bumped
  }
  return trip
}

// --- the loud half: escalation + suppression surfaces --------------------------------------------

/** Every trip still inside its window. Expired/unreadable rows are deleted only when `prune`
 *  is set — the tick passes true; read-only surfaces (worklist listing, dry run) default to a
 *  pure read. */
export function activeTrips(nowMs: number = Date.now(), prune = false): TripRecord[] {
  const rows = db
    .query<{ key: string; value: string }, []>(
      "select key, value from orchestrator_kv where key like 'breaker:trip:%'",
    )
    .all()
  const out: TripRecord[] = []
  for (const r of rows) {
    let trip: TripRecord | null = null
    try {
      trip = JSON.parse(r.value) as TripRecord
    } catch {
      if (prune) kvDelete(r.key)
      continue
    }
    const last = Date.parse(trip.lastAt)
    if (Number.isNaN(last) || nowMs - last >= ATTEMPT_WINDOW_MS) {
      if (prune) kvDelete(r.key)
      continue
    }
    out.push(trip)
  }
  out.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  return out
}

function windowHours(): number {
  return Math.round(ATTEMPT_WINDOW_MS / 3600_000)
}

/** One human line per trip: what looped, how often, what the breaker is doing about it. */
export function tripSummary(t: TripRecord): string {
  if (t.scope === 'proposal') {
    const who = t.title?.trim() || t.sessionId || 'unknown target'
    const resurrect =
      t.kind === 'archive'
        ? ' — each archive executes and the app keeps resurrecting the entry; it sticks only after that app restarts'
        : ''
    return (
      `Loop breaker: '${t.kind}' for ${who} proposed ${t.total}× in ${windowHours()}h ` +
      `(${t.suppressed} ask(s) suppressed since tripping)${resurrect}. ` +
      'No further proposals for this pair until the window clears; open rows still get decided.'
    )
  }
  return (
    `Loop breaker: item ${t.itemId} drew the same '${t.decision}' ruling ${t.count}× in ` +
    `${windowHours()}h — withheld from the worklist and folded into this escalation instead ` +
    'of being offered again.'
  )
}

function tripKeyOf(t: TripRecord): string {
  return t.scope === 'proposal' ? `loop:p:${t.kind}:${t.sessionId}` : `loop:r:${t.itemId}`
}

/**
 * The owner-facing escalation: ONE attention item per live loop, emitted every tick while the
 * trip is active (stable key, so continuity counts passes instead of duplicating). These carry
 * no sessionId on purpose — they are for the OWNER's feed; the reviewer's builders return null
 * for the kind, so a loop item can never become a work item that re-enters the loop.
 */
export function tripAttentionItems(nowMs: number = Date.now()): AttentionItem[] {
  return activeTrips(nowMs, true).map((t) => ({
    key: tripKeyOf(t),
    kind: 'loop_break' as const,
    summary: tripSummary(t),
    detail: { ...t },
    firstSeenAt: t.trippedAt,
    seenCount: 1,
  }))
}

/** The suppression lines the worklist and the dry run print — a suppressed loop must be
 *  VISIBLE in both, never silent (the false-quiet rule). Read-only. */
export function breakerSuppressionLines(nowMs: number = Date.now()): string[] {
  return activeTrips(nowMs).map((t) => `${tripKeyOf(t)} -> ${tripSummary(t)}`)
}
