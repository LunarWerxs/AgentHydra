// web/src/lib/climayte-status.ts: why a task that already ran is queued again. The list row and the
// detail pane both print this note, and without it a task moving accounts after a limit looked like
// one that had never started (2026-09-30 UI review). One table: each row is a different reason.
//
// And a failed task's story (climayteFailedStory): what failed, how it got there, what happened next
// and the end result, which the list's hover and the detail pane both print (owner, 2026-10-02).
import { expect, test } from 'bun:test'
import { createI18n } from 'vue-i18n'
import climayte from '../i18n/locales/en/climayte'
import type { CliMayteAttemptOutcome, CliMayteVerdict, CliMayteWorkerView } from './api'
import {
  climayteFailedStory,
  climayteQueuedNote,
  climayteStoryLines,
  climayteVerdictMark,
} from './climayte-status'

const NOW = 1_000_000
type Attempt = CliMayteWorkerView['attempts'][number]
const ran = (outcome: CliMayteAttemptOutcome) => [{ outcome } as Attempt]

test.each<
  [string, Parameters<typeof climayteQueuedNote>[0], ReturnType<typeof climayteQueuedNote>]
>([
  ['never ran', { status: 'queued', attempts: [], notBefore: null, retries: 0 }, null],
  ['not queued', { status: 'running', attempts: ran('quota'), notBefore: null, retries: 0 }, null],
  [
    // The countdown wins over the last outcome, rounds up, and never says "retry 0".
    'waiting out a retry',
    { status: 'queued', attempts: ran('quota'), notBefore: NOW + 2_100, retries: 0 },
    { key: 'climayte.queuedRetry', values: { s: 3, n: 1 } },
  ],
  [
    'a retry time already passed',
    { status: 'queued', attempts: ran('transient'), notBefore: NOW - 1, retries: 2 },
    null,
  ],
  [
    'hit its limit',
    { status: 'queued', attempts: ran('quota'), notBefore: null, retries: 0 },
    { key: 'climayte.queuedLimit' },
  ],
  [
    'signed out',
    { status: 'queued', attempts: ran('auth'), notBefore: null, retries: 0 },
    { key: 'climayte.queuedSignedOut' },
  ],
  [
    'handed off',
    { status: 'queued', attempts: ran('handoff'), notBefore: null, retries: 0 },
    { key: 'climayte.queuedHandoff' },
  ],
  [
    'cut off by a restart',
    { status: 'queued', attempts: ran('interrupted'), notBefore: null, retries: 0 },
    { key: 'climayte.queuedRestart' },
  ],
  [
    // Only the LAST attempt explains the wait.
    'an earlier limit, then an error',
    {
      status: 'queued',
      attempts: [...ran('quota'), ...ran('error')],
      notBefore: null,
      retries: 0,
    },
    null,
  ],
])('a queued task says why it waits: %s', (_name, worker, note) => {
  expect(climayteQueuedNote(worker, NOW)).toEqual(note)
})

type StoryTask = Parameters<typeof climayteFailedStory>[0]
const failed = (over: Partial<StoryTask>): StoryTask => ({
  id: 'a',
  title: 'Guests tab on a phone',
  cwd: 'D:/work/studio',
  status: 'failed',
  error: null,
  attempts: [],
  pending: [],
  model: null,
  effort: null,
  createdAt: NOW,
  ...over,
})
const attempts = (...outcomes: CliMayteAttemptOutcome[]) => outcomes.flatMap(ran)
const verdict = (v: 'pass' | 'fail', by: CliMayteVerdict['by'], note: string | null = null) => ({
  at: NOW,
  verdict: v,
  note,
  model: null,
  effort: null,
  pct: null,
  by,
})
const NO_TRANSCRIPT =
  "This session's transcript was not found on the account it last ran on, so it cannot move to #84 Darragh (CLI) without losing its context. Start it again as a new task."
const NO_TRANSCRIPT_FIRST =
  "This session's transcript was not found on the account it last ran on, so it cannot move to #84 Darragh (CLI) without losing its context."

