// server/tests/gate-actions.test.ts - Piece 9 pinned: every deed the act call can perform, from
// fake deps (the gate's own parsing is pinned in chat-gate.test.ts; these tests pin what a
// verdict BECOMES). Includes the owner's three 2026-08-30 rulings: the 85% overflow rule
// (closed instances open when every open candidate is provably saturated on either window, OR
// nothing is open at all - and the opened account must itself have a known reading under the
// line), the tier order (Max 20x > Max 5x > Max > Pro > rest, then lowest usage), and the
// server-side UI archive click for chats under a running app.
import { expect, test } from 'bun:test'
import type { ChatGate, CrashKind, FinishedLane } from '../src/chat-gate'
import { planRank } from '../src/fleet-instances'
import {
  actOnGate,
  type GateActionDeps,
  isActBusy,
  parseActInput,
  resumeNotice,
} from '../src/gate-actions'
import { closedLandingEligible, pickLandingInstance, underLandingThreshold } from '../src/monitor'

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
  staged: Array<{ sessionId: string; prompt: string; instanceRef: string | null }>
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
    ageMins?: number | null
  }>
  instances?: Array<{
    num: number
    dir: string
    isRunning: boolean
    signedIn: boolean
    plan?: string
  }>
  superseded?: boolean
  title?: string | null
  openFails?: boolean
  openStalls?: boolean
  uiClick?: { clicked: boolean; verified: boolean; reason?: string }
  liveNow?: boolean
  archiveHits?: Array<{ profile: string; wasRunning: boolean; changed: boolean }>
  pinnedRef?: string | null
  importOk?: boolean
}): Fixture {
  const events: string[] = []
  const staged: Array<{ sessionId: string; prompt: string; instanceRef: string | null }> = []
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
        account: i.plan
          ? { status: 'ok' as never, email: null, planLabel: i.plan, accountUuid: null }
          : null,
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
        // Stale fixture rows model a closed app's aged cache (session window provably reset);
        // fresh rows model a live refresher. Overridable per test.
        ageMins: u.ageMins !== undefined ? u.ageMins : u.stale ? 999 : 0,
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
    uiArchive: async (profileDir) => {
      events.push(`uiarchive:${profileDir}`)
      return over.uiClick ?? { clicked: true, verified: true }
    },
    liveNow: () => over.liveNow ?? false,
    stage: (o) => {
      staged.push({ sessionId: o.sessionId, prompt: o.prompt, instanceRef: o.instanceRef })
    },
    openWaitMs: 5000,
    sleep: async () => {},
    now: () => (t += 100),
  }
  return { deps, events, staged }
}

const fresh = (ref: string, weeklyPct: number, sessionPct = 0) => ({
  ref,
  weeklyPct,
  sessionPct,
  stale: false,
})

