// server/tests/gate-sweep.test.ts - the sweep pinned: enumeration (non-archived, deduped,
// transcript-id preferred), lane dispatch, cap accounting, sequential acting, honest ungated
// listing, and the never-auto-acted judgment lane. The act itself is pinned in
// gate-actions.test.ts; these tests pin WHICH chats it is called for and in what order.
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
  const report = await sweepGateActions({}, deps)
  expect(report.scanned).toBe(2)
  expect(acted.sort()).toEqual(['cli-1', 's3'])
})

test('lane dispatch: running and human left alone; every other lane routed', async () => {
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
  const report = await sweepGateActions({}, deps)
  expect(report.leftAlone).toBe(2)
  expect(report.acted).toEqual({ archived: 1, surfaced: 1 })
  expect(report.waitForReset.length).toBe(1)
  expect(report.ungated).toEqual([{ sessionId: 'gone', title: null, instance: 'i1' }])
  // The judgment lane is packaged, never acted (the one AI step stays the caller's).
  expect(report.needsJudgment).toEqual([
    {
      sessionId: 'inp',
      title: null,
      instance: 'i1',
      doneClaim: 'unknown',
      endsWithQuestion: true,
      lastAssistantText: 'the evidence text',
    },
  ])
  expect(acted.sort()).toEqual(['arc', 'cra', 'lim'])
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
  const report = await sweepGateActions({ maxArchive: 1, maxSurface: 0 }, deps)
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
  const report = await sweepGateActions({ sessionIds: [] }, deps)
  expect(report.scanned).toBe(0)
  expect(acted).toEqual([])
})

test('usage-limit acts only when the surface lane is live: 0/0 is a genuinely pure report', async () => {
  const { deps, acted } = fixture({
    gates: { lim: crashedGate('usage-limit') },
    meta: [{ key: 'lim' }],
  })
  const report = await sweepGateActions({ maxArchive: 0, maxSurface: 0 }, deps)
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
  const report = await sweepGateActions({}, deps)
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
  const report = await sweepGateActions({}, deps)
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
  const report = await sweepGateActions({}, deps)
  expect(report.scanned).toBe(1)
  expect(acted).toEqual(['X'])
})

test('an act that returns nothing leaves a parked row, never a vanished candidate', async () => {
  const { deps } = fixture({
    gates: { a1: finishedGate('archive-candidate') },
    meta: [{ key: 'a1' }],
    actNull: ['a1'],
  })
  const report = await sweepGateActions({}, deps)
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
  const report = await sweepGateActions({ deadlineMs: 1000 }, deps)
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
  const report = await sweepGateActions({ maxSurface: 1 }, deps)
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
  await sweepGateActions({}, deps)
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
  const report = await sweepGateActions({}, deps)
  expect(report.archiveRows.map((r) => r.action)).toEqual(['parked', 'archived'])
  expect(report.archiveRows[0]?.why).toContain('the act threw: IPC exploded')
})

test('session_ids scoping sweeps exactly those, ignoring the fleet index', async () => {
  const { deps, acted } = fixture({
    gates: { only: finishedGate('archive-candidate') },
    meta: [{ key: 'other' }],
  })
  const report = await sweepGateActions({ sessionIds: ['only'] }, deps)
  expect(report.scanned).toBe(1)
  expect(acted).toEqual(['only'])
})
