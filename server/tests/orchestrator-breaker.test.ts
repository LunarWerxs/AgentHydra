// server/tests/orchestrator-breaker.test.ts — the circuit breaker's contract, pinned to the
// loops actually measured on 2026-08-28 (docs/todo/orchestrator-survey-2026-08-28.md tier 1):
// the same finished chat re-archived FOUR times in one evening (every archive executed and
// verified; the running app re-saved the entry un-archived and the janitor asked again), and
// the same idle item re-proposed and re-rejected THREE times in ~40 minutes. Each test pins one
// half of the law: the loop STOPS (no fifth ask, no fourth offer) and the stop is LOUD (one
// owner escalation, a suppression line) — false quiet is the failure mode this repo documents.

import { describe, expect, test } from 'bun:test'
import {
  ATTEMPT_WINDOW_MS,
  actionHash,
  activeTrips,
  breakerSuppressionLines,
  clearReviveBackoff,
  gateProposalAttempt,
  noteResolution,
  noteReviveDelivery,
  PROPOSAL_ATTEMPT_CAP,
  RESOLUTION_REPEAT_CAP,
  REVIVE_BACKOFF_BASE_MS,
  REVIVE_BACKOFF_MAX_MS,
  resolutionTrip,
  reviveBackoffInfo,
  reviveBackoffRefusal,
  tripAttentionItems,
} from '../src/orchestrator-breaker'
import { classifyAutoAck } from '../src/orchestrator-worklist'
import {
  decideProposal,
  getProposal,
  proposeAction,
  reportProposalExecuted,
} from '../src/proposals'
import type { AttentionItem } from '../src/types'

const sid = () => crypto.randomUUID()
const T0 = Date.parse('2026-08-28T20:00:00.000Z')
const MIN = 60_000

// --- (1) proposal attempt counters: the re-archive resurrection loop -----------------------------

