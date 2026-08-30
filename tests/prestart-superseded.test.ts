// tests/prestart-superseded.test.ts — the pre-check must never hand back advice that the
// actuator structurally refuses.
//
// THE BUG THIS PINS (measured 2026-08-30, in a real orchestration pass): the lanes come from the
// GATE, which reads a transcript on its own terms and knows nothing about done-marks;
// junk.supersededVisible comes from the MARKS table. Nothing reconciled the two. So a retired
// lineage whose transcript happens to end mid-question landed in `needsJudgment` and was told
// "judge-then-act" — while chat_act, which re-gates and DOES see the mark, parked it as
// superseded every time. Impossible advice, re-derived fresh on every pass, so it came back
// forever: an orchestration that can never reach an empty queue. Exactly the failure mode where
// a report looks busy and is in fact stuck.
//
// The invariant: if a chat is superseded, its next step is ARCHIVE, and the `why` names the
// route that actually works. A step of 'judge-then-act' or 'surface-and-deliver' on a superseded
// chat is the regression.

import { describe, expect, test } from 'bun:test'
import type { PrestartDeps } from '../server/src/prestart'
import { prestartCheck } from '../server/src/prestart'

const SUPERSEDED = '9e9276f7-0000-4000-8000-000000000001'
const NORMAL = '58dc49b2-0000-4000-8000-000000000002'

/** Two open instances, so the sanity rail passes and the report is trusted downstream. */
function baseDeps(over: Partial<PrestartDeps> = {}): PrestartDeps {
  return {
    instancesList: async () =>
      [1, 2].map(
        (n) =>
          ({
            ref: `desktop:i${n}`,
            num: n,
            name: `i${n}`,
            label: null,
            isRunning: true,
            signedIn: true,
            account: { planLabel: 'Max 20x' },
          }) as never,
      ),
    usageList: () => [],
    doneMarked: () => new Map([[SUPERSEDED, Date.now() - 60_000]]),
    liveMap: () => new Map(),
    meta: () =>
      new Map([
        [
          SUPERSEDED,
          {
            archived: false,
            title: 'AgentHydra review smoke target',
            instance: 'i1',
            path: 'p1',
            cliSessionId: SUPERSEDED,
          },
        ],
        [
          NORMAL,
          {
            archived: false,
            title: 'Real work',
            instance: 'i1',
            path: 'p2',
            cliSessionId: NORMAL,
          },
        ],
      ]),
    collisions: () => [],
    handoff: () => [],
    suppressed: () => [],
    holds: () => [],
    health: () => [],
    deliveries: () => [],
    ...over,
  }
}

/** A sweep report putting BOTH chats in needsJudgment — only one of them is superseded. */
const sweepBothNeedJudgment = (async () => ({
  scanned: 2,
  leftAlone: 2,
  acted: { archived: 0, surfaced: 0 },
  caps: { maxArchive: 0, maxSurface: 0 },
  archiveRows: [],
  crashedRows: [],
  waitForReset: [],
  needsJudgment: [
    {
      sessionId: SUPERSEDED,
      title: 'AgentHydra review smoke target',
      instance: 'i1',
      doneClaim: 'unknown',
      endsWithQuestion: false,
      lastAssistantText: 'Ready.',
    },
    {
      sessionId: NORMAL,
      title: 'Real work',
      instance: 'i1',
      doneClaim: 'unknown',
      endsWithQuestion: true,
      lastAssistantText: 'Which one do you want?',
    },
  ],
  stalled: [],
  ungated: [],
  unswept: [],
  deadlineHit: false,
})) as never

test('a superseded chat is told to ARCHIVE, never to judge-then-act', async () => {
  const r = await prestartCheck(baseDeps({ sweep: sweepBothNeedJudgment }))

  expect(r.sanity.plausible).toBe(true)
  expect(r.junk.supersededVisible.map((x) => x.sessionId)).toEqual([SUPERSEDED])

  const dead = r.nextSteps.find((s) => s.sessionId === SUPERSEDED)
  expect(dead?.step).toBe('archive')
  // The reader must be pointed at the route that WORKS, not back at the one that parks.
  expect(dead?.why).toContain('desktop-archive')
  expect(dead?.why).not.toContain('judge autonomous-vs-human')
})

test('a normal needs-judgment chat is left as judge-then-act', async () => {
  const r = await prestartCheck(baseDeps({ sweep: sweepBothNeedJudgment }))
  const live = r.nextSteps.find((s) => s.sessionId === NORMAL)
  // The reconciliation must be surgical: it rewrites the superseded row and nothing else.
  expect(live?.step).toBe('judge-then-act')
})

