// server/tests/orchestrator-preempt.test.ts - "kill it and move it" must not need a taskkill.
//
// WHY (found live 2026-09-12, draining #8 to #36). A patient `move_chats` sat in stop-idle for
// its 300s wait. The owner said to kill it and move it, and the correct call - the SAME move
// with `terminate_live` - was refused `409 busy`, because this route is keyed by SCRIPT NAME and
// knows nothing about which chats either call names. The only way through was to find the
// engine's pid by hand and `taskkill /PID <pid> /T /F`, which is outside every rail these tools
// exist to provide, and the refused call's resume text was lost with it.
//
// So an incoming call carrying a person's `--terminate-live` may TAKE the route from a run whose
// chats it covers. Both halves are load-bearing and pinned here: without the person's word this
// is a race between two callers, and without the coverage rule a kill strands chats nobody is
// about to re-do (that is what orchestrator_cancel is for, deliberately).
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatScopeOf,
  mayPreempt,
  resetOrchestratorOperationsForTests,
  runOrchestrator,
  setPreemptWaitMsForTests,
  startOrchestratorOperation,
} from '../src/orchestrator'

function fakeOrchestratorDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-preempt-'))
  writeFileSync(join(dir, 'orch.py'), '# stub\n')
  return dir
}

/** Settles every holder a test left running. The in-flight lock is MODULE state shared by every
 *  test in this process, so a holder left pending would lock `migrate_batch` for the next test. */
const releases: Array<() => void> = []

/** A holder that never finishes on its own, and reports whether it was killed. */
function patientRun(dir: string, args: string[]) {
  const state = { killed: false }
  const { op, promise } = startOrchestratorOperation(
    { script: 'migrate_batch', args, timeoutMs: 600_000 },
    {
      deps: {
        dir,
        spawn: (_c, _d, _t, hooks) =>
          new Promise((resolve) => {
            const settle = () =>
              resolve({ code: null, stdout: '', stderr: 'killed', timedOut: false })
            releases.push(settle)
            hooks?.onProcess?.(() => {
              state.killed = true
              settle()
            })
          }),
      },
    },
  )
  releases.push(() => void promise)
  return { op, state, promise }
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Bun.sleep(20) // let each settled run's finally release its lock
  resetOrchestratorOperationsForTests()
})

test('chatScopeOf reads every --chat and the sweep flag, and normalizes what it read', () => {
  const scope = chatScopeOf(['--chat', ' Alpha ', '--chat', 'beta', '--to', '8'])
  expect([...scope.chats].sort()).toEqual(['alpha', 'beta'])
  expect(scope.sweeps).toBe(false)
  expect(chatScopeOf(['--all-unarchived', '--from', '56']).sweeps).toBe(true)
  // A --chat with no value is not a chat named "": it is a malformed call, and an empty entry
  // would make an unrelated batch look covered.
  expect(chatScopeOf(['--chat']).chats.size).toBe(0)
})

test('mayPreempt needs BOTH a person word and full coverage of what it would strand', () => {
  const held = ['--chat', 'alpha', '--to', '8']
  expect(mayPreempt(['--chat', 'alpha', '--terminate-live', '--to', '8'], held)).toBe(true)
  // The same call without the word is just a second caller, and must queue as it always did.
  expect(mayPreempt(['--chat', 'alpha', '--to', '8'], held)).toBe(false)
  // A superset covers it: everything the kill could strand, this call is about to do itself.
  expect(mayPreempt(['--chat', 'alpha', '--chat', 'beta', '--terminate-live'], held)).toBe(true)
  // A different chat does not, however urgent the caller is.
  expect(mayPreempt(['--chat', 'beta', '--terminate-live'], held)).toBe(false)
  // A batch that names chats this call does not: preempting would abandon them mid-move.
  expect(mayPreempt(['--chat', 'alpha', '--terminate-live'], [...held, '--chat', 'beta'])).toBe(
    false,
  )
  // Only a sweep covers a sweep, and a sweep does not cover a named archived chat.
  expect(mayPreempt(['--all-unarchived', '--terminate-live'], ['--all-unarchived'])).toBe(true)
  expect(mayPreempt(['--chat', 'alpha', '--terminate-live'], ['--all-unarchived'])).toBe(false)
  // A holder whose scope cannot be read is never preempted: unknown is not "covered".
  expect(mayPreempt(['--chat', 'alpha', '--terminate-live'], ['--to', '8'])).toBe(false)
})