// 'running' is no longer one state. A chat mid-turn is untouchable; a chat whose process is
// alive but which has been QUIET past the in-flight window is idle, and idle is waiting - the
// sweep has routed those to the judgment lane since 9bed808, and the act path refusing them was
// the two halves disagreeing (a peer could see the lane and could not act on it).
test('running and mid-turn -> left alone', async () => {
  const { deps, events } = fixture({
    gate: gateOf({ state: 'running', live: { pid: 7, name: 'x' }, quietSecs: 0 }),
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('left-alone')
  expect(r?.why).toContain('in-flight window')
  expect(events).toEqual([])
})

test('running but STUCK -> left alone; a person must look, automation does not touch it', async () => {
  const { deps, events } = fixture({
    gate: gateOf({
      state: 'running',
      live: { pid: 7, name: 'x' },
      quietSecs: 9_000,
      stalled: { tool: 'Bash', quietSecs: 9_000, why: 'a shell command nobody approved' },
    }),
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('left-alone')
  expect(r?.why).toContain('STUCK')
  expect(events).toEqual([])
})

test('running but long QUIET -> actionable: it is waiting, and the answer is staged for it', async () => {
  const { deps } = fixture({
    gate: gateOf({ state: 'running', live: { pid: 7, name: 'x' }, quietSecs: 9_000 }),
  })
  // Without an answer it PARKS rather than pretending a decision was made.
  const parked = await actOnGate('sid', {}, deps)
  expect(parked?.action).toBe('parked')
  const acted = await actOnGate('sid', { decision: 'autonomous', answer: 'carry on' }, deps)
  expect(acted?.action).toBe('surfaced')
  expect(acted?.prompt).toBe('carry on')
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

test("archive-candidate under a RUNNING app -> the server clicks the app's own Archive (owner: yes)", async () => {
  const { deps, events } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('archived')
  expect(r?.archived?.durable).toBe(true)
  expect(r?.why).toContain('own Archive was clicked')
  expect(events).toEqual(['archive:sid:true', 'uiarchive:C:/i1'])
})

test('a profile the fleet does NOT manage (the default APPDATA install) gets the click attempt', async () => {
  // The default profile never carries --user-data-dir, so instance discovery cannot see it
  // (review-confirmed blind spot): the tool itself must answer whether that app is running.
  const { deps, events } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [
      { profile: 'C:/Users/x/AppData/Roaming/Claude', wasRunning: false, changed: true },
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.archived?.durable).toBe(true)
  expect(events).toContain('uiarchive:C:/Users/x/AppData/Roaming/Claude')
})

test('an UNCHANGED hit under a running app still gets the click - a re-act settles the row', async () => {
  // The flag can already sit on disk while the app still renders the chat (a prior act, or an
  // outside write). Running-ness comes from the live instance list, not the flag-write.
  const { deps, events } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i1', wasRunning: false, changed: false }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.archived?.durable).toBe(true)
  expect(events).toContain('uiarchive:C:/i1')
})

test('a UI click that cannot fire safely reports non-durable with the honest reason', async () => {
  const { deps } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
    uiClick: { clicked: false, verified: false, reason: 'rendered twice' },
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('archived')
  expect(r?.archived?.durable).toBe(false)
  expect(r?.why).toContain('rendered twice')
  expect(r?.why).toContain('next restart')
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
    usage: [
      fresh('desktop:C:/i1', 90),
      fresh('desktop:C:/i3', 88),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true },
    ],
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
    usage: [
      fresh('desktop:C:/i1', 50, 92),
      fresh('desktop:C:/i3', 40, 86),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true },
    ],
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

test('nothing open at all -> the best under-threshold closed account opens (owner ruling #2)', async () => {
  // Owner, 2026-08-30: "all closed fleets may open an account if a chat needs a home. just
  // make sure that it is underneath our threshold. preferably one of the lowest ones."
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
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(5)
  expect(events[0]).toBe('open:C:/i5')
})

test('all-closed but every candidate at/over threshold or unknown -> parks ("make sure")', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: null,
    instances: [
      { num: 2, dir: 'C:/i2', isRunning: false, signedIn: true },
      { num: 5, dir: 'C:/i5', isRunning: false, signedIn: true },
    ],
    // i2 is past the line, i5 has no reading at all - neither may be opened.
    usage: [{ ref: 'desktop:C:/i2', weeklyPct: 88, stale: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(events).toEqual([])
})

test('the account tier outranks usage: Max 20x is always preferred (owner ruling #3)', async () => {
  // Two RUNNING accounts: a Pro at 5% and a Max 20x at 80%. His words: "We always will prefer
  // the highest one. AKA Max 20x. and the lowest usage" - tier first, usage second.
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: null,
    instances: [
      { num: 1, dir: 'C:/i1', isRunning: true, signedIn: true, plan: 'Pro' },
      { num: 3, dir: 'C:/i3', isRunning: true, signedIn: true, plan: 'Max 20×' },
    ],
    usage: [fresh('desktop:C:/i1', 5), fresh('desktop:C:/i3', 80)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.instance?.num).toBe(3)
})

test('tier decides WHICH closed account an all-closed fleet opens', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: null,
    instances: [
      { num: 2, dir: 'C:/i2', isRunning: false, signedIn: true, plan: 'Max 20×' },
      { num: 5, dir: 'C:/i5', isRunning: false, signedIn: true, plan: 'Pro' },
    ],
    usage: [
      { ref: 'desktop:C:/i2', weeklyPct: 60, stale: true },
      { ref: 'desktop:C:/i5', weeklyPct: 15, stale: true },
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.instance?.num).toBe(2) // Max 20x at 60% beats Pro at 15%
  expect(events[0]).toBe('open:C:/i2')
})

test('a closed HOME that is itself at/over threshold (or unknown) parks - booting hits the wall', async () => {
  const saturated = [fresh('desktop:C:/i1', 90), fresh('desktop:C:/i3', 90)]
  const over = await actOnGate(
    'sid',
    {},
    fixture({
      gate: crashedGate('mid-turn'),
      home: 'C:/i2',
      usage: [...saturated, { ref: 'desktop:C:/i2', weeklyPct: 91, stale: true }],
    }).deps,
  )
  expect(over?.action).toBe('parked')
  expect(over?.why).toContain('hit the wall')
  const unknown = await actOnGate(
    'sid',
    {},
    fixture({ gate: crashedGate('mid-turn'), home: 'C:/i2', usage: saturated }).deps,
  )
  expect(unknown?.action).toBe('parked')
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
    usage: [
      fresh('desktop:C:/i1', 90),
      fresh('desktop:C:/i3', 90),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true },
    ],
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
    usage: [
      fresh('desktop:C:/i1', 90),
      fresh('desktop:C:/i3', 90),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true },
    ],
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

test('a session that turns LIVE mid-act skips the UI click - a person may be using it', async () => {
  const { deps, events } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
    liveNow: true,
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('archived')
  expect(r?.archived?.durable).toBe(false)
  expect(r?.why).toContain('became LIVE')
  expect(events).not.toContain('uiarchive:C:/i1')
})

test('isActBusy is true while any deed is queued or running - the relaunch guard reads it', async () => {
  const { deps } = fixture({
    gate: finishedGate('archive-candidate'),
    archiveHits: [{ profile: 'C:/i2', wasRunning: false, changed: true }],
  })
  const inner = deps.archive
  if (!inner) throw new Error('fixture always sets archive')
  let busyDuring = false
  deps.archive = async (sid, archived) => {
    busyDuring = isActBusy()
    return inner(sid, archived)
  }
  await actOnGate('sid', {}, deps)
  expect(busyDuring).toBe(true)
  expect(isActBusy()).toBe(false)
})

test('acts are serialized process-wide - two concurrent calls never interleave', async () => {
  const order: string[] = []
  const make = (tag: string) => {
    const { deps } = fixture({
      gate: finishedGate('archive-candidate'),
      archiveHits: [{ profile: 'C:/i2', wasRunning: false, changed: true }],
    })
    const inner = deps.archive
    if (!inner) throw new Error('fixture always sets archive')
    deps.archive = async (sid, archived) => {
      order.push(`start:${tag}`)
      await new Promise((res) => setTimeout(res, 5))
      const r = await inner(sid, archived)
      order.push(`end:${tag}`)
      return r
    }
    return deps
  }
  await Promise.all([actOnGate('s-a', {}, make('a')), actOnGate('s-b', {}, make('b'))])
  expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
})

test('LOAD BALANCING: a crashed chat on a provably saturated home migrates - LAND FIRST, flag second', async () => {
  // Home #1 is fresh-proven hot on the 5-hour window; #3 is fresh-proven cool. Nothing is
  // flagged until the new home EXISTS (review-confirmed: flag-first hid chats on failures).
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 10, 5)],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(3)
  expect(r?.why).toContain('migrated off its saturated home instance #1')
  expect(r?.why).not.toContain('WARNING')
  expect(events).toEqual(['import:C:/i3:A Real Name', 'archive:sid:true'])
})

test('LOAD BALANCING: no cooler taker means NOTHING is ever flagged - the chat surfaces at home', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 91)],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(1)
  expect(r?.why).toContain('no cooler account could take the chat')
  // Land-first: with no landing there is no flag write and nothing to restore.
  expect(events).toEqual(['import:C:/i1:A Real Name'])
})

test('LOAD BALANCING: a stale or unknown home reading never migrates - no moves on a guess', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [
      { ref: 'desktop:C:/i1', weeklyPct: 90, sessionPct: 90, stale: true },
      fresh('desktop:C:/i3', 5),
    ],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(1)
  expect(events).toEqual(['import:C:/i1:A Real Name'])
})

