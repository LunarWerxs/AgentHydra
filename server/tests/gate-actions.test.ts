// server/tests/gate-actions.test.ts - Piece 9 pinned: every deed the act call can perform, from
// fake deps (the gate's own parsing is pinned in chat-gate.test.ts; these tests pin what a
// verdict BECOMES). Includes the owner's 85% overflow rule (2026-08-30): closed instances open
// only when at least one account is open AND every open candidate is provably saturated on
// either window - fresh readings only, and never vacuously (an all-closed fleet parks).
import { expect, test } from 'bun:test'
import type { ChatGate, CrashKind, FinishedLane } from '../src/chat-gate'
import { actOnGate, type GateActionDeps, parseActInput, resumeNotice } from '../src/gate-actions'
import { closedLandingEligible, pickLandingInstance } from '../src/monitor'

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
const finishedGate = (lane: FinishedLane, over: Partial<NonNullable<ChatGate['finished']>> = {}) =>
  gateOf({
    state: 'finished',
    finished: {
      lane,
      recapPresent: true,
      doneClaim: 'yes',
      endsWithQuestion: false,
      interrupted: false,
      lastAssistantText: 'evidence',
      ...over,
    },
  })
const crashedGate = (kind: CrashKind) => gateOf({ state: 'crashed', crashed: { kind } })

interface Fixture {
  deps: GateActionDeps
  events: string[]
}

/** Three instances: #1 running, #2 closed, #3 running (both signed in). Usage injectable per
 *  test; `open` flips the target to running so the boot-wait loop can observe it. */
function fixture(over: {
  gate: ChatGate | null
  home?: string | null
  usage?: Array<{
    ref: string
    weeklyPct: number | null
    sessionPct?: number | null
    stale?: boolean
    sessionResetsAt?: string | null
    weeklyResetsAt?: string | null
  }>
  instances?: Array<{ num: number; dir: string; isRunning: boolean; signedIn: boolean }>
  superseded?: boolean
  title?: string | null
  openFails?: boolean
  openStalls?: boolean
  archiveHits?: Array<{ profile: string; wasRunning: boolean; changed: boolean }>
  pinnedRef?: string | null
  importOk?: boolean
}): Fixture {
  const events: string[] = []
  const opened = new Set<string>()
  const base = over.instances ?? [
    { num: 1, dir: 'C:/i1', isRunning: true, signedIn: true },
    { num: 2, dir: 'C:/i2', isRunning: false, signedIn: true },
    { num: 3, dir: 'C:/i3', isRunning: true, signedIn: true },
  ]
  let t = 0
  const deps: GateActionDeps = {
    gate: () => over.gate,
    home: async () => over.home ?? null,
    superseded: () => over.superseded ?? false,
    resolveTitle: async () => (over.title === undefined ? 'A Real Name' : over.title),
    pinnedRefFor: () => over.pinnedRef ?? null,
    instances: async () =>
      base.map((i) => ({
        num: i.num,
        name: `i${i.num}`,
        label: null,
        dir: i.dir,
        ref: `desktop:${i.dir}`,
        isRunning: i.isRunning || opened.has(i.dir),
        pid: null,
        loginUuid: i.signedIn ? `uuid-${i.num}` : null,
        signedIn: i.signedIn,
        account: null,
      })),
    usage: () =>
      (over.usage ?? []).map((u) => ({
        ref: u.ref,
        account: null,
        weeklyPct: u.weeklyPct,
        weeklyBand: 'ok' as const,
        weeklyResetsAt: u.weeklyResetsAt ?? null,
        weeklyResetsInMins: null,
        sessionPct: u.sessionPct ?? null,
        sessionBand: 'ok' as const,
        sessionResetsAt: u.sessionResetsAt ?? null,
        sessionResetsInMins: null,
        capturedAt: null,
        ageMins: 0,
        stale: u.stale ?? false,
      })),
    archive: async (sessionId, archived) => {
      events.push(`archive:${sessionId}:${archived}`)
      const hits = over.archiveHits ?? []
      return hits.length
        ? { ok: true, hits }
        : { ok: false, hits: [], reason: 'no-desktop-chat-found' }
    },
    open: async (dir) => {
      events.push(`open:${dir}`)
      if (over.openFails) return { ok: false }
      if (!over.openStalls) opened.add(dir)
      return { ok: true }
    },
    importSession: async (o) => {
      events.push(`import:${o.instanceDir}:${o.title}`)
      return over.importOk === false ? { ok: false, reason: 'nope' } : { ok: true }
    },
    openWaitMs: 5000,
    sleep: async () => {},
    now: () => (t += 100),
  }
  return { deps, events }
}