// The first three are failed tasks as they stood on 2026-10-02.
test.each<[string, StoryTask, StoryTask[], ReturnType<typeof climayteFailedStory>]>([
  [
    // The check's own fails are how it failed; the orchestrator's later pass is what came next.
    'the check gave up and the orchestrator accepted it',
    failed({
      error:
        'The check still failed after 3 rounds; it needs the orchestrator. Last: 2 findings left',
      attempts: attempts('done', 'done', 'done'),
      verdicts: [
        verdict('fail', 'check'),
        verdict('fail', 'check'),
        verdict('pass', 'orchestrator', 'Fixed by hand.\nSee the commit.'),
      ],
      judged: true,
    }),
    [],
    {
      what: {
        key: 'climayte.failedWhat',
        values: { error: 'The check still failed after 3 rounds; it needs the orchestrator.' },
      },
      how: [
        {
          key: 'climayte.failedAttempts',
          values: { n: 3 },
          counts: [{ n: 3, label: 'climayte.outcomeDone' }],
        },
      ],
      next: [
        { key: 'climayte.failedAcceptedOrchestrator' },
        { key: 'climayte.failedNote', values: { note: 'Fixed by hand.' } },
      ],
      end: { key: 'climayte.failedEndAccepted' },
    },
  ],
  [
    'its transcript was lost and nothing came after it',
    failed({ error: NO_TRANSCRIPT, attempts: attempts('handoff', 'quota', 'auth', 'auth') }),
    // A task with another title, and an older one with the same title, are not "started again".
    [
      failed({ id: 'b', title: 'Another task', createdAt: NOW + 1 }),
      failed({ id: 'c', createdAt: NOW - 1 }),
    ],
    {
      what: { key: 'climayte.failedWhat', values: { error: NO_TRANSCRIPT_FIRST } },
      how: [
        {
          key: 'climayte.failedAttempts',
          values: { n: 4 },
          counts: [
            { n: 2, label: 'climayte.outcomeAuth' },
            { n: 1, label: 'climayte.outcomeHandoff' },
            { n: 1, label: 'climayte.outcomeQuota' },
          ],
        },
      ],
      next: [{ key: 'climayte.failedNothingNext' }],
      end: { key: 'climayte.failedEndStill' },
    },
  ],
  [
    // A check's fail alone is not something that happened after the failure.
    'only its own check judged it',
    failed({ attempts: attempts('error'), verdicts: [verdict('fail', 'check')] }),
    [],
    {
      what: { key: 'climayte.failedNoReason' },
      how: [{ key: 'climayte.failedAttemptOne', keys: { outcome: 'climayte.outcomeError' } }],
      next: [{ key: 'climayte.failedNothingNext' }],
      end: { key: 'climayte.failedEndStill' },
    },
  ],
  [
    // The owner's thumbs-down sent it back and the rerun then failed: the verdict came BEFORE this
    // failure (the server's `judged` is false once an attempt starts after it), so it is not told
    // as what happened next.
    'a verdict that came before the last attempt',
    failed({
      error: NO_TRANSCRIPT,
      attempts: attempts('done', 'error'),
      verdicts: [verdict('fail', 'owner', 'The header still overlaps.')],
      judged: false,
    }),
    [],
    {
      what: { key: 'climayte.failedWhat', values: { error: NO_TRANSCRIPT_FIRST } },
      how: [
        {
          key: 'climayte.failedAttempts',
          values: { n: 2 },
          counts: [
            { n: 1, label: 'climayte.outcomeDone' },
            { n: 1, label: 'climayte.outcomeError' },
          ],
        },
      ],
      next: [{ key: 'climayte.failedNothingNext' }],
      end: { key: 'climayte.failedEndStill' },
    },
  ],
  [
    'started again on a different model, still running',
    failed({
      error: 'It ran out of turns.',
      attempts: attempts('error', 'error'),
      model: 'claude-sonnet-4-5',
      effort: 'high',
      auto: true,
    }),
    [
      failed({
        id: 'b',
        status: 'running',
        model: 'claude-opus-5-5',
        effort: 'max',
        createdAt: NOW + 1,
      }),
    ],
    {
      what: { key: 'climayte.failedWhat', values: { error: 'It ran out of turns.' } },
      how: [
        {
          key: 'climayte.failedAttempts',
          values: { n: 2 },
          counts: [{ n: 2, label: 'climayte.outcomeError' }],
        },
        {
          key: 'climayte.failedRanAuto',
          values: { model: 'Sonnet 4.5', effort: 'high' },
          keys: {},
        },
      ],
      next: [
        {
          key: 'climayte.failedRedoneOn',
          values: { model: 'Opus 5.5', effort: 'max' },
          keys: { status: 'climayte.statusRunning' },
        },
      ],
      end: { key: 'climayte.failedEndRedoActive' },
    },
  ],
])('a failed task tells its story: %s', (_name, task, others, story) => {
  expect(climayteFailedStory(task, [task, ...others])).toEqual(story)
})

