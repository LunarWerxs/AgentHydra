// web/src/lib/climayte-status.ts: why a task that already ran is queued again. The list row and the
// detail pane both print this note, and without it a task moving accounts after a limit looked like
// one that had never started (2026-09-30 UI review). One table: each row is a different reason.
import { expect, test } from 'bun:test'
import type { CliMayteAttemptOutcome, CliMayteWorkerView } from './api'
import { climayteQueuedNote } from './climayte-status'

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