const fresh = (ref: string, weeklyPct: number, sessionPct = 0) => ({
  ref,
  weeklyPct,
  sessionPct,
  stale: false,
})

test('running -> left alone, always', async () => {
  const { deps, events } = fixture({
    gate: gateOf({ state: 'running', live: { pid: 7, name: 'x' } }),
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('left-alone')
  expect(r?.why).toContain('leave it alone')
  expect(events).toEqual([])
})

test('human-interrupted -> left alone', async () => {
  const { deps, events } = fixture({ gate: finishedGate('human', { interrupted: true }) })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('left-alone')
  expect(events).toEqual([])
})

test('no gate -> null (what cannot be gated cannot be acted on)', async () => {
  const { deps } = fixture({ gate: null })
  expect(await actOnGate('sid', {}, deps)).toBe(null)
})

test('archive-candidate -> archive flag written; durable when no app was running', async () => {
  const { deps, events } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i2', wasRunning: false, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('archived')
  expect(r?.archived).toEqual({ profiles: 1, durable: true })
  expect(events).toEqual(['archive:sid:true'])
})

test('archive-candidate under a RUNNING app -> archived but honestly non-durable', async () => {
  const { deps } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('archived')
  expect(r?.archived?.durable).toBe(false)
  expect(r?.why).toContain('Manage-DesktopChat.ps1')
})

test('archive-candidate with no desktop entry -> left alone, transcript already at rest', async () => {
  const { deps } = fixture({ gate: finishedGate('archive-candidate') })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('left-alone')
  expect(r?.why).toContain('already at rest')
})

test('crashed with a RUNNING home -> surfaced there, resume prompt attached, nothing opened', async () => {
  const { deps, events } = fixture({ gate: crashedGate('mid-turn'), home: 'C:/i1' })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance).toEqual({ ref: 'desktop:C:/i1', num: 1 })
  expect(r?.openedInstance).toBe(false)
  expect(r?.prompt).toBe(resumeNotice('mid-turn'))
  expect(r?.promptDelivery).toBe('deliver-natively-via-the-app-message-channel')
  expect(events).toEqual(['import:C:/i1:A Real Name'])
})

test('crashed with a CLOSED home and open headroom -> parked, the 85% rule refuses the boot', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    usage: [fresh('desktop:C:/i1', 50), fresh('desktop:C:/i3', 40)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('85')
  expect(events).toEqual([])
})

test('crashed with a CLOSED home, every open account saturated -> home is booted and surfaced', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('error'),
    home: 'C:/i2',
    usage: [fresh('desktop:C:/i1', 90), fresh('desktop:C:/i3', 88)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.openedInstance).toBe(true)
  expect(events).toEqual(['open:C:/i2', 'import:C:/i2:A Real Name'])
})

test('the 5-HOUR window alone can prove saturation (owner: either threshold)', async () => {
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    usage: [fresh('desktop:C:/i1', 50, 92), fresh('desktop:C:/i3', 40, 86)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.openedInstance).toBe(true)
})

test('STALE readings never prove saturation - no boot on a guess', async () => {
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    usage: [
      { ref: 'desktop:C:/i1', weeklyPct: 95, sessionPct: 95, stale: true },
      fresh('desktop:C:/i3', 90),
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
})

test('crashed and HOMELESS -> landed in the running instance with the most weekly headroom', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('overload'),
    home: null,
    usage: [fresh('desktop:C:/i1', 50), fresh('desktop:C:/i3', 10)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(3)
  expect(r?.openedInstance).toBe(false)
  expect(events).toEqual(['import:C:/i3:A Real Name'])
})

test('homeless with every open account saturated -> the closed instance is opened and takes it', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: null,
    usage: [
      fresh('desktop:C:/i1', 90),
      fresh('desktop:C:/i3', 92),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true }, // closed caches are stale by nature
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(2)
  expect(r?.openedInstance).toBe(true)
  expect(events).toEqual(['open:C:/i2', 'import:C:/i2:A Real Name'])
})

