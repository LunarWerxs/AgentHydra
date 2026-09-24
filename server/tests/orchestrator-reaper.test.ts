// server/tests/orchestrator-reaper.test.ts — 2026-09-18: a run whose CHILD HAS EXITED must be
// reaped at once, and an operation must never poll `running` forever.
//
// THE INCIDENT. `move_chats {from:15, to:38, resume:"..."}` polled `status: 'running', result: null`
// until a person cancelled it, and so did a `courier --yes --only <id> --only <id>`. The operation
// records, once the cancel populated them, said the children had exited after 79 s and 15 s —
// `exitCode: 1` with BOTH streams empty. (The report's "65 minutes" was a mis-timed poll and is
// retracted: both runs were cancelled well inside their deadlines. What is real, and is what this
// file pins, is that a child which had FINISHED kept its operation reading `running`.) Two
// separate defects wearing one symptom:
//
//   1. THE PIPE, NOT THE PROCESS, DECIDED WHEN THE RUN WAS OVER. realSpawn awaited
//      `Promise.all([drainStdout, drainStderr, proc.exited])`, which settles on the SLOWEST of the
//      three — and a grandchild that inherited the child's stdout holds that pipe open for as long
//      as IT lives. A child that died in 79 s therefore kept its operation alive until the
//      DEADLINE would have killed it. Reproduced below against a real interpreter: before the fix
//      this file's first test took `timeoutMs + drain grace`; after it, the drain grace alone.
//   2. THE OUTPUT DIED WITH THE PROCESS. Python block-buffers stdout when it is a pipe, so a child
//      that is killed never flushes — which is why a cancelled run read as a crash with no
//      diagnostic anywhere. PYTHONUNBUFFERED is now pinned in orchestratorChildEnv.
//
// And the backstop for anything not thought of — LATENT, not observed: a deadline enforced only by
// a kill assumes the kill worked, so the operation registry closes its own record past the run's
// declared deadline and `running` forever is not a state the daemon can be in.
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOrchestratorOperation,
  pythonBinary,
  resetOrchestratorOperationsForTests,
  runOrchestrator,
  startOrchestratorOperation,
} from '../src/orchestrator'

afterEach(() => resetOrchestratorOperationsForTests())

const ROOT = mkdtempSync(join(tmpdir(), 'agenthydra-orch-reaper-root-'))
afterAll(() => {
  // The grandchild this file deliberately orphans outlives the suite, and on Windows a live
  // process makes its own directory undeletable. The scratch tree is the OS temp dir's problem
  // after that; failing the file over it would be the test cleaning up louder than it tests.
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* EBUSY: something we spawned on purpose is still holding it */
  }
})

/** A scratch toolbox whose `orch.py` is the given Python source. */
function toolbox(lines: string[]): string {
  const dir = mkdtempSync(join(ROOT, 'agenthydra-orch-reaper-'))
  writeFileSync(join(dir, 'orch.py'), `${lines.join('\n')}\n`)
  return dir
}

