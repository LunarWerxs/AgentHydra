// server/src/proposals.ts - the action gate (owner law 2026-08-26: every action is checked by
// the orchestrator AI before it is made; nothing acts blind).
//
// THE SHAPE. The daemon's detectors used to act: auto-revive dispatched resumes, the archive
// janitor flipped flags, the visibility sweep imported chats. Now they only PROPOSE - one row
// per wanted action, carrying the full evidence - and the reviewer (the one AI in the system)
// decides each proposal on its next wake and EXECUTES the approved ones itself through the
// desktop app's own channels. The daemon never acts on a thread again; this ledger is the
// complete record of what the machinery wanted and what the AI ruled.
//
// LIFECYCLE. proposed -> approved -> executed | failed
//                     -> rejected            (the AI said no; re-proposed only on NEW evidence)
//            proposed -> expired             (nobody decided within the window; re-proposable)
//
// DEDUP. One open row per (kind, session). While a row is proposed/approved, detectors refresh
// its evidence in place. After a rejection, the same (kind, session) is not re-proposed for
// REJECT_QUIET_MS unless the caller shows evidence NEWER than the decision (a transcript that
// moved after the AI ruled is a new situation, the same re-arm rule acks use).

import { db } from './db'
import type { OrchestratorProposal, ProposalKind } from './types'

const EXPIRE_AFTER_MS = 48 * 3600 * 1000
const REJECT_QUIET_MS = 24 * 3600 * 1000
const PRUNE_AFTER_MS = 14 * 24 * 3600 * 1000

interface ProposalRow {
  id: string
  kind: string
  session_id: string
  instance_ref: string | null
  title: string | null
  summary: string
  evidence: string
  status: string
  proposed_at: string
  updated_at: string
  decided_at: string | null
  decided_by: string | null
  decision_note: string | null
  executed_at: string | null
  result: string | null
}

function toProposal(r: ProposalRow): OrchestratorProposal {
  let evidence: Record<string, unknown> = {}
  try {
    evidence = JSON.parse(r.evidence)
  } catch {
    // Unreadable evidence is still a proposal; the summary carries the case.
  }
  return {
    id: r.id,
    kind: r.kind as ProposalKind,
    sessionId: r.session_id,
    instanceRef: r.instance_ref,
    title: r.title,
    summary: r.summary,
    evidence,
    status: r.status as OrchestratorProposal['status'],
    proposedAt: r.proposed_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    executedAt: r.executed_at,
    result: r.result,
  }
}

/**
 * Ask for an action. Returns the open proposal's id (fresh or refreshed), or null when the ask
 * is suppressed by a recent rejection. `evidenceAt` (ISO) is when the newest supporting fact
 * happened - a rejection only stays binding while no evidence postdates it.
 */