test('nothing open at all -> PARKED: the overflow rule is not vacuous (review-confirmed)', async () => {
  // The owner's words - "only if the accounts that are open have exceeded" - cannot truthfully
  // hold when no account is open, so an all-closed fleet parks instead of booting an app the
  // rule never authorized. Whether an idle fleet should self-open is his call, not a default.
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: null,
    instances: [
      { num: 2, dir: 'C:/i2', isRunning: false, signedIn: true },
      { num: 5, dir: 'C:/i5', isRunning: false, signedIn: true },
    ],
    usage: [
      { ref: 'desktop:C:/i2', weeklyPct: 60, stale: true },
      { ref: 'desktop:C:/i5', weeklyPct: 15, stale: true },
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(events).toEqual([])
})

test('crashed by the usage wall -> wait-for-reset, and nothing is imported or opened', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('usage-limit'),
    pinnedRef: 'desktop:C:/i1',
    usage: [{ ref: 'desktop:C:/i1', weeklyPct: 90, sessionResetsAt: '2026-08-30T09:00:00Z' }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('wait-for-reset')
  expect(r?.resumeAt).toBe('2026-08-30T09:00:00Z')
  expect(events).toEqual([])
})

test('superseded -> parked; the successor owns the work', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    superseded: true,
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('superseded')
  expect(events).toEqual([])
})

test('the naming law holds on the act path: no real name, no surfacing', async () => {
  const { deps, events } = fixture({ gate: crashedGate('mid-turn'), home: 'C:/i1', title: null })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('naming law')
  expect(events).toEqual([])
})

test('needs-input without a decision -> parked with the judgment mandate', async () => {
  const { deps } = fixture({ gate: finishedGate('needs-input-review', { doneClaim: 'unknown' }) })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('autonomy judgment')
})

test('needs-input judged human -> left-for-human, untouched', async () => {
  const { deps, events } = fixture({ gate: finishedGate('needs-input-review') })
  const r = await actOnGate('sid', { decision: 'human' }, deps)
  expect(r?.action).toBe('left-for-human')
  expect(events).toEqual([])
})

test('needs-input judged autonomous -> surfaced with the ANSWER as the prompt', async () => {
  const { deps } = fixture({ gate: finishedGate('needs-input-review'), home: 'C:/i1' })
  const r = await actOnGate('sid', { decision: 'autonomous', answer: 'Yes - ship it.' }, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.prompt).toBe('Yes - ship it.')
})

test('autonomous without answer text -> parked', async () => {
  const { deps } = fixture({ gate: finishedGate('needs-input-review') })
  const r = await actOnGate('sid', { decision: 'autonomous', answer: '  ' }, deps)
  expect(r?.action).toBe('parked')
})

test('a failed import parks honestly instead of claiming a surface', async () => {
  const { deps } = fixture({ gate: crashedGate('mid-turn'), home: 'C:/i1', importOk: false })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('nope')
})

test('a signed-out CLOSED home parks - never booted, even under full saturation', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    instances: [
      { num: 1, dir: 'C:/i1', isRunning: true, signedIn: true },
      { num: 2, dir: 'C:/i2', isRunning: false, signedIn: false },
    ],
    usage: [fresh('desktop:C:/i1', 95)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('signed out')
  expect(events).toEqual([])
})

test('a signed-out RUNNING home parks too - an app with no login cannot run the chat', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    instances: [{ num: 1, dir: 'C:/i1', isRunning: true, signedIn: false }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('running but signed out')
  expect(events).toEqual([])
})

test('a home that is not a managed instance parks with the specific reason', async () => {
  const { deps } = fixture({ gate: crashedGate('mid-turn'), home: 'C:/nowhere' })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('not a managed instance')
})

test('a failed open parks honestly', async () => {
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    usage: [fresh('desktop:C:/i1', 90), fresh('desktop:C:/i3', 90)],
    openFails: true,
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('could not open instance #2')
})

test('an opened instance that never reaches running parks on the deadline, not an infinite spin', async () => {
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i2',
    usage: [fresh('desktop:C:/i1', 90), fresh('desktop:C:/i3', 90)],
    openStalls: true,
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('did not reach running')
})

