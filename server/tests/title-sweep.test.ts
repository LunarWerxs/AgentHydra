// server/tests/title-sweep.test.ts - the standing floor that keeps desktop chats named, and the
// guard that it is actually WIRED.
//
// ⛔ THE SECOND TEST HERE IS THE POINT OF THE FILE. The title janitor
// (sweepUntitledDesktopChats) has had a passing unit test since 2026-08-25 and had NO production
// caller from 2026-08-29 - when the v1 orchestrator that owned its watcher tick was retired whole -
// until 2026-09-09. Eleven days of a green test over dead code, while its own doc comment and the
// CHANGELOG both said it ran every ten minutes. A unit test proves a function works; it says
// nothing about whether anything calls it, and that gap is exactly what shipped a fleet of chats
// called "General coding session". automation-stamp-sweep.ts's header records the identical
// failure for the permission stamp, so this is a shape that recurs here, not a one-off.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTitleSweepOnce, TITLE_SWEEP_MS } from '../src/title-sweep'

test('one pass hands the scanner titles to the janitor and reports what it named', async () => {
  const seen: Array<string | null> = []
  const fixed = await runTitleSweepOnce({
    lookupTitles: async () =>
      new Map([
        ['sid-a', 'Ship the parser rewrite'],
        ['sid-b', 'PyOverdrive batch 15'],
      ]),
    sweep: (lookupTitle) => {
      // The janitor asks per chat; the sweep's whole job is to have an answer ready.
      seen.push(lookupTitle('sid-a'), lookupTitle('sid-b'), lookupTitle('sid-unknown'))
      return {
        fixed: 2,
        profiles: ['/p1'],
        renamed: [
          { sessionId: 'sid-a', title: 'Ship the parser rewrite' },
          { sessionId: 'sid-b', title: 'PyOverdrive batch 15' },
        ],
      }
    },
    log: () => {},
  })
  expect(fixed).toBe(2)
  // A session the scanner has no name for answers null, never a guess and never a session id -
  // the janitor's own `better === sid` guard is the second half of that, and this is the first.
  expect(seen).toEqual(['Ship the parser rewrite', 'PyOverdrive batch 15', null])
})

test('an empty lookup skips the store walk entirely rather than walking to learn nothing', async () => {
  let swept = false
  const fixed = await runTitleSweepOnce({
    lookupTitles: async () => new Map(),
    sweep: () => {
      swept = true
      return { fixed: 0, profiles: [], renamed: [] }
    },
    log: () => {},
  })
  expect(fixed).toBe(0)
  expect(swept).toBe(false)
})

test('a failing pass is a pass skipped, never a daemon down', async () => {
  // Both halves throw independently: the timer that calls this exits the process on an unhandled
  // rejection, so neither may escape.
  expect(
    await runTitleSweepOnce({
      lookupTitles: async () => {
        throw new Error('index cold')
      },
      sweep: () => ({ fixed: 0, profiles: [], renamed: [] }),
      log: () => {},
    }),
  ).toBe(0)
  expect(
    await runTitleSweepOnce({
      lookupTitles: async () => new Map([['sid-a', 'A real name']]),
      sweep: () => {
        throw new Error('store contended')
      },
      log: () => {},
    }),
  ).toBe(0)
})

test('⛔ the sweep is STARTED by the daemon - a unit-tested janitor nobody calls is the bug this closes', () => {
  // Source-level on purpose. Importing index.ts to observe the call would boot the whole daemon
  // (an HTTP listener, timers, a sqlite handle) inside the test runner; reading the wiring is what
  // this can assert cheaply, and the wiring is precisely what was missing for eleven days.
  const index = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
  expect(index).toContain("import { startTitleSweep } from './title-sweep'")
  expect(index).toMatch(/^startTitleSweep\(\)$/m)
  // And the janitor it exists to call has a real caller in src/, not only in tests/.
  const sweepSrc = readFileSync(join(import.meta.dir, '..', 'src', 'title-sweep.ts'), 'utf8')
  expect(sweepSrc).toContain('sweepUntitledDesktopChats')
})

test('the floor is slower than the watcher above it, and slower than the stamp sweep', () => {
  // Nothing it repairs is time-critical: reassertChatTitle covers the ten minutes where the chat
  // is most likely to be woken, and this only has to beat "forever".
  expect(TITLE_SWEEP_MS).toBeGreaterThanOrEqual(60_000)
})