export function proposeAction(opts: {
  kind: ProposalKind
  sessionId: string
  instanceRef?: string | null
  title?: string | null
  summary: string
  evidence: Record<string, unknown>
  evidenceAt?: string | null
}): string | null {
  const now = new Date().toISOString()
  const open = db
    .query<ProposalRow, [string, string]>(
      "select * from orchestrator_proposals where kind = ? and session_id = ? and status in ('proposed', 'approved') limit 1",
    )
    .get(opts.kind, opts.sessionId)
  if (open) {
    // Refresh the case in place while nobody has decided; an APPROVED row is the reviewer's
    // to execute and its evidence is frozen at decision time.
    if (open.status === 'proposed') {
      db.query(
        'update orchestrator_proposals set summary = ?, evidence = ?, title = coalesce(?, title), instance_ref = coalesce(?, instance_ref), updated_at = ? where id = ?',
      ).run(
        opts.summary.slice(0, 500),
        JSON.stringify(opts.evidence),
        opts.title ?? null,
        opts.instanceRef ?? null,
        now,
        open.id,
      )
    }
    return open.id
  }
  const lastDecided = db
    .query<ProposalRow, [string, string]>(
      "select * from orchestrator_proposals where kind = ? and session_id = ? and status in ('rejected', 'executed', 'failed') order by decided_at desc limit 1",
    )
    .get(opts.kind, opts.sessionId)
  if (lastDecided?.status === 'rejected' && lastDecided.decided_at) {
    const decidedMs = Date.parse(lastDecided.decided_at)
    const evidenceMs = opts.evidenceAt ? Date.parse(opts.evidenceAt) : Number.NaN
    const fresh = !Number.isNaN(evidenceMs) && evidenceMs > decidedMs
    if (!fresh && Date.now() - decidedMs < REJECT_QUIET_MS) return null
  }
  const id = crypto.randomUUID()
  db.query(
    `insert into orchestrator_proposals
       (id, kind, session_id, instance_ref, title, summary, evidence, status, proposed_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
  ).run(
    id,
    opts.kind,
    opts.sessionId,
    opts.instanceRef ?? null,
    opts.title ?? null,
    opts.summary.slice(0, 500),
    JSON.stringify(opts.evidence),
    now,
    now,
  )
  return id
}

/** The AI's ruling. Only an undecided row can be decided; everything else is a state error the
 *  caller surfaces (a second decision would silently overwrite the first ruling). */
export function decideProposal(
  id: string,
  approved: boolean,
  by: string,
  note?: string | null,
): { ok: boolean; reason?: string; proposal?: OrchestratorProposal } {
  const row = db
    .query<ProposalRow, [string]>('select * from orchestrator_proposals where id = ?')
    .get(id)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.status !== 'proposed') return { ok: false, reason: `already-${row.status}` }
  const now = new Date().toISOString()
  db.query(
    'update orchestrator_proposals set status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ? where id = ?',
  ).run(
    approved ? 'approved' : 'rejected',
    now,
    by.slice(0, 200),
    note?.slice(0, 1000) ?? null,
    now,
    id,
  )
  return { ok: true, proposal: getProposal(id) ?? undefined }
}

/** The execution report. Only an APPROVED row can be executed - the whole law is that the check
 *  comes first, so an execute report on an undecided row is refused loudly. */
export function reportProposalExecuted(
  id: string,
  ok: boolean,
  result?: string | null,
): { ok: boolean; reason?: string; proposal?: OrchestratorProposal } {
  const row = db
    .query<ProposalRow, [string]>('select * from orchestrator_proposals where id = ?')
    .get(id)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.status !== 'approved')
    return { ok: false, reason: `not-approved (status: ${row.status}) - decide first` }
  const now = new Date().toISOString()
  db.query(
    'update orchestrator_proposals set status = ?, executed_at = ?, result = ?, updated_at = ? where id = ?',
  ).run(ok ? 'executed' : 'failed', now, result?.slice(0, 1000) ?? null, now, id)
  return { ok: true, proposal: getProposal(id) ?? undefined }
}

export function getProposal(id: string): OrchestratorProposal | null {
  const row = db
    .query<ProposalRow, [string]>('select * from orchestrator_proposals where id = ?')
    .get(id)
  return row ? toProposal(row) : null
}

/** Housekeeping, called from the watcher pass: expire undecided rows past the window (they
 *  re-propose with fresh evidence if the condition persists) and prune ancient terminal rows. */
export function maintainProposals(nowMs: number): void {
  const expireBefore = new Date(nowMs - EXPIRE_AFTER_MS).toISOString()
  db.query(
    "update orchestrator_proposals set status = 'expired', updated_at = ? where status = 'proposed' and proposed_at < ?",
  ).run(new Date(nowMs).toISOString(), expireBefore)
  const pruneBefore = new Date(nowMs - PRUNE_AFTER_MS).toISOString()
  db.query(
    "delete from orchestrator_proposals where status in ('rejected', 'executed', 'failed', 'expired') and updated_at < ?",
  ).run(pruneBefore)
}

/**
 * Retire open proposals whose target is no longer a thing to act on, so the reviewer is never
 * handed retired work. An undecided proposal stands for 48 hours and an approved one until it
 * is executed, which is plenty of time for the chat underneath to be archived: on 2026-08-27
 * four approved revives pointed at chats that had since been retired, and the reviewer burned
 * a full relay round discovering it. The detectors already skip archived chats when proposing;
 * this is the same check applied to rows that were already on the books.
 *
 * Marked `expired` rather than rejected: nobody ruled against these, the world moved. If the
 * chat is ever unarchived and still needs help, the detectors propose it again from scratch.
 */
export function retireProposalsForSessions(
  sessionIds: Iterable<string>,
  nowMs: number,
  note: string,
): number {
  const now = new Date(nowMs).toISOString()
  const stmt = db.query(
    `update orchestrator_proposals
        set status = 'expired', updated_at = ?, decision_note = ?
      where session_id = ? and status in ('proposed', 'approved')`,
  )
  let n = 0
  for (const id of sessionIds) {
    const before = db
      .query<{ c: number }, [string]>(
        "select count(*) as c from orchestrator_proposals where session_id = ? and status in ('proposed', 'approved')",
      )
      .get(id)?.c
    if (!before) continue
    stmt.run(now, note, id)
    n += before
  }
  return n
}

/** The feed's view: everything open (the reviewer's to-decide/to-execute list) plus the last
 *  day's decided rows so the owner can audit what the AI ruled. Newest first, open first. */
export function listProposalsForView(nowMs: number): OrchestratorProposal[] {
  const dayAgo = new Date(nowMs - 24 * 3600 * 1000).toISOString()
  return db
    .query<ProposalRow, [string]>(
      `select * from orchestrator_proposals
       where status in ('proposed', 'approved') or updated_at > ?
       order by case when status in ('proposed', 'approved') then 0 else 1 end, updated_at desc
       limit 100`,
    )
    .all(dayAgo)
    .map(toProposal)
}

/** Open proposals for one session, any kind - the guards use this ("is a revive already in
 *  flight for this lineage"). */
export function openProposalsForSession(sessionId: string): OrchestratorProposal[] {
  return db
    .query<ProposalRow, [string]>(
      "select * from orchestrator_proposals where session_id = ? and status in ('proposed', 'approved')",
    )
    .all(sessionId)
    .map(toProposal)
}
