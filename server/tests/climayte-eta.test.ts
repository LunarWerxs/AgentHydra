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
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteJournal,
  climayteJournalLines,
  climayteList,
  climayteReports,
  climayteRun,
  climayteScorecard,
  climayteStopHook,
  climayteWait,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { registerStopHookRoute } from '../src/climayte-ask-mcp'
import { workers } from '../src/climayte-core'
import {
  type CliMayteEta,
  ETA_MIN_SAMPLES,
  type EtaSample,
  etaCalibration,
  etaFullOfEvent,
  etaNote,
  etaOfEvent,
  etaSamples,
  etaTookSeconds,
  parseEta,
  parseEtaFull,
  parseReview,
  reviewQuestion,
  stopDecision,
  stripReview,
} from '../src/climayte-eta'
import {
  allEtaSamples,
  appendEtaRow,
  etaReport,
  readEtaRows,
  resetEtaLedgerCache,
  samplesOfRows,
  settledRow,
} from '../src/climayte-eta-ledger'
import { cliArgv } from '../src/climayte-launch'
import { type CliMayteWorker, classifyAttempt, WORKER_BRIEF } from '../src/climayte-lib'
import { workerHooks } from '../src/climayte-signal'

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

const say = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})

describe('the exact words of an estimate', () => {
  test('the whole line and the text block it was in are kept, cut at their limits', () => {
    const got = etaFullOfEvent(
      say('Reading the code first.\n**ETA:** ~12 minutes (tests included)\nStarting.'),
    )
    expect(got).toMatchObject({ minutes: 12, line: '**ETA:** ~12 minutes (tests included)' })
    expect(got?.text).toContain('Reading the code first.')
    expect(parseEtaFull('ETA: 5 min')).toEqual({ minutes: 5, line: 'ETA: 5 min' })
    expect(parseEtaFull(`ETA: 5 min ${'x'.repeat(400)}`)?.line).toHaveLength(300)
    expect(etaFullOfEvent(say(`ETA: 5 min\n${'y'.repeat(3000)}`))?.text).toHaveLength(2000)
  })
})

describe('the review answer', () => {
  test('two lines parse; an unknown cause is other with the word kept; no review line is null', () => {
    expect(
      parseReview('ETA-REVIEW: The tests were slow; I would say 20 min.\nCAUSE: slow-commands'),
    ).toEqual({ why: 'The tests were slow; I would say 20 min.', cause: 'slow-commands' })
    expect(parseReview('ETA-REVIEW: x\n**CAUSE:** Padding.')?.cause).toBe('padding')
    expect(parseReview('ETA-REVIEW: x\nCAUSE: vibes')).toEqual({
      why: 'x',
      cause: 'other',
      raw: 'vibes',
    })
    expect(parseReview('CAUSE: padding')).toBeNull()
    expect(stripReview('ETA-REVIEW: x\nCAUSE: other')).toBe('')
    expect(stripReview('Done: it works.\n\nETA-REVIEW: x\nCAUSE: other')).toBe('Done: it works.')
  })

  test('a review message never becomes the report', () => {
    const events = [
      say('Report: the change is committed as abc123.'),
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: `Stop hook feedback:\n${reviewQuestion({ minutes: 5 }, 1800)}` },
          ],
        },
      },
      say('ETA-REVIEW: I padded it.\nCAUSE: padding'),
      {
        type: 'result',
        is_error: false,
        result: 'ETA-REVIEW: I padded it.\nCAUSE: padding',
        num_turns: 3,
      },
    ]
    const v = classifyAttempt(events, '', true)
    expect(v.outcome).toBe('done')
    expect(v.result).toBe('Report: the change is committed as abc123.')
    expect(v.turnTexts).toEqual(['Report: the change is committed as abc123.'])
    // Mixed with report text, only the review lines go.
    const mixed = classifyAttempt(
      [{ type: 'result', is_error: false, result: 'All done.\nETA-REVIEW: x\nCAUSE: other' }],
      '',
      true,
    )
    expect(mixed.result).toBe('All done.')
    expect(mixed.turnTexts).toEqual(['All done.'])
  })
})

