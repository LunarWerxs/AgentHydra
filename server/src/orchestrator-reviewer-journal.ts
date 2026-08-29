// server/src/orchestrator-reviewer-journal.ts - THE REVIEWER IS A ROLE, NOT A CHAT.
//
// Measured twice on 2026-08-28: the reviewer loop died with its host chat - once to a phantom
// archive, once to a process kill - and each time the whole fleet halted until a human noticed
// and typed /orchestrate somewhere. Nothing the reviewer "knew" died with it: the rulings live
// in the proposals ledger, mid-delivery state (with the exact verbatim steps) lives in the wl:
// kv rows, and the standing context is settings. Reviewer mortality was never a data problem,
// it was a briefing problem - no way to hand a FRESH chat the context the dead one carried.
//
// Pattern sources, judged in docs/todo/orchestrator-survey-2026-08-28.md (tier 1): OpenHands
// replays an EventLog into any fresh runtime; Anthropic's multi-agent work checkpoints memory
// outside the context window; AG2 rehydrates an agent by name into a new process. The common
// shape: durable state lives OUTSIDE the mortal worker, and revival means seeding a fresh
// worker from it - never resurrecting the dead one.
//
// So the JOURNAL is a compact read-only VIEW over state the server already maintains, and the
// SEED composes it into a ready-to-paste opening prompt that briefs ANY fresh chat as the
// successor reviewer. Three laws bound it:
//   - the journal RECORDS, never decides: the action gate (resolve/verify) is untouched, and
//     nothing here approves, rejects, acks, or spends a cooldown;
//   - NO RELAYS: the seed is text; it is delivered by whoever boots the new chat (the owner, or
//     a session that can seed one), never couriered through working chats;
//   - BYPASS VERIFIED BEFORE BOOT: the hosting chat's bypassPermissions stamp is the booter's
//     to confirm, the same as every other boot in this system - the loop shells out every wake
//     and an approval prompt nobody can click is a silent deadlock, not a safeguard.

import { db } from './db'
import {
  getOrchestratorSettings,
  listPendingRenames,
  listSessionHolds,
  reviewerHealth,
} from './orchestrator'
import { type InFlightItem, listInFlightItems } from './orchestrator-worklist'

/** One decided ledger row, compact: what was ruled, by whom, why, and how it ended. */
export interface JournalDecision {
  id: string
  kind: string
  sessionId: string
  title: string | null
  status: string
  decidedAt: string | null
  decidedBy: string | null
  /** The reviewer's one-line WHY - the only part of the system only a reviewer produces. */
  note: string | null
  result: string | null
}

export interface ReviewerJournal {
  generatedAt: string
  standing: {
    workMode: string
    reviewer: ReturnType<typeof reviewerHealth>
    /** Items currently owed a reviewer action: open proposals plus pending renames - the same
     *  ruler reviewerHealth is judged against, resolved once so they cannot disagree. */
    waiting: number
    pendingRenames: number
    heldThreads: number
  }
  /** Mid-delivery items with their saved verbatim steps - the successor calls verify on each of
   *  these FIRST; re-approving one re-issues its steps rather than re-executing anything. */
  inFlight: InFlightItem[]
  /** Last N rulings, newest first - settled context so a successor does not re-litigate. */
  decisions: JournalDecision[]
  note: string
}

interface DecisionRow {
  id: string
  kind: string
  session_id: string
  title: string | null
  status: string
  decided_at: string | null
  decided_by: string | null
  decision_note: string | null
  result: string | null
}

/**
 * The compact successor briefing, computed. Almost entirely a VIEW: the proposals ledger and the
 * wl: kv state already record everything a reviewer's death loses, so this only gathers and
 * shapes. Deliberately cheap (three small queries, no live registry, no transcript reads) - it
 * is fetched precisely when the fleet is decapitated and speed of revival is the point.
 */
