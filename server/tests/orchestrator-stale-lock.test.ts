// server/tests/orchestrator-stale-lock.test.ts — the in-flight lock must be able to go stale.
//
// WHY (owner, 2026-09-07): a migrate_batch died leaving no python process anywhere on the
// machine, and the retry still came back `409 already running (started 85s ago)`. The lock was
// only ever removed by the `finally` after the spawn promise settled, so a promise that never
// settles made it IMMORTAL - turning a crash into a hang, and reporting a dead run as healthy.
//
// The fix keys on a fact rather than a guess: every invocation carries a hard timeoutMs that
// realSpawn enforces by killing the child, so a lock outliving its own timeout cannot have a
// live run behind it. These tests pin both halves - a genuinely live run still blocks, and an
// orphaned one is reaped - plus the ABA hazard the reaping introduces.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestratorBusy, runOrchestrator } from '../src/orchestrator'

/** A directory that looks enough like the orchestrator for runOrchestrator to proceed. */
function fakeOrchestratorDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-stale-'))
  writeFileSync(join(dir, 'orch.py'), '# stub\n')
  return dir
}

const never = () => new Promise<never>(() => {})

test('a run whose spawn promise never settles still blocks a second caller while it is young', async () => {
  const dir = fakeOrchestratorDir()
  // Long timeout => the lock's deadline is far away => the run counts as genuinely live.
  void runOrchestrator({ script: 'migrate_batch', timeoutMs: 600_000 }, { dir, spawn: never })
  await Bun.sleep(10)

  const second = await runOrchestrator(
    { script: 'migrate_batch', timeoutMs: 600_000 },
    { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
  )
  expect('busy' in second && second.busy).toBe(true)
  expect(orchestratorBusy()).toBe(true)
})

test('a lock that outlived its own timeout is reaped, and the next run proceeds', async () => {
  const dir = fakeOrchestratorDir()
  // timeoutMs 1 => deadline is started + 0 + grace. Fake the clock past the grace instead of
  // waiting a real minute: the assertion is about the deadline rule, not about wall time.
  const realNow = Date.now
  void runOrchestrator({ script: 'reap_me', timeoutMs: 1 }, { dir, spawn: never })
  await Bun.sleep(10)

  try {
    const skew = realNow() + 61_000
    Date.now = () => skew
    let ran = false
    const second = await runOrchestrator(
      { script: 'reap_me', timeoutMs: 1 },
      {
        dir,
        spawn: async () => {
          ran = true
          return { code: 0, stdout: 'ok', stderr: '', timedOut: false }
        },
      },
    )
    expect('busy' in second && second.busy).toBeFalsy()
    expect(ran).toBe(true)
  } finally {
    Date.now = realNow
  }
})

test('reaping a stale lock also fires that run kill switch', async () => {
  const dir = fakeOrchestratorDir()
  const realNow = Date.now
  let killed = false
  void runOrchestrator(
    { script: 'kill_me', timeoutMs: 1 },
    {
      dir,
      spawn: (_c, _d, _t, hooks) => {
        hooks?.onProcess?.(() => {
          killed = true
        })
        return never()
      },
    },
  )
  await Bun.sleep(10)

  try {
    const skew = realNow() + 61_000
    Date.now = () => skew
    await runOrchestrator(
      { script: 'kill_me', timeoutMs: 1 },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
    )
    expect(killed).toBe(true)
  } finally {
    Date.now = realNow
  }
})

test('an abandoned run settling late must not release the lock a NEWER run now holds', async () => {
  // The hazard reaping introduces: once a stale entry can be replaced, the old promise's
  // `finally` would - with an unconditional delete keyed only on the script name - free the
  // successor's lock and let two acting passes overlap. Identity check, not name check.
  const dir = fakeOrchestratorDir()
  const realNow = Date.now
  let release!: () => void
  const stalls = new Promise<{
    code: number
    stdout: string
    stderr: string
    timedOut: boolean
  }>((resolve) => {
    release = () => resolve({ code: 0, stdout: '', stderr: '', timedOut: false })
  })

  const abandoned = runOrchestrator({ script: 'aba', timeoutMs: 1 }, { dir, spawn: () => stalls })
  await Bun.sleep(10)

  try {
    Date.now = () => realNow() + 61_000
    // Successor takes the key while the first is still unsettled, and holds it (long deadline).
    void runOrchestrator({ script: 'aba', timeoutMs: 600_000 }, { dir, spawn: never })
    await Bun.sleep(10)

    // Now the abandoned run finally settles. It must NOT drop the successor's lock.
    release()
    await abandoned
    await Bun.sleep(10)

    const third = await runOrchestrator(
      { script: 'aba', timeoutMs: 600_000 },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
    )
    expect('busy' in third && third.busy).toBe(true)
  } finally {
    Date.now = realNow
  }
})
