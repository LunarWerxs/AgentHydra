// server/tests/gate-sweep.test.ts - the sweep pinned: enumeration (non-archived, deduped,
// transcript-id preferred), lane dispatch, cap accounting, sequential acting, honest ungated
// listing, and the never-auto-acted judgment lane. The act itself is pinned in
// gate-actions.test.ts; these tests pin WHICH chats it is called for and in what order.
// ⛔ EVERY CALL PASSES reconcileRendered:false. The sweep's last step asks each RUNNING app what
// its sidebar shows, which drives real UIA against real windows - correct in production, and
// absolutely not something a unit test may do to whatever apps happen to be open on the machine
// running it. The reconcile has its own tests in zombie-rows.test.ts, with every dependency
// injected.
import { expect, test } from 'bun:test'
import type { ChatGate, CrashKind, FinishedLane } from '../src/chat-gate'
import type { GateActionResult } from '../src/gate-actions'
import { parseSweepInput, type SweepDeps, sweepGateActions } from '../src/gate-sweep'

const gateOf = (over: Partial<ChatGate>): ChatGate => ({
  sessionId: 's',
  state: 'finished',
  cause: 'x',
  transcriptPath: 't',
  quietSecs: 0,
  live: null,
  crashed: null,
  finished: null,
  stalled: null,
  ...over,
})
const finishedGate = (lane: FinishedLane) =>
  gateOf({
    state: 'finished',
    finished: {
      lane,
      recapPresent: true,
      doneClaim: lane === 'archive-candidate' ? 'yes' : 'unknown',
      endsWithQuestion: lane === 'needs-input-review',
      interrupted: lane === 'human',
      lastAssistantText: 'the evidence text',
    },
  })
const crashedGate = (kind: CrashKind) => gateOf({ state: 'crashed', crashed: { kind } })

function fixture(over: {
  gates: Record<string, ChatGate | null>
  meta?: Array<{
    key: string
    archived?: boolean
    title?: string | null
    cliSessionId?: string | null
    path?: string
  }>
  actResult?: Partial<GateActionResult>
  /** Ids for which the act returns null (transcript vanished mid-sweep). */
  actNull?: string[]
}): { deps: SweepDeps; acted: string[] } {
  const acted: string[] = []
  const deps: SweepDeps = {
    gate: (id) => over.gates[id] ?? null,
    meta: () =>
      new Map(
        (over.meta ?? []).map((m) => [
          m.key,
          {
            archived: m.archived ?? false,
            title: m.title ?? null,
            instance: 'i1',
            path: m.path ?? `P:${m.key}`,
            cliSessionId: m.cliSessionId ?? null,
          },
        ]),
      ),
    act: async (sessionId) => {
      acted.push(sessionId)
      if (over.actNull?.includes(sessionId)) return null
      const g = over.gates[sessionId]
      const fallback: GateActionResult['action'] =
        g?.state === 'crashed'
          ? g.crashed?.kind === 'usage-limit'
            ? 'wait-for-reset'
            : 'surfaced'
          : 'archived'
      return {
        sessionId,
        gate: { state: g?.state ?? 'finished', crashedKind: g?.crashed?.kind ?? null, lane: null },
        action: over.actResult?.action ?? fallback,
        why: 'fixture',
        ...over.actResult,
      } as GateActionResult
    },
  }
  return { deps, acted }
}