describe('the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-eta-ledger-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const worker = (id: string, eta: CliMayteWorker['eta']) =>
    ({
      id,
      kind: 'code',
      model: 'sonnet',
      effort: 'medium',
      title: 'Example task',
      message: 'do the example',
      prompt: 'do the example',
      attempts: [{ account: { id: 'acct-1' }, startedAt: 0, endedAt: 1 }],
      eta,
    }) as unknown as CliMayteWorker

  test('rows round-trip, calibration reads them with the worker gone, and a live copy counts once', () => {
    const path = join(dir, 'eta.jsonl')
    for (let i = 0; i < 5; i++) {
      const eta = {
        minutes: 10,
        at: 1_000 * i,
        attempt: 0,
        tookS: 1200,
        doneAt: 1_000 * i + 5,
        line: 'ETA: 10 min',
      }
      appendEtaRow(settledRow(worker(`w-${i}`, eta), eta), path)
    }
    appendEtaRow(
      {
        t: 'review',
        id: 'w-4',
        saidAt: 4_000,
        at: 4_100,
        why: 'slow tests',
        cause: 'slow-commands',
      },
      path,
    )
    resetEtaLedgerCache()
    const rows = readEtaRows(path)
    expect(rows.map((r) => r.t)).toEqual([
      'settled',
      'settled',
      'settled',
      'settled',
      'settled',
      'review',
    ])
    expect(rows[0]).toMatchObject({
      ratio: 2,
      bucket: 'under',
      wallS: 0,
      attempts: 1,
      moves: 0,
      line: 'ETA: 10 min',
    })
    // No worker on record any more: the samples are all still there.
    const gone = allEtaSamples([], path)
    expect(gone).toHaveLength(5)
    expect(etaCalibration(gone, 'code')).toMatchObject({ samples: 5, ratio: 2 })
    expect(gone.find((s) => s.id === 'w-4')?.review?.cause).toBe('slow-commands')
    // Two of them are also still on a worker: nothing is counted twice.
    const live = ['w-3', 'w-4'].map((id, i) =>
      worker(id, {
        minutes: 10,
        at: 1_000 * (3 + i),
        attempt: 0,
        tookS: 1200,
        doneAt: 1_000 * (3 + i) + 5,
      }),
    )
    expect(allEtaSamples(live, path)).toHaveLength(5)
    expect(samplesOfRows(rows)).toHaveLength(5)
  })

  test('only the tail is read, and a cut first line is dropped', () => {
    const path = join(dir, 'big.jsonl')
    for (let i = 0; i < 50; i++) {
      const eta = { minutes: 5, at: i, attempt: 0, tookS: 300, doneAt: i + 1 }
      appendEtaRow(settledRow(worker(`w-${i}`, eta), eta), path)
    }
    resetEtaLedgerCache()
    const rows = readEtaRows(path, 2_000)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(50)
    expect(rows.at(-1)?.id).toBe('w-49')
  })

  test('the report lists recent samples and the causes of the newest reviews', () => {
    const mk = (i: number, tookMin: number, cause?: string): EtaSample => ({
      ...sample('code', 10, tookMin, 100 - i),
      title: `t${i}`,
      line: 'ETA: 10 min',
      wallS: 99,
      ...(cause ? { review: { why: `because ${cause}`, cause } } : {}),
    })
    const samples = [
      mk(0, 30, 'padding'),
      mk(1, 25, 'padding'),
      mk(2, 2, 'scope-smaller'),
      mk(3, 10),
    ]
    const rep = etaReport(samples)
    expect(rep.recent[0]).toMatchObject({
      minutes: 10,
      tookMin: 30,
      wallMin: 1.7,
      ratio: 3,
      bucket: 'under',
      cause: 'padding',
    })
    expect(rep.recent[3]).toMatchObject({ bucket: 'close', cause: null, why: null })
    expect(rep.causes).toEqual([
      { cause: 'padding', n: 2, medianRatio: 2.75 },
      { cause: 'scope-smaller', n: 1, medianRatio: 0.2 },
    ])
  })
})

describe('the brief learns why', () => {
  const reviewed = (cause: string, why: string, i: number): EtaSample => ({
    ...sample('code', 10, 30, 100 - i),
    review: { why, cause },
  })

  test('under three reviews the note is the ratio sentence alone', () => {
    const s = [
      ...Array.from({ length: 5 }, (_, i) => sample('code', 10, 30, i)),
      reviewed('padding', 'x', 9),
    ]
    expect(etaNote(etaCalibration(s, 'code'), s)).toBe(etaNote(etaCalibration(s, 'code')))
  })

  test('from three it names the most common cause and quotes the newest, within 450 chars', () => {
    const long = 'The commands were slow. '.repeat(20)
    const s = [
      reviewed('slow-commands', long, 0),
      reviewed('padding', 'I padded.', 1),
      reviewed('slow-commands', 'older words', 2),
      reviewed('slow-commands', 'oldest', 3),
      sample('code', 10, 30, 50),
    ]
    const note = etaNote(etaCalibration(s, 'code'), s) ?? ''
    expect(note).toContain(
      'Most common reason an estimate missed: slow-commands (3 of 4); newest: "The commands were slow.',
    )
    expect(note).not.toContain('older words')
    expect(note.length).toBeLessThanOrEqual(450)
    expect(note).toStartWith('Calibrate your ETA: over the last 5 code tasks')
  })
})