test('a task that did not fail has no story', () => {
  expect(climayteFailedStory(failed({ status: 'done' }), [])).toBeNull()
})

// The words the owner reads, through the real catalog: a line's values must be the names its
// message uses, and the attempts are counted in the outcome labels, most frequent first.
test('the story reads as four plain lines', () => {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: { climayte } } })
  const task = failed({
    error: NO_TRANSCRIPT,
    attempts: attempts('done', 'handoff', 'handoff', 'quota', 'quota', 'auth'),
  })
  const story = climayteFailedStory(task, [task])
  if (!story) throw new Error('a failed task has a story')
  expect(climayteStoryLines(story, (key, values) => i18n.global.t(key, values))).toEqual([
    NO_TRANSCRIPT_FIRST,
    '6 attempts: 2 handed off, 2 hit its limit, 1 done, 1 signed out.',
    'Nothing has picked it up yet.',
    'End result: still failed.',
  ])
})

// The row's verdict mark. Ten running rows each showed a red cross after their own check said no
// (2026-10-02) and the list read as failed work: a failed verdict on a task still working is a retry.
test('a failed check on a task still working is a retry, on a stopped one a failure', () => {
  const checkFail = (note: string) => ({ verdict: 'fail', by: 'check', note }) as CliMayteVerdict
  const twice = [checkFail('first'), checkFail('The check `x` failed (exit 1).\nits output')]
  expect(climayteVerdictMark({ status: 'running', verdicts: twice })).toEqual({
    kind: 'retry',
    key: 'climayte.verdictRetryCheck',
    values: { n: 2 },
    note: 'The check `x` failed (exit 1).',
  })
  expect(climayteVerdictMark({ status: 'failed', verdicts: twice })?.kind).toBe('fail')
  const accepted = [
    ...twice,
    { verdict: 'pass', by: 'orchestrator', note: null } as CliMayteVerdict,
  ]
  expect(climayteVerdictMark({ status: 'failed', verdicts: accepted })).toMatchObject({
    kind: 'pass',
    key: 'climayte.verdictPassOrchestrator',
  })
  expect(climayteVerdictMark({ status: 'done', verdicts: [] })).toBeNull()
})

// Every recorder the server writes reads as a real line. The manager's `wave` verdicts had no key in
// these tables and the CliMayte list threw on each one (vue-i18n SyntaxError 17, 2026-10-04); a
// recorder this build does not know yet reads as plain "Passed" / "Failed".
test('a wave verdict and an unknown recorder both read as real lines', () => {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: { climayte } } })
  const robot = 'robot' as unknown as CliMayteVerdict['by']
  const marks = [
    climayteVerdictMark({ status: 'done', verdicts: [verdict('pass', 'wave')] }),
    climayteVerdictMark({ status: 'failed', verdicts: [verdict('fail', 'wave')] }),
    climayteVerdictMark({ status: 'running', verdicts: [verdict('fail', 'wave')] }),
    climayteVerdictMark({ status: 'done', verdicts: [verdict('pass', robot)] }),
    climayteVerdictMark({ status: 'failed', verdicts: [verdict('fail', robot)] }),
  ]
  for (const mark of marks) expect(i18n.global.te(mark?.key ?? '')).toBe(true)
  expect(marks[3]?.key).toBe('climayte.verdictPassed')
  for (const by of ['wave', robot] as const) {
    const task = failed({
      attempts: attempts('error'),
      verdicts: [verdict('fail', by)],
      judged: true,
    })
    const story = climayteFailedStory(task, [task])
    if (!story) throw new Error('a failed task has a story')
    expect(story.next.length).toBeGreaterThan(0)
    for (const line of story.next) expect(i18n.global.te(line.key)).toBe(true)
  }
})