export function buildReviewerJournal(decisionLimit = 20): ReviewerJournal {
  const settings = getOrchestratorSettings()
  const renames = listPendingRenames()
  const holds = listSessionHolds()
  const openProposals =
    db
      .query<{ c: number }, []>(
        "select count(*) as c from orchestrator_proposals where status in ('proposed', 'approved')",
      )
      .get()?.c ?? 0
  const waiting = openProposals + renames.length
  const decisions = db
    .query<DecisionRow, [number]>(
      `select id, kind, session_id, title, status, decided_at, decided_by, decision_note, result
         from orchestrator_proposals
        where decided_at is not null
        order by decided_at desc
        limit ?`,
    )
    .all(decisionLimit)
    .map(
      (r): JournalDecision => ({
        id: r.id,
        kind: r.kind,
        sessionId: r.session_id,
        title: r.title,
        status: r.status,
        decidedAt: r.decided_at,
        decidedBy: r.decided_by,
        note: r.decision_note,
        result: r.result,
      }),
    )
  return {
    generatedAt: new Date().toISOString(),
    standing: {
      workMode: settings.workMode,
      reviewer: reviewerHealth(Date.now(), waiting),
      waiting,
      pendingRenames: renames.length,
      heldThreads: holds.length,
    },
    inFlight: listInFlightItems(),
    decisions,
    note:
      'Read-only view. The journal records; it never decides - resolve/verify (the action gate) ' +
      'remain the only things that act.',
  }
}

/**
 * The ready-to-paste opening prompt that makes any fresh chat the SUCCESSOR reviewer. Reviving
 * the reviewer means booting a new chat with this text - never resurrecting a specific dead
 * chat, whose transcript is gone from every actuator's reach anyway. The prompt hands over only
 * CONTEXT (in-flight ids to verify first, settled rulings, standing mode) and then defers to
 * /orchestrate, which is the loop and the contract; it pre-decides nothing.
 */
export function composeReviewerSeed(j: ReviewerJournal = buildReviewerJournal()): string {
  const L: string[] = []
  L.push('[orchestrator] REVIEWER SEED - you are the SUCCESSOR orchestrator reviewer.')
  L.push('')
  L.push('The reviewer is a ROLE, not a chat. The previous reviewer chat is gone or presumed')
  L.push('dead; you are its replacement, booted fresh. Never resurrect, resume or message a dead')
  L.push('reviewer chat - its standing context is below, and the server holds the full ledger.')
  const quiet = j.standing.reviewer.quietMins
  if (quiet !== null && quiet < 30) {
    L.push('')
    L.push(`WARNING: a reviewer acted ${quiet}m ago. Boot a successor only if you KNOW that chat`)
    L.push('is dead - two live reviewers ruling one worklist collide on the ledger.')
  }
  L.push('')
  L.push('STANDING CONTEXT')
  L.push(`- workMode: ${j.standing.workMode}`)
  L.push(
    `- last reviewer action: ${j.standing.reviewer.lastSeenAt ?? 'never'}${
      quiet !== null ? ` (${quiet}m ago)` : ''
    }`,
  )
  L.push(
    `- waiting for a ruling: ${j.standing.waiting} - pending renames: ${j.standing.pendingRenames} - held threads: ${j.standing.heldThreads}`,
  )
  L.push('')
  if (j.inFlight.length === 0) {
    L.push('IN-FLIGHT (0) - nothing was mid-delivery when this journal was cut.')
  } else {
    L.push(`IN-FLIGHT (${j.inFlight.length}) - items the predecessor resolved whose outcome is`)
    L.push('not yet confirmed. On your FIRST wake, POST /api/orchestrator/items/<id>/verify for')
    L.push("each of these before ruling on anything new; 'pending' means check again next wake,")
    L.push('and re-approving an in-flight item re-issues its saved steps verbatim:')
    for (const f of j.inFlight)
      L.push(
        `- ${f.itemId} - phase ${f.phase} - target ${f.targetSessionId || '?'} - since ${f.at || '?'}`,
      )
  }
  L.push('')
  if (j.decisions.length === 0) {
    L.push('RECENT RULINGS (0) - no decided items on the ledger yet.')
  } else {
    L.push(`RECENT RULINGS (${j.decisions.length}, newest first) - settled context so you do not`)
    L.push('re-litigate; the ledger already holds them:')
    for (const d of j.decisions) {
      const what = d.title ? `"${d.title}"` : d.sessionId.slice(0, 8)
      const why = d.note ?? d.result ?? ''
      L.push(`- [${d.status}] ${d.kind} ${what}${why ? ` - ${why}` : ''} (${d.decidedAt ?? '?'})`)
    }
  }
  L.push('')
  L.push('Now run /orchestrate and follow it exactly - it is the loop and the contract; this')
  L.push('seed only hands you the context the previous reviewer carried. Judgment is yours.')
  return L.join('\n')
}
