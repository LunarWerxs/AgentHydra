// server/tests/climayte-eta.test.ts — a worker's own time estimate against the time it took
// (climayte-eta.ts; docs/CLIMAYTE.md "Time estimates").
//
// Owner, 2026-10-05: workers say "estimated five minutes", and the prompt that asks for it gets
// better until the estimates are right. The pure parts are pinned first; then one real run on the
// fake CLI records an estimate, settles it and journals it, and the brief carries the calibration.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteJournal,
  climayteJournalLines,
  climayteList,
  climayteReports,
  climayteRun,
  climayteScorecard,
  climayteWait,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import {
  ETA_MIN_SAMPLES,
  type EtaSample,
  etaCalibration,
  etaNote,
  etaOfEvent,
  etaSamples,
  etaTookSeconds,
  parseEta,
} from '../src/climayte-eta'
import { cliArgv } from '../src/climayte-launch'
import { WORKER_BRIEF } from '../src/climayte-lib'

describe('parseEta', () => {
  test('reads the shapes a worker writes', () => {
    expect(parseEta('ETA: 5 min')).toBe(5)
    expect(parseEta('ETA: ~5 min\n\nStarting with the tests.')).toBe(5)
    expect(parseEta('**ETA:** 12 minutes')).toBe(12)
    expect(parseEta('- ETA about 3 mins')).toBe(3)
    expect(parseEta('ETA: 1h 20m')).toBe(80)
    expect(parseEta('ETA: 2 hours')).toBe(120)
    expect(parseEta('ETA: 5-10 min')).toBe(7.5)
    expect(parseEta('ETA: 5 to 10 minutes')).toBe(7.5)
    expect(parseEta('ETA: 8')).toBe(8)
    expect(parseEta('ETA: 90s')).toBe(1.5)
    expect(parseEta('I read the file first.\nETA: 4 min')).toBe(4)
  })

  test('only the amount right after ETA counts', () => {
    expect(parseEta('ETA: 5 min (the tests take 2)')).toBe(5)
    expect(parseEta('ETA: 1h 20 then a check')).toBe(60)
  })

  test('no ETA line, no amount, zero or past a day is no estimate', () => {
    expect(parseEta('This should take 5 min.')).toBeNull()
    expect(parseEta('ETA: soon')).toBeNull()
    expect(parseEta('ETA: 0 min')).toBeNull()
    expect(parseEta('ETA: 30 hours')).toBeNull()
    expect(parseEta('BETA: 5 min')).toBeNull()
  })
})

describe('etaOfEvent', () => {
  const text = (type: string, t: string) => ({
    type,
    message: { role: type, content: [{ type: 'text', text: t }] },
  })

  test("an assistant's text block is read; the prompt and a tool's output are not", () => {
    expect(etaOfEvent(text('assistant', 'ETA: 6 min'))).toBe(6)
    expect(etaOfEvent(text('user', 'ETA: 6 min'))).toBeNull()
    expect(
      etaOfEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ETA: 6 min' }] },
      }),
    ).toBeNull()
    expect(
      etaOfEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', input: { command: 'echo ETA: 6 min' } }] },
      }),
    ).toBeNull()
    expect(etaOfEvent({ type: 'result', result: 'ETA: 6 min' })).toBeNull()
  })
})

describe('etaTookSeconds', () => {
  test('the rest of the attempt it was said in, then later attempts whole; waits are not work', () => {
    const attempts = [
      { startedAt: 0, endedAt: 50_000 },
      { startedAt: 60_000, endedAt: 100_000 }, // said at 70 s: 30 s of this one counts
      { startedAt: 400_000, endedAt: 460_000 }, // after a 300 s wait for an account: 60 s
    ]
    expect(etaTookSeconds({ at: 70_000, attempt: 1 }, attempts, 999_000)).toBe(90)
    // A running last attempt counts up to now.
    expect(
      etaTookSeconds({ at: 10_000, attempt: 0 }, [{ startedAt: 0, endedAt: null }], 70_000),
    ).toBe(60)
  })
})

const sample = (kind: string | null, minutes: number, tookMin: number, doneAt: number) => ({
  id: `w-${doneAt}`,
  kind,
  minutes,
  tookS: tookMin * 60,
  doneAt,
})