test('terminate_live takes the route from a patient move of the SAME chat, and says so', async () => {
  const dir = fakeOrchestratorDir()
  const holder = patientRun(dir, ['--chat', 'alpha', '--to', '8'])
  await Bun.sleep(10)

  let ran = false
  const second = await runOrchestrator(
    {
      script: 'migrate_batch',
      args: ['--chat', 'alpha', '--terminate-live', '--force', '--to', '8'],
      timeoutMs: 600_000,
    },
    {
      dir,
      spawn: async () => {
        ran = true
        return { code: 0, stdout: '{"ok":true}', stderr: '', timedOut: false }
      },
    },
  )

  expect(holder.state.killed).toBe(true)
  expect(ran).toBe(true)
  expect('busy' in second && second.busy).toBeFalsy()
  // The caller is TOLD what it took the route from: a kill nobody can see is how 14 chats sat
  // half-moved for twenty minutes (see migrate_reconcile.py).
  expect('preempted' in second && second.preempted).toBe(holder.op.id)
})

test('a patient move of a DIFFERENT chat is still refused, with the remedy named', async () => {
  const dir = fakeOrchestratorDir()
  const holder = patientRun(dir, ['--chat', 'beta', '--to', '8'])
  await Bun.sleep(10)

  const second = await runOrchestrator(
    { script: 'migrate_batch', args: ['--chat', 'alpha', '--terminate-live'], timeoutMs: 600_000 },
    { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
  )

  expect(holder.state.killed).toBe(false)
  expect('busy' in second && second.busy).toBe(true)
  expect('error' in second && second.error).toContain(holder.op.id)
  expect('error' in second && second.error).toContain('orchestrator_cancel')
})

test('without the person word, the same call queues exactly as it always did', async () => {
  const dir = fakeOrchestratorDir()
  const holder = patientRun(dir, ['--chat', 'alpha', '--to', '8'])
  await Bun.sleep(10)

  const second = await runOrchestrator(
    { script: 'migrate_batch', args: ['--chat', 'alpha', '--to', '8'], timeoutMs: 600_000 },
    { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
  )

  expect(holder.state.killed).toBe(false)
  expect('busy' in second && second.busy).toBe(true)
})

/** A spawn for the INCOMING call's side: records every command, answers stage_reply with a row. */
function recordingSpawn(seen: string[][]) {
  return async (command: string[]) => {
    seen.push(command)
    const script = command[2]
    const stdout =
      script === 'stage_reply'
        ? JSON.stringify({ id: `del-${command[3]}`, reused: false })
        : '{"ok":true}'
    return { code: 0, stdout, stderr: '', timedOut: false }
  }
}

test('a REFUSED move stages its resume against each named chat, deduped', async () => {
  // found live 2026-09-12: the refusal was right, and the resume text died with it.
  const dir = fakeOrchestratorDir()
  const holder = patientRun(dir, ['--chat', 'beta', '--to', '8'])
  await Bun.sleep(10)
  const seen: string[][] = []

  const second = await runOrchestrator(
    {
      script: 'migrate_batch',
      args: ['--chat', 'alpha', '--chat', 'gamma', '--resume', 'four jobs were orphaned'],
      timeoutMs: 600_000,
    },
    { dir, spawn: recordingSpawn(seen) },
  )

  expect(holder.state.killed).toBe(false)
  expect('busy' in second && second.busy).toBe(true)
  const stages = seen.filter((c) => c[2] === 'stage_reply')
  expect(stages.map((c) => c[3]).sort()).toEqual(['alpha', 'gamma'])
  expect(stages[0]).toContain('--dedupe')
  expect(stages[0]?.[stages[0].indexOf('--text') + 1]).toBe('four jobs were orphaned')
  const staged = 'resumeStaged' in second ? second.resumeStaged : undefined
  expect(staged?.map((r) => r.id).sort()).toEqual(['del-alpha', 'del-gamma'])
})

test('the DETACHED path stages the resume too - the default move_chats takes', async () => {
  // REVIEW FINDING 2026-09-14: the first cut staged from the MCP tool, which never sees a refusal
  // that happens inside a detached operation - i.e. nearly every real call.
  const dir = fakeOrchestratorDir()
  patientRun(dir, ['--chat', 'beta', '--to', '8'])
  await Bun.sleep(10)
  const seen: string[][] = []

  const { promise } = startOrchestratorOperation(
    {
      script: 'migrate_batch',
      args: ['--chat', 'alpha', '--resume', 'carry on'],
      timeoutMs: 600_000,
    },
    { deps: { dir, spawn: recordingSpawn(seen) } },
  )
  const op = await promise
  const result = op.result as Record<string, unknown>
  expect(result.busy).toBe(true)
  expect((result.resumeStaged as Array<Record<string, unknown>>)[0]?.staged).toBe(true)
  expect(seen.some((c) => c[2] === 'stage_reply')).toBe(true)
})

test('a refusal with no resume stages nothing', async () => {
  const dir = fakeOrchestratorDir()
  patientRun(dir, ['--chat', 'beta', '--to', '8'])
  await Bun.sleep(10)
  const seen: string[][] = []
  const second = await runOrchestrator(
    { script: 'migrate_batch', args: ['--chat', 'alpha'], timeoutMs: 600_000 },
    { dir, spawn: recordingSpawn(seen) },
  )
  expect(seen).toHaveLength(0)
  expect('resumeStaged' in second).toBe(false)
})

test('a preempted holder that does not die in time is reported AS dying, not as healthy', async () => {
  // REVIEW FINDING 2026-09-14: a tree whose grandchild holds a pipe can outlast the wait, and the
  // ordinary refusal then said "wait for it, or orchestrator_cancel it" about a run this very call
  // had already cancelled - while nothing was moving the chats.
  const dir = fakeOrchestratorDir()
  const was = setPreemptWaitMsForTests(80)
  try {
    const killedButLingering = { killed: false }
    const { op } = startOrchestratorOperation(
      { script: 'migrate_batch', args: ['--chat', 'alpha'], timeoutMs: 600_000 },
      {
        deps: {
          dir,
          spawn: (_c, _d, _t, hooks) =>
            new Promise((resolve) => {
              // released by afterEach only: the kill below must NOT settle it
              releases.push(() => resolve({ code: null, stdout: '', stderr: '', timedOut: false }))
              hooks?.onProcess?.(() => {
                killedButLingering.killed = true // killed, but the promise does not settle
              })
            }),
        },
      },
    )
    await Bun.sleep(10)
    let started = false
    const second = await runOrchestrator(
      {
        script: 'migrate_batch',
        args: ['--chat', 'alpha', '--terminate-live'],
        timeoutMs: 600_000,
      },
      {
        dir,
        spawn: async () => {
          started = true
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    )
    expect(killedButLingering.killed).toBe(true)
    expect(started).toBe(false) // never two acting passes at once
    expect('busy' in second && second.busy).toBe(true)
    const error = 'error' in second ? second.error : ''
    expect(error).toContain('preempted by this call')
    expect(error).toContain(op.id)
    expect(error).not.toContain('wait for it, or stop it')
  } finally {
    setPreemptWaitMsForTests(was)
  }
})

test('a script with no chat scope is never preempted, whatever the incoming call carries', async () => {
  // Its own script name, and its lock is RELEASED at the end: the in-flight map is module state
  // shared by every test file in this process, so a holder left pending here would fail an
  // unrelated suite's "this script is busy" case instead (caught exactly that way, 2026-09-14).
  const dir = fakeOrchestratorDir()
  let release!: () => void
  const holds = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      release = () => resolve({ code: 0, stdout: '', stderr: '', timedOut: false })
    },
  )
  const first = runOrchestrator(
    { script: 'preempt_probe', args: ['--all'], timeoutMs: 600_000 },
    { dir, spawn: () => holds },
  )
  await Bun.sleep(10)

  const second = await runOrchestrator(
    { script: 'preempt_probe', args: ['--all', '--terminate-live'], timeoutMs: 600_000 },
    { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
  )
  // A sweep of a whole account has no chat scope to cover, so the coverage rule refuses it: the
  // route lock is not something a flag can simply push past.
  expect('busy' in second && second.busy).toBe(true)
  release()
  await first
})