test('no nextStep on ANY superseded chat asks for a judgment or a resume', async () => {
  // The same reconciliation has to hold whichever lane the gate happened to file it under —
  // a superseded chat that reads as "crashed" must not be told to surface-and-deliver either.
  const asCrashed = (async () => ({
    scanned: 1,
    leftAlone: 0,
    acted: { archived: 0, surfaced: 0 },
    caps: { maxArchive: 0, maxSurface: 0 },
    archiveRows: [],
    crashedRows: [
      {
        sessionId: SUPERSEDED,
        title: 'AgentHydra review smoke target',
        instance: 'i1',
        state: 'crashed',
        crashedKind: 'exit',
        lane: 'crashed',
        action: 'report-only',
        why: 'report-only',
      },
    ],
    waitForReset: [],
    needsJudgment: [],
    stalled: [],
    ungated: [],
    unswept: [],
    deadlineHit: false,
  })) as never

  const r = await prestartCheck(baseDeps({ sweep: asCrashed }))
  const dead = r.nextSteps.find((s) => s.sessionId === SUPERSEDED)
  expect(dead?.step).toBe('archive')
  expect(r.nextSteps.every((s) => s.step !== 'surface-and-deliver')).toBe(true)
})

test('a LIVE done-marked chat is a contradiction, not junk — and keeps its own lane', async () => {
  // Guards the boundary of the new reconciliation: liveButDoneMarked must NOT be swept into
  // supersededVisible, because the owner untangles those by hand and archiving one would
  // retire a chat that is actively running.
  const r = await prestartCheck(
    baseDeps({
      sweep: sweepBothNeedJudgment,
      liveMap: () => new Map([[SUPERSEDED, Date.now() - 30_000]]),
    }),
  )
  expect(r.junk.supersededVisible).toEqual([])
  expect(r.junk.liveButDoneMarked.map((x) => x.sessionId)).toEqual([SUPERSEDED])
  // Not rewritten: it is not superseded, so it keeps whatever the gate said.
  expect(r.nextSteps.find((s) => s.sessionId === SUPERSEDED)?.step).toBe('judge-then-act')
})

// ── HOLDS: the same reconciliation, the same failure shape ─────────────────────────────────────
// A hold means "take no initiative on this chat", and gate-sweep honours it by parking every held
// chat before it acts. But nextSteps is built from the GATE, which knows nothing about the holds
// table - the identical split that produced the superseded bug above. So a chat put on hold
// SPECIFICALLY because an unattended pass must not touch it was still advertised as
// "judge-then-act" on every single pass, which is how a hold quietly stops meaning anything.
//
// It is rewritten, never dropped: holds.ts is explicit that nothing about a held chat is hidden
// and that it still appears in the pre-start check with its reason, because a chat that silently
// vanished from the fleet view would be worse than one that got acted on.
describe('a held chat is never advertised as actionable', () => {
  const HELD_AT = '2026-08-30T23:55:02.048Z'
  const heldDeps = (over: Partial<PrestartDeps> = {}) =>
    baseDeps({
      sweep: sweepBothNeedJudgment,
      doneMarked: () => new Map(),
      holds: () => [
        { sessionId: SUPERSEDED, reason: 'needs the owner personally', heldAt: HELD_AT },
      ],
      ...over,
    })

  test('its step becomes leave-alone, carrying the hold reason', async () => {
    const r = await prestartCheck(heldDeps())
    const row = r.nextSteps.find((s) => s.sessionId === SUPERSEDED)
    expect(row?.step).toBe('leave-alone')
    expect(row?.why).toContain('ON HOLD')
    expect(row?.why).toContain('needs the owner personally')
    // The operator must be able to undo it, so the release route is named.
    expect(row?.why).toContain('release')
  })

  test('the row is NOT dropped - a vanished chat is worse than an acted-on one', async () => {
    const r = await prestartCheck(heldDeps())
    expect(r.nextSteps.some((s) => s.sessionId === SUPERSEDED)).toBe(true)
    expect(r.holds.map((h) => h.sessionId)).toEqual([SUPERSEDED])
  })

  test('an unheld chat in the same report is untouched', async () => {
    const r = await prestartCheck(heldDeps())
    expect(r.nextSteps.find((s) => s.sessionId === NORMAL)?.step).toBe('judge-then-act')
  })

  test('a hold outranks a superseded rewrite - no initiative beats archive-it', async () => {
    // Both reconciliations can match one chat. The hold must win: superseded says "archive this",
    // and archiving is exactly the unprompted deed a hold exists to prevent.
    const r = await prestartCheck(
      heldDeps({ doneMarked: () => new Map([[SUPERSEDED, 1_700_000_000_000]]) }),
    )
    const row = r.nextSteps.find((s) => s.sessionId === SUPERSEDED)
    expect(row?.step).toBe('leave-alone')
    expect(row?.why).toContain('ON HOLD')
  })
})