describe('etaSamples and etaCalibration', () => {
  test('settled estimates only, the past ones too, newest first', () => {
    const got = etaSamples([
      {
        id: 'a',
        kind: 'code',
        eta: { minutes: 5, at: 0, attempt: 0, tookS: 600, doneAt: 30 },
        pastEtas: [{ minutes: 2, at: 0, attempt: 0, tookS: 60, doneAt: 10 }],
      },
      { id: 'b', eta: { minutes: 4, at: 0, attempt: 0 } }, // still running
      { id: 'c', kind: 'docs', eta: { minutes: 3, at: 0, attempt: 0, tookS: 90, doneAt: 20 } },
    ])
    expect(got.map((s) => [s.id, s.doneAt])).toEqual([
      ['a', 30],
      ['c', 20],
      ['a', 10],
    ])
    expect(got[1]?.kind).toBe('docs')
  })

  test('under the minimum there is nothing to say', () => {
    const few = Array.from({ length: ETA_MIN_SAMPLES - 1 }, (_, i) => sample('code', 5, 10, i))
    expect(etaCalibration(few, 'code')).toBeNull()
    expect(etaNote(etaCalibration(few, null))).toBeNull()
  })

  test("a kind's own samples once it has enough, else every kind's", () => {
    // Four code tasks ran twice their estimate; six docs tasks were right.
    const samples: EtaSample[] = [
      ...Array.from({ length: 4 }, (_, i) => sample('code', 5, 10, 100 + i)),
      ...Array.from({ length: 6 }, (_, i) => sample('docs', 4, 4, i)),
    ].sort((a, b) => b.doneAt - a.doneAt)
    const code = etaCalibration(samples, 'code')
    expect(code).toMatchObject({ kind: null, samples: 10 })
    const docs = etaCalibration(samples, 'docs')
    expect(docs).toEqual({ kind: 'docs', samples: 6, ratio: 1, low: 1, high: 1 })
    expect(etaCalibration(samples, null)?.kind).toBeNull()
  })

  test('the note says close, short or long, and by how much', () => {
    const run = (ratio: number) =>
      Array.from({ length: 5 }, (_, i) => sample('code', 10, 10 * ratio, i))
    const close = etaNote(etaCalibration(run(1.1), 'code'))
    expect(close).toStartWith('Your estimates have been close: over the last 5 code tasks')
    expect(close).toContain('Keep estimating the same way.')
    const short = etaNote(etaCalibration(run(2.4), 'code'))
    expect(short).toBe(
      'Calibrate your ETA: over the last 5 code tasks the real working time was a median 2.4x the estimate (half fell between 2.4x and 2.4x), so estimates have run short. Multiply your first guess by about 2.4 before you write it.',
    )
    const long = etaNote(etaCalibration(run(0.5), null))
    expect(long).toContain('over the last 5 tasks')
    expect(long).toContain('so estimates have run long. Multiply your first guess by about 0.50')
  })
})

describe('integration: a worker estimates, finishes, and the next brief is calibrated', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-eta-'))
  const cwd = join(root, 'work')
  const acct = join(root, 'acct-1')
  for (const d of [cwd, acct]) mkdirSync(d, { recursive: true })
  const seeded: string[] = []
  let group: string | null = null

  afterAll(() => {
    for (const id of seeded) workers.delete(id)
    if (group) climayteCancel({ group })
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the ETA line is recorded, settled when the turn ends done, and journalled', async () => {
    setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
    setCliMayteAccountsProvider(() => [
      { id: 'eta-1', num: 1, name: 'free', configDir: acct, sessionPct: 10, weekPct: 10 },
    ])
    startCliMayte()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'do the estimated task FAKE-ETA:3',
          cwd,
          title: 'estimated',
          kind: 'code',
          model: 'sonnet',
          effort: 'medium',
          ownerWords: 'one known setting',
        },
      ],
    })
    group = run.group
    const id = run.workers[0]?.id as string
    const deadline = Date.now() + 30_000
    let w = climayteList({ id })[0]
    while (w && w.status !== 'done' && w.status !== 'failed' && Date.now() < deadline) {
      await climayteWait({ id }, Math.min(5_000, deadline - Date.now()))
      w = climayteList({ id })[0]
    }
    expect(w?.status).toBe('done')

    const rec = workers.get(id)
    expect(rec?.eta).toMatchObject({ minutes: 3, attempt: 0 })
    expect(rec?.eta?.tookS).toBeGreaterThanOrEqual(0)
    expect(rec?.eta?.doneAt).toBe(rec?.attempts[0]?.endedAt as number)

    const detail = climayteReports({ id })[0]
    expect(detail?.etaMin).toBe(3)
    expect(typeof detail?.tookMin).toBe('number')
    expect(detail?.etaLeftMin).toBeUndefined()

    const done = climayteJournal({ id }).find((e) => e.event === 'done')
    expect(done).toMatchObject({ etaMin: 3 })
    expect(
      climayteJournalLines({ id }).some((l) => /estimated 3 min, took [\d.]+ min/.test(l)),
    ).toBe(true)

    // The worker brief the next launch gets: plain while there are fewer than 5 samples.
    const launches = readFileSync(join(acct, 'fake-launches.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(launches[0] ?? '{}').brief).toBe(WORKER_BRIEF)
    if (!rec) throw new Error('worker missing')
    expect(cliArgv(rec, 'sid', false, 'hooks.json', null).at(-1)).toBe(WORKER_BRIEF)

    // Five settled code estimates that each ran twice as long, plus the real one: the brief says by
    // how much.
    for (let i = 0; i < 5; i++) {
      const copy = structuredClone(rec)
      copy.id = `w-eta-seed-${i}`
      copy.eta = { minutes: 2, at: 0, attempt: 0, tookS: 240, doneAt: 1_000 + i }
      workers.set(copy.id, copy)
      seeded.push(copy.id)
    }
    const brief = cliArgv(rec, 'sid', false, 'hooks.json', null).at(-1) ?? ''
    expect(brief.startsWith(`${WORKER_BRIEF} Calibrate your ETA: over the last 6 code tasks`)).toBe(
      true,
    )
    expect(brief).toContain('Multiply your first guess by about 2.0 before you write it.')
    const card = climayteScorecard().estimates
    expect(card.byKind.find((c) => c.kind === 'code')?.samples).toBeGreaterThanOrEqual(6)
    expect(card.all?.samples).toBeGreaterThanOrEqual(6)
  }, 40_000)
})