test('LOAD BALANCING: a failed landing owes ZERO cleanup - no flag was ever written', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 10)],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
    importOk: false,
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('surfacing at home also failed')
  expect(events).toEqual(['import:C:/i3:A Real Name', 'import:C:/i1:A Real Name'])
})

test('LOAD BALANCING: a source flag that fails to stick is a WARNING in the why, never hidden', async () => {
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 10)],
    // No archiveHits: the flag write reports ok:false (no-desktop-chat-found).
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(3)
  expect(r?.why).toContain('WARNING: the source entries could not be flagged')
  expect(events).toEqual(['import:C:/i3:A Real Name', 'archive:sid:true'])
})

test('LOAD BALANCING: an UNKNOWN target reading is not "cool" - migration demands positive proof', async () => {
  const { deps } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    // i3 is running but has NO usage row at all - unverified, not a migration target.
    usage: [fresh('desktop:C:/i1', 20, 86)],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(1)
  expect(r?.why).toContain('no cooler account could take the chat')
})

test('LOAD BALANCING: the only-open-home case may open a closed under-threshold account', async () => {
  // Home #1 is the ONLY running instance and it is saturated - the owner's overflow rule then
  // permits opening closed #2, which carries an aged under-threshold cache (the closed-app
  // proof standard). requireUnsaturated defers to that standard for mustOpen targets.
  const { deps, events } = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    instances: [
      { num: 1, dir: 'C:/i1', isRunning: true, signedIn: true },
      { num: 2, dir: 'C:/i2', isRunning: false, signedIn: true },
    ],
    usage: [
      fresh('desktop:C:/i1', 20, 86),
      { ref: 'desktop:C:/i2', weeklyPct: 20, stale: true, ageMins: 999 },
    ],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(2)
  expect(r?.openedInstance).toBe(true)
  expect(events).toEqual(['open:C:/i2', 'import:C:/i2:A Real Name', 'archive:sid:true'])
})