describe('proposal attempt counters', () => {
  test('the measured shape: four archive cycles run, the fifth ask becomes ONE owner escalation', () => {
    // "[Odin] Fleet complexity reduction", 2026-08-28: archive -> executed -> app re-saves the
    // entry un-archived -> janitor proposes again, four times, no counter anywhere. Each cycle
    // here is complete (decided + executed) so the ledger's one-open-row dedup never blocks —
    // exactly the field condition.
    const session = sid()
    for (let i = 0; i < PROPOSAL_ATTEMPT_CAP; i++) {
      const id = proposeAction({
        kind: 'archive',
        sessionId: session,
        title: '[Odin] Fleet complexity reduction',
        summary: 'done-marked chat still visible in a sidebar',
        evidence: {},
      })
      expect(id).not.toBeNull()
      expect(decideProposal(id as string, true, 'reviewer').ok).toBe(true)
      expect(reportProposalExecuted(id as string, true, 'archived').ok).toBe(true)
    }
    const fifth = proposeAction({
      kind: 'archive',
      sessionId: session,
      title: '[Odin] Fleet complexity reduction',
      summary: 'done-marked chat still visible in a sidebar',
      evidence: {},
    })
    expect(fifth).toBeNull()

    const trips = activeTrips().filter((t) => t.sessionId === session)
    expect(trips).toHaveLength(1)
    expect(trips[0].scope).toBe('proposal')
    expect(trips[0].kind).toBe('archive')
    expect(trips[0].suppressed).toBe(1)

    // ONE attention item, owner-facing, stating the loop and its history — and because it is an
    // archive loop, the "app keeps resurrecting the entry / sticks after that app restarts" story.
    const items = tripAttentionItems().filter(
      (i) => (i.detail as { sessionId?: string })?.sessionId === session,
    )
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('loop_break')
    expect(items[0].summary).toContain("'archive' for [Odin] Fleet complexity reduction")
    expect(items[0].summary).toContain('resurrecting the entry')
    expect(items[0].summary).toContain('after that app restarts')

    // A sixth ask is still refused, still ONE item, and the suppression tally grows — the
    // escalation absorbs the ongoing loop instead of multiplying.
    expect(
      proposeAction({ kind: 'archive', sessionId: session, summary: 'again', evidence: {} }),
    ).toBeNull()
    const again = activeTrips().filter((t) => t.sessionId === session)
    expect(again).toHaveLength(1)
    expect(again[0].suppressed).toBe(2)
  })

  test('the trip is loud in the suppression lines, never silent', () => {
    const session = sid()
    for (let i = 0; i <= PROPOSAL_ATTEMPT_CAP; i++)
      gateProposalAttempt({ kind: 'revive', sessionId: session, title: 'Leaky bucket' }, T0 + i)
    const lines = breakerSuppressionLines(T0 + 10)
    expect(lines.some((l) => l.includes(`loop:p:revive:${session}`))).toBe(true)
    expect(lines.some((l) => l.includes('Leaky bucket'))).toBe(true)
  })

  test('kinds count separately - four archives never suppress a revive for the same lineage', () => {
    const session = sid()
    for (let i = 0; i <= PROPOSAL_ATTEMPT_CAP; i++)
      gateProposalAttempt({ kind: 'archive', sessionId: session }, T0 + i)
    expect(gateProposalAttempt({ kind: 'revive', sessionId: session }, T0 + 10).allowed).toBe(true)
  })

  test('the window drains: quiet for the full window re-arms the pair', () => {
    const session = sid()
    for (let i = 0; i < PROPOSAL_ATTEMPT_CAP; i++)
      expect(
        gateProposalAttempt({ kind: 'archive', sessionId: session }, T0 + i * MIN).allowed,
      ).toBe(true)
    // Inside the window: refused — and the refusal itself is an ask, so a PERSISTENT loop
    // (the janitor re-wanting the archive every tick) keeps itself suppressed …
    const refusedAt = T0 + 5 * MIN
    expect(gateProposalAttempt({ kind: 'archive', sessionId: session }, refusedAt).allowed).toBe(
      false,
    )
    const laterAsk = T0 + 3 * 3600_000
    expect(gateProposalAttempt({ kind: 'archive', sessionId: session }, laterAsk).allowed).toBe(
      false,
    )
    // … while a full quiet window after the LAST ask (the condition cleared — e.g. that app
    // finally restarted and the archive stuck) re-arms the pair.
    expect(
      gateProposalAttempt(
        { kind: 'archive', sessionId: session },
        laterAsk + ATTEMPT_WINDOW_MS + MIN,
      ).allowed,
    ).toBe(true)
  })

  test('the breaker suppresses PROPOSING, never a ruling: an open row still decides and executes', () => {
    const session = sid()
    const id = proposeAction({ kind: 'revive', sessionId: session, summary: 'dead', evidence: {} })
    expect(id).not.toBeNull()
    // Trip the pair while the row sits open (the counters do not care how the asks arrived).
    for (let i = 0; i <= PROPOSAL_ATTEMPT_CAP; i++)
      gateProposalAttempt({ kind: 'revive', sessionId: session })
    // proposeAction still surfaces the OPEN row (refresh path runs before the gate) …
    expect(
      proposeAction({ kind: 'revive', sessionId: session, summary: 'refreshed', evidence: {} }),
    ).toBe(id)
    expect(getProposal(id as string)?.summary).toBe('refreshed')
    // … and the reviewer's ruling on it lands untouched.
    expect(decideProposal(id as string, true, 'reviewer').ok).toBe(true)
    expect(reportProposalExecuted(id as string, true, 'done').ok).toBe(true)
  })
})

// --- (2) revive-delivery backoff -----------------------------------------------------------------

describe('revive delivery backoff', () => {
  test('the ladder doubles per unverified delivery and caps', () => {
    const session = sid()
    expect(reviveBackoffRefusal(session, T0)).toBeNull()
    noteReviveDelivery(session, T0)
    // Attempt 1: blocked for the base, free after it.
    expect(reviveBackoffRefusal(session, T0 + REVIVE_BACKOFF_BASE_MS - 1)).toContain(
      'revive backoff',
    )
    expect(reviveBackoffRefusal(session, T0 + REVIVE_BACKOFF_BASE_MS + 1)).toBeNull()
    // Attempt 2: doubled.
    const t2 = T0 + REVIVE_BACKOFF_BASE_MS + MIN
    noteReviveDelivery(session, t2)
    expect(reviveBackoffRefusal(session, t2 + 2 * REVIVE_BACKOFF_BASE_MS - 1)).not.toBeNull()
    expect(reviveBackoffRefusal(session, t2 + 2 * REVIVE_BACKOFF_BASE_MS + 1)).toBeNull()
    // Attempts pile to the cap, never past it.
    let t = t2
    for (let i = 0; i < 8; i++) {
      t += MIN
      noteReviveDelivery(session, t)
    }
    const info = reviveBackoffInfo(session, t + 1)
    expect(info).not.toBeNull()
    expect(Date.parse(info?.nextAllowedAt ?? '') - t).toBe(REVIVE_BACKOFF_MAX_MS)
  })

  test('a VERIFIED delivery resets the ladder to the bottom', () => {
    const session = sid()
    for (let i = 0; i < 4; i++) noteReviveDelivery(session, T0 + i * MIN)
    expect(reviveBackoffRefusal(session, T0 + 4 * MIN)).not.toBeNull()
    clearReviveBackoff(session)
    expect(reviveBackoffRefusal(session, T0 + 4 * MIN)).toBeNull()
    // The next death starts at the base delay again, not at 16 minutes.
    noteReviveDelivery(session, T0 + 5 * MIN)
    expect(reviveBackoffRefusal(session, T0 + 5 * MIN + REVIVE_BACKOFF_BASE_MS + 1)).toBeNull()
  })

  test('the refusal names the clock and says the approval stands', () => {
    const session = sid()
    noteReviveDelivery(session, T0)
    const line = reviveBackoffRefusal(session, T0 + 1)
    expect(line).toContain('next attempt allowed at')
    expect(line).toContain('approval stands')
  })
})