const hasPython = (() => {
  try {
    return (
      Bun.spawnSync([pythonBinary(), '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      }).exitCode === 0
    )
  } catch {
    return false
  }
})()

// THE REGRESSION, against a real interpreter. The child spawns a grandchild that inherits its
// stdout (no redirection — exactly what `cli_spawn`'s terminal and any un-redirected actuator do)
// and then exits non-zero. The grandchild outlives the declared deadline by design, so before the
// fix the adapter could only answer after `timeoutMs` had killed everything: the assertion that
// matters is that this settles in seconds, not in `timeoutMs`.
test.skipIf(!hasPython)(
  'a child that exits while a grandchild holds its pipe is reaped at once, not at its deadline',
  async () => {
    const dir = toolbox([
      'import subprocess, sys, tempfile',
      '# a grandchild with NO stdio redirection: it inherits this process pipes and outlives it.',
      '# cwd is the temp root, not the scratch toolbox, so it does not lock the dir afterAll bins.',
      'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],',
      '                 cwd=tempfile.gettempdir())',
      'print("phase 1 done")',
      'sys.exit(1)',
    ])
    const t0 = Date.now()
    // 10 minutes — a perfectly ordinary declaration for a batch, and the thing that used to
    // become the floor on noticing a crash.
    const r = await runOrchestrator({ script: 'chats', timeoutMs: 600_000 }, { dir })
    const took = Date.now() - t0
    if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
    expect(took).toBeLessThan(30_000)
    expect(r.exitCode).toBe(1)
    expect(r.ok).toBe(false)
    // It was NOT the deadline that ended this: the child ended itself and was noticed.
    expect(r.timedOut).toBe(false)
    // …and what it printed before dying survives, which is the other half of the incident.
    expect(r.stdout).toContain('phase 1 done')
  },
  60_000,
)

// THE SILENT CRASH. Everything the child got out before it was killed must be in the record — the
// buffered-stdout loss is what made a killed run look like a crash with no diagnostic. A traceback
// on stderr must arrive too, since "an unhandled exception whose output is swallowed" was the
// first suspect and has to be provably not happening.
test.skipIf(!hasPython)(
  'a child killed at its deadline still reports what it printed, on both streams',
  async () => {
    const dir = toolbox([
      'import sys, time',
      'print("stdout before the wall")',
      'sys.stderr.write("stderr before the wall\\n")',
      'time.sleep(120)',
    ])
    const r = await runOrchestrator({ script: 'chats', timeoutMs: 3_000 }, { dir })
    if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.stdout).toContain('stdout before the wall')
    expect(r.stderr).toContain('stderr before the wall')
  },
  60_000,
)

test.skipIf(!hasPython)(
  'an unhandled exception in the child reaches stderr rather than vanishing',
  async () => {
    const dir = toolbox([
      'import sys',
      'print("started the resume phase")',
      'raise RuntimeError("resume phase blew up")',
    ])
    const r = await runOrchestrator({ script: 'chats', timeoutMs: 30_000 }, { dir })
    if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('started the resume phase')
    expect(r.stderr).toContain('resume phase blew up')
    expect(r.stderr).toContain('Traceback')
  },
  60_000,
)

// THE BACKSTOP. A spawn that never settles at all — the shape every unexplained `running` forever
// reduces to — must still close its record, with an error that says the deadline was passed and
// warns against re-firing the act.
test('the registry closes an operation whose run never settles, past its declared deadline', async () => {
  const dir = toolbox(['# fake driver'])
  const { op } = startOrchestratorOperation(
    { script: 'migrate_batch', args: ['--json'], timeoutMs: 1_000 },
    {
      watchdogGraceMs: 300,
      deps: {
        dir,
        // Never settles, and never reports a process: the worst case, where even the kill switch
        // the registry would reach for does not exist.
        spawn: () => new Promise(() => {}),
      },
    },
  )
  expect(getOrchestratorOperation(op.id)?.status).toBe('running')
  await Bun.sleep(2_000)
  const closed = getOrchestratorOperation(op.id)
  expect(closed?.status).toBe('failed')
  expect(closed?.finishedAt).not.toBeNull()
  const result = closed?.result
  if (!result || !('error' in result)) throw new Error(`unexpected: ${JSON.stringify(result)}`)
  expect(result.error).toContain('declared deadline')
  expect(result.error).toContain('do NOT re-fire')
}, 20_000)

// A late result must not reopen a record the watchdog already closed and reported.
test('a run that settles after the watchdog closed it does not reopen the record', async () => {
  const dir = toolbox(['# fake driver'])
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { op, promise } = startOrchestratorOperation(
    { script: 'courier', args: ['--yes'], timeoutMs: 1_000 },
    {
      watchdogGraceMs: 300,
      deps: {
        dir,
        spawn: async () => {
          await gate
          return { code: 0, stdout: 'late but fine', stderr: '', timedOut: false }
        },
      },
    },
  )
  await Bun.sleep(2_000)
  expect(getOrchestratorOperation(op.id)?.status).toBe('failed')
  const closedAt = getOrchestratorOperation(op.id)?.finishedAt
  release()
  await promise
  const after = getOrchestratorOperation(op.id)
  expect(after?.status).toBe('failed')
  expect(after?.finishedAt).toBe(closedAt ?? 0)
}, 20_000)

// The healthy path is untouched: a normal run closes on its own result and the watchdog never
// fires — proven by the record being `done` well inside the grace window.
test('a run that finishes normally is untouched by the watchdog', async () => {
  const dir = toolbox(['# fake driver'])
  const { op, promise } = startOrchestratorOperation(
    { script: 'chats', timeoutMs: 60_000 },
    {
      watchdogGraceMs: 300,
      deps: {
        dir,
        spawn: async () => ({ code: 0, stdout: 'VERDICT: fine', stderr: '', timedOut: false }),
      },
    },
  )
  await promise
  await Bun.sleep(700)
  const after = getOrchestratorOperation(op.id)
  expect(after?.status).toBe('done')
  const result = after?.result
  if (!result || !('stdout' in result)) throw new Error(`unexpected: ${JSON.stringify(result)}`)
  expect(result.stdout).toContain('VERDICT: fine')
}, 20_000)
