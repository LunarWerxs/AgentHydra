// server/tests/orchestrator-worklist.test.ts — the execution engine's contract, pinned.
//
// The whole point of the worklist (owner directive 2026-08-28) is that mechanical rules moved
// from prose into code. A prose rule drifts silently; a code rule that regresses must fail a
// test loudly. Each test here pins one rule that used to live in the rubric and once failed in
// the field: message composition (the acceptEdits deadlock), routing (the constructed-chat-id
// zero-for-four relay round; rung 1 booting the wrong account), verification (transcript
// movement, not self-report), and surface purity (a desktop thread never resumes in a terminal).

import { expect, test } from 'bun:test'
import { resumeSurfaceFor } from '../src/monitor'
import type { LiveSession } from '../src/orchestrator'
import {
  composeRevive,
  computeRoute,
  repoOccupied,
  transcriptMovedSince,
} from '../src/orchestrator-worklist'

const PROMPTS = {
  orphanRevive: '[orchestrator] Your process died mid-work. Resume from where you truly are.',
} as Record<string, string>

// --- composition ---------------------------------------------------------------------------------

test('a non-bypass chat gets the file-tools-only line composed in; a bypass chat does not', () => {
  // The acceptEdits import trap: a revived chat is one shell command away from a prompt nobody
  // can click. The rubric asked the reviewer to remember to append the line; now the composer
  // decides from the recorded permission mode and the reviewer cannot forget.
  const hobbled = composeRevive({
    prompts: PROMPTS,
    flavor: 'stranded',
    permissionMode: 'acceptEdits',
  })
  expect(hobbled).toContain('FILE TOOLS ONLY')
  const free = composeRevive({
    prompts: PROMPTS,
    flavor: 'stranded',
    permissionMode: 'bypassPermissions',
  })
  expect(free).not.toContain('FILE TOOLS ONLY')
})

test('a limit-reset revive uses the scheduled resume prompt, not the crash prompt', () => {
  const msg = composeRevive({
    prompts: PROMPTS,
    flavor: 'limit-reset',
    resumePrompt: 'Continue the migration from step 4.',
    permissionMode: 'bypassPermissions',
  })
  expect(msg).toContain('Continue the migration from step 4.')
  expect(msg).not.toContain('process died')
})

// --- routing -------------------------------------------------------------------------------------

function liveSession(overrides: Partial<LiveSession>): LiveSession {
  return {
    pid: 1,
    sessionId: 's-live',
    cwd: 'D:\\Repo',
    name: 'repo-aa',
    startedAt: Date.now() - 60_000,
    transcriptPath: null,
    ...overrides,
  }
}

test('a live awake target routes to a direct peer SendMessage with the registry name', () => {
  const now = Date.now()
  const live = [liveSession({ sessionId: 'target-1', name: 'connections-xy' })]
  const route = computeRoute({
    targetSessionId: 'target-1',
    reviewerSessionId: 'reviewer-1',
    message: 'hello',
    live,
    now,
  })
  expect(route.mode).toBe('direct-live')
  expect(route.step?.tool).toBe('SendMessage')
  // The address is the registry NAME, never a constructed id — the 0-of-4 relay round of
  // 2026-08-27 came from ids the rubric told the reviewer to build.
  expect(route.step?.args.to).toBe('connections-xy')
  expect(route.step?.args.message).toBe('hello')
})

test('a target with no desktop entry and no live process is honestly unreachable', () => {
  const route = computeRoute({
    targetSessionId: 'nowhere-1',
    reviewerSessionId: 'reviewer-1',
    message: 'hello',
    live: [],
  })
  expect(route.mode).toBe('none')
  expect(route.step).toBeUndefined()
  expect(route.whyNone).toContain('nothing to address')
})

// --- verification --------------------------------------------------------------------------------

test('transcriptMovedSince is false until an event lands AFTER delivery, then true', () => {
  // "Executed" stops being a self-report: the ledger only closes when the target's transcript
  // gained an event newer than the moment the step was handed out. Both seams injected so this
  // pins the comparison, not the store.
  const deliveredAt = '2026-08-28T20:00:00.000Z'
  const lookup = () => ({ path: 'fake.jsonl' })
  const tailAt = (iso: string | null) => () => ({ lastEventAt: iso })
  expect(transcriptMovedSince('s', deliveredAt, tailAt('2026-08-28T19:59:59.000Z'), lookup)).toBe(
    false,
  )
  expect(transcriptMovedSince('s', deliveredAt, tailAt(deliveredAt), lookup)).toBe(false)
  expect(transcriptMovedSince('s', deliveredAt, tailAt('2026-08-28T20:00:05.000Z'), lookup)).toBe(
    true,
  )
  expect(transcriptMovedSince('s', deliveredAt, tailAt(null), lookup)).toBe(false)
  // A session with no transcript at all can never verify - honest false, never a stall.
  expect(
    transcriptMovedSince('s', deliveredAt, tailAt('2026-08-28T21:00:00.000Z'), () => null),
  ).toBe(false)
})

// --- one chat per repo ---------------------------------------------------------------------------

test('a SINGLE live occupant blocks seeding into its repo - the collisions feed could not', () => {
  // The collisions feed only lists repos that already have TWO chats, so it can never veto
  // adding the second one - the exact clobber the rule exists to prevent (found by review).
  // repoOccupied asks the live registry directly.
  const live = [liveSession({ sessionId: 'occ-1', name: 'repo-occupant', cwd: 'D:\\FakeRepoX' })]
  expect(repoOccupied('D:\\FakeRepoX', live)).toBe('repo-occupant')
  // Case-insensitive path identity, same as every other path comparison in the daemon.
  expect(repoOccupied('d:\\fakerepox\\', live)).toBe('repo-occupant')
  expect(repoOccupied('D:\\OtherRepo', live)).toBeNull()
})

// --- surface purity ------------------------------------------------------------------------------

test('a thread living in a desktop app resumes NATIVELY even when handoffSurface says terminal', () => {
  // The cross-contamination hole: handoffSurface is a preference about NEW work, but it used to
  // route EXISTING desktop threads into terminal windows. Desktop stays desktop.
  expect(resumeSurfaceFor('terminal', 'desktop:C:\\x', true)).toBe('native')
  expect(resumeSurfaceFor('queue', null, true)).toBe('native')
  // A thread with no desktop home keeps the old policy.
  expect(resumeSurfaceFor('terminal', 'desktop:C:\\x', false)).toBe('terminal')
  expect(resumeSurfaceFor('desktop', 'desktop:C:\\x', false)).toBe('native')
  expect(resumeSurfaceFor('desktop', null, false)).toBe('terminal')
})