// --- (3) resolution repeat-hash ------------------------------------------------------------------

describe('resolution repeat-hash', () => {
  test('the measured shape: three identical rejections in 40 minutes fold into the escalation', () => {
    // "AgentHydra project burndown", 2026-08-28: an idle item re-proposed and re-rejected three
    // times in ~40 minutes — a live loop with an alive reviewer re-litigating one item.
    const itemId = `att:idle:${sid()}`
    expect(noteResolution(itemId, 'reject', T0).tripped).toBe(false)
    expect(noteResolution(itemId, 'reject', T0 + 15 * MIN).tripped).toBe(false)
    const third = noteResolution(itemId, 'reject', T0 + 38 * MIN)
    expect(third.tripped).toBe(true)
    expect(third.count).toBe(RESOLUTION_REPEAT_CAP)

    const trip = resolutionTrip(itemId, T0 + 39 * MIN)
    expect(trip?.scope).toBe('resolution')
    expect(trip?.decision).toBe('reject')
    // Folded into the SAME owner surface as the proposal loops: one loop_break item.
    const items = tripAttentionItems(T0 + 39 * MIN).filter(
      (i) => (i.detail as { itemId?: string })?.itemId === itemId,
    )
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('loop_break')
    expect(items[0].summary).toContain('withheld from the worklist')
  })

  test('approve and reject hash separately - mixed rulings are not a loop', () => {
    const itemId = `att:idle:${sid()}`
    expect(actionHash(itemId, 'reject')).not.toBe(actionHash(itemId, 'approve'))
    noteResolution(itemId, 'reject', T0)
    noteResolution(itemId, 'approve', T0 + MIN)
    expect(noteResolution(itemId, 'reject', T0 + 2 * MIN).tripped).toBe(false)
  })

  test('a pure read never writes; the counting read tallies withheld offers and prunes expiry', () => {
    const itemId = `att:idle:${sid()}`
    for (let i = 0; i < RESOLUTION_REPEAT_CAP; i++) noteResolution(itemId, 'reject', T0 + i)
    const before = resolutionTrip(itemId, T0 + MIN) // pure read
    expect(before?.suppressed).toBe(0)
    const counted = resolutionTrip(itemId, T0 + MIN, true) // the live worklist's read
    expect(counted?.suppressed).toBe(1)
    // Past the window the trip is gone — pure read says null without deleting, the counting
    // read cleans up.
    expect(resolutionTrip(itemId, T0 + MIN + ATTEMPT_WINDOW_MS)).toBeNull()
    expect(resolutionTrip(itemId, T0 + MIN + ATTEMPT_WINDOW_MS, true)).toBeNull()
  })
})

// --- the escalation can never re-enter the loop --------------------------------------------------

describe('loop_break stays owner-facing', () => {
  test('classifyAutoAck refuses to auto-ack a loop escalation', () => {
    const item: AttentionItem = {
      key: 'loop:p:archive:x',
      kind: 'loop_break',
      summary: 'Loop breaker: …',
      firstSeenAt: new Date(T0).toISOString(),
      seenCount: 1,
    }
    // null = "needs judgment" in the classifier's contract; buildWorklist then skips the kind
    // explicitly, so it never becomes a work item either. An auto-ack would HIDE the escalation
    // from the owner's feed — the exact false quiet the breaker exists to prevent.
    expect(classifyAutoAck(item, 'reviewer', [])).toBeNull()
  })
})