test('wait-for-reset reports the BINDING window: a pegged weekly wins over a sooner 5-hour reset', async () => {
  const { deps } = fixture({
    gate: crashedGate('usage-limit'),
    pinnedRef: 'desktop:C:/i1',
    usage: [
      {
        ref: 'desktop:C:/i1',
        weeklyPct: 100,
        sessionPct: 20,
        sessionResetsAt: '2026-08-30T09:00:00Z',
        weeklyResetsAt: '2026-09-03T07:00:00Z',
      },
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.resumeAt).toBe('2026-09-03T07:00:00Z')
})

test('wait-for-reset falls back to the weekly reset when no session reset is known', async () => {
  const { deps } = fixture({
    gate: crashedGate('usage-limit'),
    pinnedRef: 'desktop:C:/i1',
    usage: [{ ref: 'desktop:C:/i1', weeklyPct: 90, weeklyResetsAt: '2026-09-03T07:00:00Z' }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.resumeAt).toBe('2026-09-03T07:00:00Z')
})

test('wait-for-reset resolves the account from the desktop HOME when nothing is pinned', async () => {
  const { deps } = fixture({
    gate: crashedGate('usage-limit'),
    home: 'C:/i1',
    usage: [{ ref: 'desktop:C:/i1', weeklyPct: 50, sessionResetsAt: '2026-08-30T11:00:00Z' }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.resumeAt).toBe('2026-08-30T11:00:00Z')
})

test('parseActInput pins the route contract: bad decisions 400, answers are capped', () => {
  expect(parseActInput({ decision: 'maybe' })).toEqual({
    ok: false,
    error: "decision must be 'autonomous' or 'human'",
  })
  expect(parseActInput({})).toEqual({ ok: true, input: { decision: undefined, answer: undefined } })
  const long = parseActInput({ decision: 'autonomous', answer: 'x'.repeat(9000) })
  expect(long.ok).toBe(true)
  if (long.ok) {
    expect(long.input.decision).toBe('autonomous')
    expect(long.input.answer?.length).toBe(8000)
  }
})

// --- the picker itself, pure ---------------------------------------------------------------

const inst = (num: number, isRunning: boolean, signedIn = true) => ({
  ref: `desktop:C:/i${num}`,
  num,
  isRunning,
  signedIn,
})

test('pickLandingInstance: a running pin still wins, never opens', () => {
  const r = pickLandingInstance('desktop:C:/i3', [inst(1, true), inst(3, true)], [])
  expect(r).toEqual({ ref: 'desktop:C:/i3', num: 3, mustOpen: false })
})

test('pickLandingInstance: closed stays ineligible while any open account has fresh headroom', () => {
  const r = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 84), { ref: 'desktop:C:/i2', weeklyPct: 5, stale: true }],
  )
  expect(r).toEqual({ ref: 'desktop:C:/i1', num: 1, mustOpen: false })
})

test('pickLandingInstance: an 84.9 is headroom, an 85.0 is not - the line is exact', () => {
  const below = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 84.9), { ref: 'desktop:C:/i2', weeklyPct: 5, stale: true }],
  )
  expect(below?.mustOpen).toBe(false)
  const at = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 85), { ref: 'desktop:C:/i2', weeklyPct: 5, stale: true }],
  )
  expect(at).toEqual({ ref: 'desktop:C:/i2', num: 2, mustOpen: true })
})

test('pickLandingInstance: under overflow a closed one wins only on strictly better weekly', () => {
  // running at 90 vs closed at stale 92: stay on the running one - booting buys nothing.
  const r = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 90), { ref: 'desktop:C:/i2', weeklyPct: 92, stale: true }],
  )
  expect(r).toEqual({ ref: 'desktop:C:/i1', num: 1, mustOpen: false })
})

test('pickLandingInstance: signed-out instances never join either pool', () => {
  const r = pickLandingInstance(null, [inst(1, true, false), inst(2, false, false)], [])
  expect(r).toBe(null)
})

test('closedLandingEligible: unknown usage on a running instance blocks the overflow', () => {
  expect(closedLandingEligible([{ ref: 'desktop:C:/i1' }], [])).toBe(false)
  expect(closedLandingEligible([], [])).toBe(false) // NOT vacuous: nothing open proves nothing
  expect(closedLandingEligible([{ ref: 'desktop:C:/i1' }], [fresh('desktop:C:/i1', 85)])).toBe(true)
  expect(closedLandingEligible([{ ref: 'desktop:C:/i1' }], [fresh('desktop:C:/i1', 10, 85)])).toBe(
    true,
  )
})
