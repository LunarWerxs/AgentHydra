// server/tests/spawn-captured-bounded.test.ts — 2026-09-18: THE ONE BOUNDED SPAWN, and the three
// ways the sites it replaced could hang.
//
// THE SWEEP. After the orchestrator route was found wedging on a grandchild that held its child's
// stdout pipe, every `.exited` await in server/src was audited. Sixteen sites; ELEVEN had no
// deadline at all, in three distinct shapes:
//
//   1. NO DEADLINE — `await proc.exited` with nothing racing it. One of those was inside an HTTP
//      route (the clipboard copy), so a wedged `Set-Clipboard` meant the route never answered.
//   2. PIPE-AND-IGNORE, WHICH IS A DEADLOCK, NOT A LEAK — `core/crypto/keys.win.ts` opened
//      `stderr: 'pipe'` and never read it. A DPAPI `Unprotect` failure writes a multi-kilobyte
//      .NET traceback; past the pipe buffer PowerShell BLOCKS on that write, so it never exits,
//      so stdout never closes and `proc.exited` never settles — in the credential path.
//   3. THE CHILD'S EXIT IS NOT THE PIPE CLOSING — a grandchild inheriting stdout holds it open for
//      as long as IT lives, so the drain outlives the process.
//
// spawnCaptured/capturePipedProc close all three: every stream it opens is DRAINED, the deadline
// always settles, and the kill takes the TREE so a stranger holding the pipe dies with it.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitExitBounded, capturePipedProc, spawnCaptured } from '../src/core/process'
import { pythonBinary } from '../src/orchestrator'

const ROOT = mkdtempSync(join(tmpdir(), 'agenthydra-bounded-spawn-'))
afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* a process we orphaned on purpose may still hold it */
  }
})

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

/** A throwaway script, returned as an argv that runs it. */
function script(name: string, lines: string[]): string[] {
  const p = join(ROOT, `${name}.py`)
  writeFileSync(p, `${lines.join('\n')}\n`)
  return [pythonBinary(), p]
}

test('a spawn that cannot start is data, not a throw', async () => {
  const r = await spawnCaptured(['definitely-not-a-real-binary-xyzzy'], { timeoutMs: 2_000 })
  expect(r.code).toBeNull()
  expect(r.timedOut).toBe(false) // there was never a child; that is not a timeout
  expect(r.stdout).toBe('')
})

test.skipIf(!hasPython)('the happy path returns both streams and the code', async () => {
  const r = await spawnCaptured(
    script('happy', ['import sys', 'print("on stdout")', 'sys.stderr.write("on stderr\\n")']),
    { timeoutMs: 30_000 },
  )
  expect(r.timedOut).toBe(false)
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('on stdout')
  expect(r.stderr).toContain('on stderr')
})

// DEFECT 1: no deadline. A child that never exits must not hold the caller.
test.skipIf(!hasPython)(
  'a child that never exits is cut off at the deadline',
  async () => {
    const t0 = Date.now()
    const r = await spawnCaptured(script('forever', ['import time', 'time.sleep(300)']), {
      timeoutMs: 2_000,
    })
    const took = Date.now() - t0
    expect(r.timedOut).toBe(true)
    expect(took).toBeLessThan(20_000)
  },
  40_000,
)

// DEFECT 2: the deadlock. A child that floods the stream the OLD code left unread must still be
// handled — spawnCaptured drains both, so this completes normally instead of wedging.
test.skipIf(!hasPython)(
  'a child that floods stderr does NOT deadlock, because both streams are drained',
  async () => {
    const r = await spawnCaptured(
      script('flood', [
        'import sys',
        // Well past any pipe buffer: the old pipe-and-ignore shape blocks here forever.
        'sys.stderr.write("E" * 400000)',
        'sys.stderr.flush()',
        'print("finished anyway")',
      ]),
      { timeoutMs: 30_000 },
    )
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('finished anyway')
    expect(r.stderr.length).toBeGreaterThan(300_000)
  },
  60_000,
)

// DEFECT 3: the child exits but a grandchild holds the pipe. The deadline must still settle, and
// it must not wait for the stranger.
test.skipIf(!hasPython)(
  'a grandchild holding the pipe cannot extend the run past its deadline',
  async () => {
    const t0 = Date.now()
    const r = await spawnCaptured(
      script('pipeholder', [
        'import subprocess, sys, tempfile',
        // No stdio redirection: it inherits our pipes and outlives us.
        'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],',
        '                 cwd=tempfile.gettempdir())',
        'print("parent done")',
        'sys.exit(3)',
      ]),
      { timeoutMs: 3_000 },
    )
    const took = Date.now() - t0
    // It settles at the deadline, NOT when the 30s grandchild finally exits.
    expect(took).toBeLessThan(20_000)
    // And what the child managed to say before going is kept.
    expect(r.stdout).toContain('parent done')
  },
  60_000,
)

test.skipIf(!hasPython)(
  'wantStderr:false still DRAINS stderr, it just does not return it',
  async () => {
    const r = await spawnCaptured(
      script('quiet', ['import sys', 'sys.stderr.write("N" * 200000)', 'print("ok")']),
      { timeoutMs: 30_000, wantStderr: false },
    )
    // Draining is what prevents the deadlock; withholding the text is only the caller's preference.
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ok')
    expect(r.stderr).toBe('')
  },
  60_000,
)

// capturePipedProc is the same bound applied to somebody else's child — the door the two
// shortcut writers use, since they build their own argv/env and carry their own messages.
test.skipIf(!hasPython)(
  'capturePipedProc bounds a child it did not spawn',
  async () => {
    const argv = script('other', ['print("spawned elsewhere")'])
    const proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    const r = await capturePipedProc(proc, { timeoutMs: 30_000 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('spawned elsewhere')
  },
  60_000,
)

// awaitExitBounded is for the stdio-ignored spawns (taskkill, Set-Clipboard): nothing to drain,
// and the only defect was that the await had nothing racing it.
test.skipIf(!hasPython)(
  'awaitExitBounded returns the code, or null at the deadline',
  async () => {
    const quick = Bun.spawn(script('quick', ['raise SystemExit(7)']), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    expect(await awaitExitBounded(quick, 30_000)).toBe(7)

    const stuck = Bun.spawn(script('stuck', ['import time', 'time.sleep(300)']), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    const t0 = Date.now()
    expect(await awaitExitBounded(stuck, 2_000)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(20_000)
  },
  60_000,
)