describe('the Stop hook decision', () => {
  const eta = (over: Partial<CliMayteEta> = {}): CliMayteEta => ({
    minutes: 10,
    at: 0,
    attempt: 0,
    line: 'ETA: 10 min',
    ...over,
  })
  const ask = (
    e: CliMayteEta | undefined,
    tookS: number | null,
    over: { stopHookActive?: boolean; asking?: boolean } = {},
  ) => stopDecision({ eta: e, tookS, stopHookActive: false, asking: false, ...over })

  test('blocks only a miss beyond 1.5x either way, with the exact words and numbers', () => {
    expect(ask(eta(), 600)).toBeNull() // right
    expect(ask(eta(), 840)).toBeNull() // 1.4x
    expect(ask(eta(), 480)).toBeNull() // 0.8x
    expect(ask(eta(), 960)).toContain('The working time it took was 16 min, 1.6x the estimate.')
    const under = ask(eta(), 240) // 0.4x
    expect(under).toContain('Your estimate for this message was "ETA: 10 min" (10 min).')
    expect(under).toContain('4 min, 0.40x')
    expect(under).toContain('ETA-REVIEW: <why the estimate was off')
    expect(under).toContain('CAUSE: <one of human-pace, scope-smaller')
    expect(under).toContain('Your report above stands')
  })

  test('not without an open estimate, while a review is running, to ask, or twice', () => {
    expect(ask(undefined, 5000)).toBeNull()
    expect(ask(eta(), 5000, { stopHookActive: true })).toBeNull()
    expect(ask(eta(), 5000, { asking: true })).toBeNull()
    expect(ask(eta({ reviewAskedAt: 1 }), 5000)).toBeNull()
    expect(ask(eta({ tookS: 5000, doneAt: 1 }), 5000)).toBeNull()
  })

  test('the daemon settles the estimate at the hook, asks once, and never asks a chat', () => {
    const now = Date.now()
    const w = {
      id: 'w-stop-1',
      kind: 'code',
      status: 'running',
      title: 'Example task',
      prompt: 'p',
      message: 'p',
      attempts: [{ account: { id: 'a1' }, startedAt: now - 3_000_000, endedAt: null }],
      eta: { minutes: 10, at: now - 3_000_000, attempt: 0, line: 'ETA: 10 min' },
      pending: [],
      results: [],
    } as unknown as CliMayteWorker
    workers.set(w.id, w)
    try {
      expect(climayteStopHook('nope', {})).toEqual({})
      expect(climayteStopHook(w.id, { stop_hook_active: true })).toEqual({})
      w.question = { text: 'q?', at: now }
      expect(climayteStopHook(w.id, {})).toEqual({})
      delete w.question
      const out = climayteStopHook(w.id, {}) as { decision?: string; reason?: string }
      expect(out.decision).toBe('block')
      expect(out.reason).toContain('50 min, 5.0x')
      expect(w.eta?.tookS).toBeGreaterThanOrEqual(2999)
      expect(w.eta?.doneAt).toBeGreaterThanOrEqual(now)
      expect(w.eta?.reviewAskedAt).toBeDefined()
      expect(climayteStopHook(w.id, {})).toEqual({}) // once per message
      w.chat = true
      expect(climayteStopHook(w.id, {})).toEqual({})
    } finally {
      workers.delete(w.id)
    }
  })
})

describe('the Stop hook wiring', () => {
  test('an ordinary worker gets an http Stop hook at the daemon; without a url, none', () => {
    const on = workerHooks({
      signalFile: 'C:/x/s.json',
      claims: null,
      stopUrl: 'http://127.0.0.1:1/api/corch/stop/w-1',
    })
    expect(on.Stop).toEqual([
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:1/api/corch/stop/w-1', timeout: 10 }] },
    ])
    expect(workerHooks({ signalFile: 'C:/x/s.json', claims: null }).Stop).toBeUndefined()
  })

  test('the route answers the decision, and {} for an unknown worker or a body that is not JSON', async () => {
    const app = new Hono()
    registerStopHookRoute(app)
    const post = async (id: string, body: string) =>
      (await app.request(`/api/corch/stop/${id}`, { method: 'POST', body })).json()
    expect(await post('nobody', '{"stop_hook_active":false}')).toEqual({})
    expect(await post('nobody', 'not json')).toEqual({})
  })
})