test('enumeration: archived entries skipped, duplicate keys deduped by file, transcript id wins', async () => {
  const { deps, acted } = fixture({
    gates: { 'cli-1': finishedGate('archive-candidate'), s3: finishedGate('archive-candidate') },
    meta: [
      // One chat under two keys (filename id + cliSessionId) - must be swept ONCE, by cli id.
      { key: 'file-1', cliSessionId: 'cli-1', path: 'P:one' },
      { key: 'cli-1', cliSessionId: 'cli-1', path: 'P:one' },
      { key: 's2', archived: true },
      { key: 's3' },
    ],
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.scanned).toBe(2)
  expect(acted.sort()).toEqual(['cli-1', 's3'])
})

test('lane dispatch: only a chat mid-turn is left alone; every other lane routed', async () => {
  const { deps, acted } = fixture({
    gates: {
      run: gateOf({ state: 'running', live: { pid: 1, name: 'x' } }),
      hum: finishedGate('human'),
      arc: finishedGate('archive-candidate'),
      cra: crashedGate('mid-turn'),
      lim: crashedGate('usage-limit'),
      inp: finishedGate('needs-input-review'),
      gone: null,
    },
    meta: ['run', 'hum', 'arc', 'cra', 'lim', 'inp', 'gone'].map((key) => ({ key })),
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  // ONLY the live chat mid-turn is left alone now. The human-interrupted one is unarchived and
  // was touched moments ago, so the catch-all sends it to the AI to look at rather than filing
  // it under a counter - a chat sitting interrupted for hours is a decision somebody owes.
  expect(report.leftAlone).toBe(1)
  expect(report.acted).toEqual({ archived: 1, surfaced: 1 })
  expect(report.waitForReset.length).toBe(1)
  expect(report.ungated).toEqual([{ sessionId: 'gone', title: null, instance: 'i1' }])
  // The judgment lane is packaged, never acted (the one AI step stays the caller's).
  const judged = report.needsJudgment.map((r) => r.sessionId).sort()
  expect(judged).toEqual(['hum', 'inp'])
  expect(report.needsJudgment.find((r) => r.sessionId === 'inp')?.catchAll).toBe(null)
  expect(report.needsJudgment.find((r) => r.sessionId === 'hum')?.catchAll).toContain('decide')
  expect(acted.sort()).toEqual(['arc', 'cra', 'lim'])
})

// THE CATCH-ALL (owner rule): an unarchived chat touched in the last couple of hours is part of
// live work. If no lane could place it, the likeliest explanation is that the LANES are wrong -
// so the AI examines it. A classifier's blind spot is invisible from inside the classifier.
test('catch-all: a stale unplaced chat is left alone, a recent one is sent to be examined', async () => {
  const stale = await sweepGateActions(
    {},
    fixture({
      gates: { old: { ...finishedGate('human'), quietSecs: 5 * 60 * 60 } },
      meta: [{ key: 'old' }],
    }).deps,
  )
  expect(stale.leftAlone).toBe(1)
  expect(stale.needsJudgment).toEqual([])

  // A LIVE chat mid-turn is the one exclusion: it is visibly working, not misfiled, and
  // pulling it in could only lead to interrupting it.
  const busy = await sweepGateActions(
    {},
    fixture({
      gates: {
        busy: { ...gateOf({ state: 'running', live: { pid: 9, name: 'x' } }), quietSecs: 4 },
      },
      meta: [{ key: 'busy' }],
    }).deps,
  )
  expect(busy.leftAlone).toBe(1)
  expect(busy.needsJudgment).toEqual([])
})

test('caps: spent caps record over-cap rows instead of acting; 0 means pure report', async () => {
  const { deps, acted } = fixture({
    gates: {
      a1: finishedGate('archive-candidate'),
      a2: finishedGate('archive-candidate'),
      c1: crashedGate('mid-turn'),
      c2: crashedGate('overload'),
    },
    meta: ['a1', 'a2', 'c1', 'c2'].map((key) => ({ key })),
  })
  const report = await sweepGateActions(
    { reconcileRendered: false, maxArchive: 1, maxSurface: 0 },
    deps,
  )
  expect(acted).toEqual(['a1'])
  expect(report.acted).toEqual({ archived: 1, surfaced: 0 })
  expect(report.archiveRows.map((r) => r.action)).toEqual(['archived', 'over-cap'])
  // A cap of 0 reads as report-only, not as a spent cap.
  expect(report.crashedRows.map((r) => r.action)).toEqual(['report-only', 'report-only'])
})

test('a PRESENT-but-empty session_ids sweeps NOTHING - never the whole fleet', async () => {
  const { deps, acted } = fixture({
    gates: { x: finishedGate('archive-candidate') },
    meta: [{ key: 'x' }],
  })
  const report = await sweepGateActions({ reconcileRendered: false, sessionIds: [] }, deps)
  expect(report.scanned).toBe(0)
  expect(acted).toEqual([])
})

test('usage-limit acts only when the surface lane is live: 0/0 is a genuinely pure report', async () => {
  const { deps, acted } = fixture({
    gates: { lim: crashedGate('usage-limit') },
    meta: [{ key: 'lim' }],
  })
  const report = await sweepGateActions(
    { reconcileRendered: false, maxArchive: 0, maxSurface: 0 },
    deps,
  )
  expect(acted).toEqual([])
  expect(report.waitForReset.map((r) => r.action)).toEqual(['report-only'])
})

test('acted rows echo the ACT result (fresh re-gate), carrying prompt and surfacedIn', async () => {
  const { deps } = fixture({
    gates: { c1: crashedGate('mid-turn') },
    meta: [{ key: 'c1' }],
    actResult: {
      gate: { state: 'crashed', crashedKind: 'mid-turn', lane: null },
      action: 'surfaced',
      why: 'fixture-surfaced',
      instance: { ref: 'desktop:C:/i9', num: 9 },
      openedInstance: false,
      prompt: 'THE EXACT PROMPT',
      promptDelivery: 'deliver-natively-via-the-app-message-channel',
    },
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  const row = report.crashedRows[0]
  expect(row?.prompt).toBe('THE EXACT PROMPT')
  expect(row?.surfacedIn).toEqual({ ref: 'desktop:C:/i9', num: 9 })
  expect(row?.promptDelivery).toBe('deliver-natively-via-the-app-message-channel')
})

test('a verdict that moved between gate and act is reported as the ACT saw it', async () => {
  // The sweep classified it crashed; by act time it was running again. The row must not claim
  // crashed-state next to a left-alone action (review-confirmed contradiction).
  const { deps } = fixture({
    gates: { c1: crashedGate('overload') },
    meta: [{ key: 'c1' }],
    actResult: {
      gate: { state: 'running', crashedKind: null, lane: null },
      action: 'left-alone',
      why: 'running (pid 7) - the rule is leave it alone',
    },
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.crashedRows[0]?.state).toBe('running')
  expect(report.crashedRows[0]?.action).toBe('left-alone')
})

test('one transcript imported into TWO instances is swept once (dedup by resolved id)', async () => {
  const { deps, acted } = fixture({
    gates: { X: finishedGate('archive-candidate') },
    meta: [
      { key: 'f1', cliSessionId: 'X', path: 'P:instanceA' },
      { key: 'f2', cliSessionId: 'X', path: 'P:instanceB' },
    ],
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.scanned).toBe(1)
  expect(acted).toEqual(['X'])
})

test('an act that returns nothing leaves a parked row, never a vanished candidate', async () => {
  const { deps } = fixture({
    gates: { a1: finishedGate('archive-candidate') },
    meta: [{ key: 'a1' }],
    actNull: ['a1'],
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.archiveRows[0]?.action).toBe('parked')
  expect(report.archiveRows[0]?.why).toContain('vanished')
})

test('the deadline cuts off honestly: remaining candidates listed as unswept', async () => {
  let t = 0
  const { deps } = fixture({
    gates: {
      a1: finishedGate('archive-candidate'),
      a2: finishedGate('archive-candidate'),
      a3: finishedGate('archive-candidate'),
    },
    meta: ['a1', 'a2', 'a3'].map((key) => ({ key })),
  })
  deps.now = () => (t += 400)
  const report = await sweepGateActions({ reconcileRendered: false, deadlineMs: 1000 }, deps)
  expect(report.deadlineHit).toBe(true)
  expect(report.unswept.length).toBeGreaterThan(0)
  expect(report.unswept.length + report.archiveRows.length).toBe(3)
})

test('parseSweepInput: malformed input errors instead of silently going permissive', () => {
  expect(parseSweepInput({ session_ids: 'nope' }).ok).toBe(false)
  expect(parseSweepInput({ session_ids: ['a', 5] }).ok).toBe(false)
  expect(parseSweepInput({ max_archive: -1 }).ok).toBe(false)
  expect(parseSweepInput({ max_surface: 'many' }).ok).toBe(false)
  const empty = parseSweepInput({ session_ids: [] })
  expect(empty.ok && empty.opts.sessionIds).toEqual([])
  const good = parseSweepInput({ session_ids: [' a '], max_archive: 2.9, max_surface: 0 })
  expect(good.ok && good.opts).toEqual({ sessionIds: ['a'], maxArchive: 2, maxSurface: 0 })
})

test('a surface that PARKS does not spend the surface cap', async () => {
  const { deps } = fixture({
    gates: { c1: crashedGate('mid-turn'), c2: crashedGate('mid-turn') },
    meta: ['c1', 'c2'].map((key) => ({ key })),
    actResult: { action: 'parked', why: 'no eligible instance' },
  })
  const report = await sweepGateActions({ reconcileRendered: false, maxSurface: 1 }, deps)
  // Both attempted: the first parked, so the cap was still unspent for the second.
  expect(report.crashedRows.map((r) => r.action)).toEqual(['parked', 'parked'])
  expect(report.acted.surfaced).toBe(0)
})

test('acts run SEQUENTIALLY in enumeration order - never interleaved', async () => {
  const order: string[] = []
  const { deps } = fixture({
    gates: {
      a1: finishedGate('archive-candidate'),
      c1: crashedGate('mid-turn'),
      a2: finishedGate('archive-candidate'),
    },
    meta: ['a1', 'c1', 'a2'].map((key) => ({ key })),
  })
  const inner = deps.act
  if (!inner) throw new Error('fixture always sets act')
  deps.act = async (id, input, d) => {
    order.push(`start:${id}`)
    const r = await inner(id, input, d)
    order.push(`end:${id}`)
    return r
  }
  await sweepGateActions({ reconcileRendered: false }, deps)
  expect(order).toEqual(['start:a1', 'end:a1', 'start:c1', 'end:c1', 'start:a2', 'end:a2'])
})

test('an act that THROWS becomes a parked row - one bad chat never kills the sweep', async () => {
  const { deps } = fixture({
    gates: { boom: finishedGate('archive-candidate'), fine: finishedGate('archive-candidate') },
    meta: [{ key: 'boom' }, { key: 'fine' }],
  })
  const inner = deps.act
  if (!inner) throw new Error('fixture always sets act')
  deps.act = async (id, input, d) => {
    if (id === 'boom') throw new Error('IPC exploded')
    return inner(id, input, d)
  }
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.archiveRows.map((r) => r.action)).toEqual(['parked', 'archived'])
  expect(report.archiveRows[0]?.why).toContain('the act threw: IPC exploded')
})

test('session_ids scoping sweeps exactly those, ignoring the fleet index', async () => {
  const { deps, acted } = fixture({
    gates: { only: finishedGate('archive-candidate') },
    meta: [{ key: 'other' }],
  })
  const report = await sweepGateActions({ reconcileRendered: false, sessionIds: ['only'] }, deps)
  expect(report.scanned).toBe(1)
  expect(acted).toEqual(['only'])
})

test('THE BREAKER STOPS THE ARCHIVE LOOP - the case it exists for, which needs no failing act', async () => {
  // The motivating failure (measured by v1): the archive EXECUTES and verifies every time,
  // then the running app re-saves the sidebar entry un-archived after the act returned, and
  // the next sweep sees a done-marked visible chat again. Every pass returns 'archived'.
  // Clearing the counter on that success made the cap unreachable for exactly this loop, so
  // this test drives repeated SUCCESSFUL archives and demands the machinery eventually stops.
  const { db } = await import('../src/db')
  const { ATTEMPT_CAP } = await import('../src/breaker')
  db.query('delete from action_attempt_log').run()

  const runOnce = async () => {
    const f = fixture({
      gates: { s1: finishedGate('archive-candidate') },
      meta: [{ key: 's1', cliSessionId: 's1' }],
    })
    const report = await sweepGateActions({ reconcileRendered: false }, f.deps)
    return { acted: f.acted, report }
  }

  for (let i = 0; i < ATTEMPT_CAP; i++) {
    const r = await runOnce()
    expect(r.acted).toEqual(['s1']) // still trying - the chat keeps coming back
  }
  // The cap is now spent: the machinery must STOP calling act, and say so out loud.
  const capped = await runOnce()
  expect(capped.acted).toEqual([])
  const row = capped.report.archiveRows[0]
  expect(row?.action).toBe('parked')
  expect(row?.why).toContain('without sticking')
  // ...and the row must carry the chat's REAL state, not a fabricated 'crashed'.
  expect(row?.state).toBe('finished')
  db.query('delete from action_attempt_log').run()
})

test('a SURFACED chat clears its count - it becomes running, so it is self-limiting', async () => {
  const { db } = await import('../src/db')
  const { ATTEMPT_CAP, checkBreaker } = await import('../src/breaker')
  db.query('delete from action_attempt_log').run()
  for (let i = 0; i < ATTEMPT_CAP - 1; i++) {
    const f = fixture({
      gates: { s2: crashedGate('mid-turn') },
      meta: [{ key: 's2', cliSessionId: 's2' }],
    })
    await sweepGateActions({ reconcileRendered: false }, f.deps)
  }
  expect(checkBreaker('surface', 's2').attempts).toBe(0)
  db.query('delete from action_attempt_log').run()
})

test('a HELD chat is parked, not acted on, and the reason travels with the row', async () => {
  const { deps, acted } = fixture({
    gates: { arc: finishedGate('archive-candidate') },
    meta: [{ key: 'arc' }],
  })
  deps.heldSession = () => ({
    sessionId: 'arc',
    reason: 'owner working it by hand',
    heldAt: 'WHEN',
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(acted).toEqual([])
  expect(report.acted.archived).toBe(0)
  expect(report.archiveRows[0]?.action).toBe('parked')
  expect(report.archiveRows[0]?.why).toContain('owner working it by hand')
})

test('a hold outranks the breaker - it is checked first, so its reason is what gets reported', async () => {
  const { db } = await import('../src/db')
  const { ATTEMPT_CAP, noteAttempt } = await import('../src/breaker')
  db.query('delete from action_attempt_log').run()
  const { deps } = fixture({
    gates: { arc: finishedGate('archive-candidate') },
    meta: [{ key: 'arc' }],
  })
  for (let i = 0; i < ATTEMPT_CAP; i++) noteAttempt('archive', 'arc', Date.now())
  deps.heldSession = () => ({ sessionId: 'arc', reason: 'parked mid-experiment', heldAt: 'WHEN' })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(report.archiveRows[0]?.why).toContain('parked mid-experiment')
  db.query('delete from action_attempt_log').run()
})

test('a STALLED live chat is still left alone, but it is listed instead of hidden in a count', async () => {
  const { deps, acted } = fixture({
    gates: {
      stuck: gateOf({
        state: 'running',
        live: { pid: 7, name: 'peer-a' },
        stalled: { tool: 'Bash', quietSecs: 3600, why: 'no result after the call' },
      }),
      busy: gateOf({ state: 'running', live: { pid: 8, name: 'peer-b' } }),
    },
    meta: [{ key: 'stuck' }, { key: 'busy' }],
  })
  const report = await sweepGateActions({ reconcileRendered: false }, deps)
  expect(acted).toEqual([])
  expect(report.leftAlone).toBe(2)
  expect(report.stalled.map((r) => r.sessionId)).toEqual(['stuck'])
  expect(report.stalled[0]?.tool).toBe('Bash')
})