test('superseded outranks the usage wall - no resumeAt promise for a retired lineage', async () => {
  const { deps } = fixture({
    gate: crashedGate('usage-limit'),
    superseded: true,
    pinnedRef: 'desktop:C:/i1',
    usage: [{ ref: 'desktop:C:/i1', weeklyPct: 100, weeklyResetsAt: '2026-09-03T07:00:00Z' }],
  })
  const r = await actOnGate('sid', {}, deps)
  expect(r?.action).toBe('parked')
  expect(r?.why).toContain('superseded')
  expect(r?.resumeAt).toBeUndefined()
})

test('an autonomous ANSWER rides the same balancing branch as a crash resume', async () => {
  const { deps } = fixture({
    gate: finishedGate('needs-input-review'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 10)],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  const r = await actOnGate('sid', { decision: 'autonomous', answer: 'Yes - proceed.' }, deps)
  expect(r?.action).toBe('surfaced')
  expect(r?.instance?.num).toBe(3)
  expect(r?.prompt).toBe('Yes - proceed.')
  expect(r?.why).toContain('migrated off its saturated home')
})

test('every surfaced result STAGES its prompt in the delivery ledger', async () => {
  const home = fixture({ gate: crashedGate('mid-turn'), home: 'C:/i1' })
  await actOnGate('sid', {}, home.deps)
  expect(home.staged).toEqual([
    { sessionId: 'sid', prompt: resumeNotice('mid-turn'), instanceRef: 'desktop:C:/i1' },
  ])

  // The migration path stages too, pointed at the NEW home.
  const mig = fixture({
    gate: crashedGate('mid-turn'),
    home: 'C:/i1',
    usage: [fresh('desktop:C:/i1', 20, 86), fresh('desktop:C:/i3', 10, 5)],
    archiveHits: [{ profile: 'C:/i1', wasRunning: true, changed: true }],
  })
  await actOnGate('sid', {}, mig.deps)
  expect(mig.staged[0]?.instanceRef).toBe('desktop:C:/i3')

  // Parked and left-alone results stage NOTHING.
  const parked = fixture({ gate: crashedGate('mid-turn'), home: 'C:/i1', title: null })
  await actOnGate('sid', {}, parked.deps)
  expect(parked.staged).toEqual([])
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
  // The closed candidate carries an aged cache (ageMins past the 5h window): threshold-proven.
  const closedRow = { ref: 'desktop:C:/i2', weeklyPct: 5, stale: true, ageMins: 999 }
  const below = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 84.9), closedRow],
  )
  expect(below?.mustOpen).toBe(false)
  const at = pickLandingInstance(
    null,
    [inst(1, true), inst(2, false)],
    [fresh('desktop:C:/i1', 85), closedRow],
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
  // All-closed counts as eligible (owner ruling #2); underLandingThreshold guards the boot.
  expect(closedLandingEligible([], [])).toBe(true)
  expect(closedLandingEligible([{ ref: 'desktop:C:/i1' }], [fresh('desktop:C:/i1', 85)])).toBe(true)
  expect(closedLandingEligible([{ ref: 'desktop:C:/i1' }], [fresh('desktop:C:/i1', 10, 85)])).toBe(
    true,
  )
})

