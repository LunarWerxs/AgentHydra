// server/tests/prestart.test.ts - the pre-start check pinned: census order, the one-instance
// sanity rail (owner: "if it only sees one instance open. then it's wrong"), the read-only
// pure-report sweep, next-step derivation per lane, and the junk lists.
import { expect, test } from 'bun:test'
import type { SweepReport } from '../src/gate-sweep'
import { type PrestartDeps, prestartCheck } from '../src/prestart'

const emptySweep = (over: Partial<SweepReport> = {}): SweepReport => ({
  scanned: 0,
  leftAlone: 0,
  acted: { archived: 0, surfaced: 0 },
  caps: { maxArchive: 0, maxSurface: 0 },
  archiveRows: [],
  crashedRows: [],
  waitForReset: [],
  needsJudgment: [],
  stalled: [],
  ungated: [],
  unswept: [],
  deadlineHit: false,
  ...over,
})

function deps(over: {
  open?: number
  sweep?: SweepReport
  marked?: string[]
  meta?: Array<{ key: string; title?: string | null; archived?: boolean; cliSessionId?: string }>
}): { d: PrestartDeps; sweepCaps: Array<{ maxArchive?: number; maxSurface?: number }> } {
  const sweepCaps: Array<{ maxArchive?: number; maxSurface?: number }> = []
  const openCount = over.open ?? 3
  const d: PrestartDeps = {
    instancesList: async () =>
      Array.from({ length: 4 }, (_, i) => ({
        num: i + 1,
        name: `i${i + 1}`,
        label: null,
        dir: `C:/i${i + 1}`,
        ref: `desktop:C:/i${i + 1}`,
        isRunning: i < openCount,
        pid: null,
        loginUuid: 'u',
        signedIn: true,
        account: { status: 'ok' as never, email: null, planLabel: 'Max 20×', accountUuid: null },
      })),
    usageList: () => [],
    sweep: async (opts = {}) => {
      sweepCaps.push({ maxArchive: opts.maxArchive, maxSurface: opts.maxSurface })
      return over.sweep ?? emptySweep()
    },
    doneMarked: () =>
      new Map((over.marked ?? []).map((id) => [id, Date.parse('2026-08-29T13:00:00Z')])),
    meta: () =>
      new Map(
        (over.meta ?? []).map((m) => [
          m.key,
          {
            archived: m.archived ?? false,
            title: m.title ?? null,
            instance: 'i1',
            path: `P:${m.key}`,
            cliSessionId: m.cliSessionId ?? null,
          },
        ]),
      ),
  }
  return { d, sweepCaps }
}

test('the sanity rail: one open instance is WRONG by the owner word; two is plausible', async () => {
  const one = await prestartCheck(deps({ open: 1 }).d)
  expect(one.sanity.plausible).toBe(false)
  expect(one.sanity.why).toContain('never runs just one')
  const zero = await prestartCheck(deps({ open: 0 }).d)
  expect(zero.sanity.plausible).toBe(false)
  const two = await prestartCheck(deps({ open: 2 }).d)
  expect(two.sanity.plausible).toBe(true)
})

test('the chat sweep runs as a PURE REPORT - caps 0/0, nothing acted', async () => {
  const { d, sweepCaps } = deps({})
  await prestartCheck(d)
  expect(sweepCaps).toEqual([{ maxArchive: 0, maxSurface: 0 }])
})

test('next steps are derived per lane, in the stated vocabulary', async () => {
  const row = (sessionId: string) => ({
    sessionId,
    title: null,
    instance: 'i1',
    state: 'finished' as const,
    crashedKind: null,
    lane: null,
    action: 'report-only' as const,
    why: 'x',
  })
  const { d } = deps({
    sweep: emptySweep({
      archiveRows: [row('a')],
      crashedRows: [{ ...row('c'), state: 'crashed', crashedKind: 'mid-turn' }],
      waitForReset: [{ ...row('w'), state: 'crashed', crashedKind: 'usage-limit' }],
      needsJudgment: [
        {
          sessionId: 'j',
          title: null,
          instance: 'i1',
          doneClaim: 'unknown',
          endsWithQuestion: true,
          lastAssistantText: 'evidence',
        },
      ],
      ungated: [{ sessionId: 'g', title: null, instance: 'i1' }],
    }),
  })
  const r = await prestartCheck(d)
  expect(r.nextSteps.map((s) => `${s.sessionId}:${s.step}`).sort()).toEqual([
    'a:archive',
    'c:surface-and-deliver',
    'g:investigate',
    'j:judge-then-act',
    'w:wait-for-reset',
  ])
})

test('junk: done-marked-but-visible and generic-titled chats are listed, archived ones are not', async () => {
  const { d } = deps({
    marked: ['dead1'],
    meta: [
      { key: 'dead1', title: 'Old handoff', cliSessionId: 'dead1' },
      { key: 'dead2', title: 'Already gone', archived: true, cliSessionId: 'dead2' },
      { key: 'gen1', title: 'General coding session', cliSessionId: 'gen1' },
      { key: 'fine', title: 'Real work chat', cliSessionId: 'fine' },
    ],
  })
  d.liveMap = () => new Map()
  const r = await prestartCheck(d)
  expect(r.junk.supersededVisible.map((x) => x.sessionId)).toEqual(['dead1'])
  expect(r.junk.genericTitled.map((x) => x.sessionId)).toEqual(['gen1'])
  expect(r.junk.liveButDoneMarked).toEqual([])
  expect(r.junk.identityUnresolvedCount).toBe(0)
})