test('underLandingThreshold: PROOF on both windows - unknown is never "made sure"', () => {
  expect(underLandingThreshold(undefined)).toBe(false)
  expect(underLandingThreshold({ ref: 'r', weeklyPct: null, stale: true, ageMins: 999 })).toBe(
    false,
  )
  expect(underLandingThreshold({ ref: 'r', weeklyPct: 85, stale: true, ageMins: 999 })).toBe(false)
  // Session proof, way one: a reading older than the 5-hour window itself - that window has
  // provably reset (the normal state of a closed app's cache).
  expect(underLandingThreshold({ ref: 'r', weeklyPct: 84.9, stale: true, ageMins: 999 })).toBe(true)
  // Session proof, way two: a known session reading under the line.
  expect(
    underLandingThreshold({ ref: 'r', weeklyPct: 40, sessionPct: 20, stale: false, ageMins: 0 }),
  ).toBe(true)
  // No proof either way (recent reading, session unknown) -> no boot (review-confirmed).
  expect(
    underLandingThreshold({ ref: 'r', weeklyPct: 40, sessionPct: null, stale: false, ageMins: 30 }),
  ).toBe(false)
  expect(underLandingThreshold({ ref: 'r', weeklyPct: 10, sessionPct: 90, stale: false })).toBe(
    false,
  )
})

test('planRank pins the owner tier order, both x and the display ×', () => {
  expect(planRank('Max 20×')).toBe(4)
  expect(planRank('Max 20x')).toBe(4)
  expect(planRank('Max 5×')).toBe(3)
  expect(planRank('Max')).toBe(2)
  expect(planRank('Pro')).toBe(1)
  expect(planRank('Free')).toBe(0)
  expect(planRank('Team')).toBe(0)
  expect(planRank(null)).toBe(0)
})