test('an entry with NO recorded transcript id cannot be trusted by the junk checks - counted, never guessed', async () => {
  const { d } = deps({
    marked: ['mystery'],
    meta: [{ key: 'mystery', title: 'Old handoff' }], // cliSessionId null
  })
  d.liveMap = () => new Map()
  const r = await prestartCheck(d)
  expect(r.junk.supersededVisible).toEqual([])
  expect(r.junk.identityUnresolvedCount).toBe(1)
})

test('one transcript under two metadata files is junk-listed ONCE (two-set dedup)', async () => {
  const { d } = deps({
    marked: ['S'],
    meta: [
      { key: 'f1', title: 'Dup chat', cliSessionId: 'S' },
      { key: 'f2', title: 'Dup chat', cliSessionId: 'S' },
    ],
  })
  d.liveMap = () => new Map()
  const r = await prestartCheck(d)
  expect(r.junk.supersededVisible.map((x) => x.sessionId)).toEqual(['S'])
})

test('unswept (deadline-cut) chats get explicit investigate rows; a thrown sweep keeps the census', async () => {
  const { d } = deps({
    sweep: emptySweep({
      deadlineHit: true,
      unswept: [{ sessionId: 'late', title: 'Cut off', instance: 'i1' }],
    }),
  })
  const r = await prestartCheck(d)
  expect(r.nextSteps.map((s) => `${s.sessionId}:${s.step}`)).toEqual(['late:investigate'])

  const { d: d2 } = deps({})
  d2.sweep = async () => {
    throw new Error('sweep exploded')
  }
  const r2 = await prestartCheck(d2)
  expect(r2.sweepError).toContain('sweep exploded')
  expect(r2.instances.openCount).toBe(3) // the census survived
  expect(r2.sanity.plausible).toBe(true)
})

test('a done-marked chat that is LIVE is a named CONTRADICTION, never an archive candidate', async () => {
  // Found on the first live run: three retired lineages were actively running. The owner
  // untangles those - automation never archives under a running writer.
  const { d } = deps({
    marked: ['zombie'],
    meta: [{ key: 'zombie', title: 'Gods Eye View integration review', cliSessionId: 'zombie' }],
  })
  d.liveMap = () => new Map([['zombie', Date.parse('2026-08-30T01:15:00Z')]])
  const r = await prestartCheck(d)
  expect(r.junk.supersededVisible).toEqual([])
  expect(r.junk.liveButDoneMarked.map((x) => x.sessionId)).toEqual(['zombie'])
  // The decisive story: revived AFTER the mark (fixture mark 08-29 13:00, live 08-30 01:15).
  expect(r.junk.liveButDoneMarked[0]?.story).toBe('revived-after-mark')
  expect(r.junk.liveButDoneMarked[0]?.markedAt).toBe('2026-08-29T13:00:00.000Z')
})

test('a mark that landed on an already-running chat reads marked-while-live', async () => {
  const { d } = deps({
    marked: ['never-stopped'],
    meta: [
      {
        key: 'never-stopped',
        title: 'Leaky bucket and churn strategy',
        cliSessionId: 'never-stopped',
      },
    ],
  })
  // Live since BEFORE the fixture mark time (08-29 13:00): the mark landed on a running chat.
  d.liveMap = () => new Map([['never-stopped', Date.parse('2026-08-29T00:17:00Z')]])
  const r = await prestartCheck(d)
  expect(r.junk.liveButDoneMarked[0]?.story).toBe('marked-while-live')
})

test('the census reports open instances with plan and usage, and the totals', async () => {
  const r = await prestartCheck(deps({ open: 3 }).d)
  expect(r.instances.total).toBe(4)
  expect(r.instances.openCount).toBe(3)
  expect(r.instances.open[0]?.plan).toBe('Max 20×')
})

test('the health lane is fed the instance DIRECTORY, not the ref - the wiring itself is pinned', async () => {
  // The first live run reported all 18 instances as "never signed in", including one that was
  // open and answering, because prestart handed instance-health the `ref` ('desktop:<dir>' - a
  // vocabulary, not a path) so every config.json lookup missed. Every unit test underneath passed:
  // they are given a real directory, so only a test at THIS level can catch the wrong field.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const real = mkdtempSync(join(tmpdir(), 'agenthydra-prestart-'))
  writeFileSync(join(real, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'uuid-1' }))

  const { d } = deps({})
  d.instancesList = async () => [
    {
      num: 1,
      name: 'signed-in',
      label: null,
      dir: real,
      ref: `desktop:${real}`,
      isRunning: false,
      pid: null,
      loginUuid: 'uuid-1',
      signedIn: true,
      account: null,
    },
  ]
  // No `health` stub on purpose: the REAL collector must run, against the real directory.
  const report = await prestartCheck(d)
  expect(report.unusableInstances).toEqual([])
})

test('an instance with a DAMAGED profile is named as damaged, not as signed out', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const broken = mkdtempSync(join(tmpdir(), 'agenthydra-prestart-'))
  writeFileSync(join(broken, 'config.json'), '{ half-written')

  const { d } = deps({})
  d.instancesList = async () => [
    {
      num: 4,
      name: 'damaged',
      label: null,
      dir: broken,
      ref: `desktop:${broken}`,
      isRunning: false,
      pid: null,
      loginUuid: null,
      signedIn: false,
      account: null,
    },
  ]
  const report = await prestartCheck(d)
  expect(report.unusableInstances.map((h) => h.unusable?.reason)).toEqual(['profile-unreadable'])
  expect(report.unusableInstances[0]?.num).toBe(4)
})
