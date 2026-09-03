// The daemon-side seam onto the Python orchestrator (server/src/orchestrator.ts).
//
// Two halves. The PURE half - the invocation grammar, the exit-code meanings, the dir and python
// resolution - is pinned exactly, because it is the whole security story: a menu name is the only
// thing that can reach `python orch.py`, and arguments travel as an argv array. The SPAWN half is
// exercised through an injected fake so the suite never needs python or a fleet, plus one real run
// of the interpreter (skipped where none is installed) proving the argv actually lands unquoted.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIMEOUT_MS,
  DRIVER_EXIT_MEANINGS,
  MAX_TIMEOUT_MS,
  orchestratorDir,
  orchestratorStatus,
  pythonBinary,
  runOrchestrator,
  validateInvocation,
} from '../src/orchestrator'

describe('validateInvocation - the only grammar that reaches orch.py', () => {
  test('a menu name with string args and the default deadline', () => {
    const r = validateInvocation({ script: 'chats', args: ['--instance', 'pap3r rotate'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.invocation).toEqual({
        script: 'chats',
        args: ['--instance', 'pap3r rotate'],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
    }
  })

  test('driver words are menu names too', () => {
    for (const w of ['loop', 'armed', 'arm', 'disarm'])
      expect(validateInvocation({ script: w }).ok).toBe(true)
  })

  test.each([
    ['', 'required'],
    ['../orch', 'not a menu name'],
    ['chats; rm -rf /', 'not a menu name'],
    ['Chats', 'not a menu name'],
    ['scripts/chats.py', 'not a menu name'],
  ])('refuses script %j', (script, why) => {
    const r = validateInvocation({ script })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(why)
  })

  test('args must be an array of NUL-free strings', () => {
    expect(validateInvocation({ script: 'chats', args: 'x' }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: [1] }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: ['a\0b'] }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: null }).ok).toBe(true)
  })

  test('the deadline is clamped to the ceiling and must be positive', () => {
    const big = validateInvocation({ script: 'loop', timeoutMs: 10 * MAX_TIMEOUT_MS })
    expect(big.ok && big.invocation.timeoutMs).toBe(MAX_TIMEOUT_MS)
    expect(validateInvocation({ script: 'loop', timeoutMs: 0 }).ok).toBe(false)
    expect(validateInvocation({ script: 'loop', timeoutMs: 'soon' }).ok).toBe(false)
  })
})

describe('resolution', () => {
  test('the toolbox is the sibling folder unless the env points elsewhere', () => {
    expect(orchestratorDir({})).toMatch(/[\\/]orchestrator$/)
    expect(orchestratorDir({ AGENTHYDRA_ORCHESTRATOR_DIR: ' D:/elsewhere ' })).toBe('D:/elsewhere')
  })

  test('python on Windows, python3 elsewhere, env wins', () => {
    expect(pythonBinary({}, 'win32')).toBe('python')
    expect(pythonBinary({}, 'linux')).toBe('python3')
    expect(pythonBinary({}, 'darwin')).toBe('python3')
    expect(pythonBinary({ AGENTHYDRA_PYTHON: '/opt/py/bin/python3.12' }, 'win32')).toBe(
      '/opt/py/bin/python3.12',
    )
  })

  test("the driver's exit codes read as verdicts", () => {
    expect(DRIVER_EXIT_MEANINGS[0]).toBe('ok')
    expect(DRIVER_EXIT_MEANINGS[3]).toContain('not armed')
  })
})

/** A toolbox with a driver that can be spawned - or not - depending on the test. */
function fakeToolbox(withDriver = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-'))
  if (withDriver) writeFileSync(join(dir, 'orch.py'), '# fake driver\n')
  return dir
}

describe('runOrchestrator - argv in, verdict out', () => {
  test('refuses before spawning when the toolbox is missing', async () => {
    const dir = fakeToolbox(false)
    let spawned = false
    const r = await runOrchestrator(
      { script: 'chats' },
      {
        dir,
        spawn: async () => {
          spawned = true
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    )
    expect(spawned).toBe(false)
    expect('error' in r && r.error).toContain('no orch.py')
  })

  test('spawns python orch.py <script> <args...> in the toolbox dir and reports the code', async () => {
    const dir = fakeToolbox()
    const seen: { command: string[]; cwd: string; timeoutMs: number }[] = []
    const r = await runOrchestrator(
      { script: 'migrate_chat', args: ['Odin', '--to', '3claude', '--stop-idle'], timeoutMs: 5000 },
      {
        dir,
        python: 'py-fake',
        spawn: async (command, cwd, timeoutMs) => {
          seen.push({ command, cwd, timeoutMs })
          return { code: 3, stdout: 'REFUSED', stderr: '', timedOut: false }
        },
      },
    )
    expect(seen).toEqual([
      {
        command: ['py-fake', 'orch.py', 'migrate_chat', 'Odin', '--to', '3claude', '--stop-idle'],
        cwd: dir,
        timeoutMs: 5000,
      },
    ])
    expect('ok' in r && r.ok).toBe(false)
    if ('exitCode' in r) {
      expect(r.exitCode).toBe(3)
      expect(r.exitMeaning).toContain('not armed')
      expect(r.stdout).toBe('REFUSED')
      expect(r.timedOut).toBe(false)
    }
  })

  test('a timed-out run is never ok, whatever the code says', async () => {
    const dir = fakeToolbox()
    const r = await runOrchestrator(
      { script: 'loop' },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: true }) },
    )
    expect('ok' in r && r.ok).toBe(false)
    if ('timedOut' in r) expect(r.timedOut).toBe(true)
  })

  test('a spawn that cannot start is an error, not a crash', async () => {
    const dir = fakeToolbox()
    const r = await runOrchestrator(
      { script: 'census' },
      {
        dir,
        spawn: async () => {
          throw new Error('ENOENT python')
        },
      },
    )
    expect('error' in r && r.error).toContain('ENOENT')
  })

  test('status reads the menu through the same spawn', async () => {
    const dir = fakeToolbox()
    const s = await orchestratorStatus({
      dir,
      python: 'py-fake',
      spawn: async (command) =>
        command[1] === '--version'
          ? { code: 0, stdout: 'Python 3.14.0\n', stderr: '', timedOut: false }
          : { code: 0, stdout: '  OBSERVE\n    chats  ...\n', stderr: '', timedOut: false },
    })
    expect(s.present).toBe(true)
    expect(s.pythonVersion).toBe('Python 3.14.0')
    expect(s.menu).toContain('chats')
    expect(s.error).toBeNull()
  })
})

// The one real spawn: prove the argv lands in python UNQUOTED (a space inside one arg stays one
// arg). Skipped where the interpreter is not installed - the fake-spawn tests above cover the
// seam itself. 20s: a cold CI runner starting an interpreter has been measured well over 5s.
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

test.skipIf(!hasPython)(
  'a real python sees each arg intact, spaces and all',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-real-'))
    writeFileSync(join(dir, 'orch.py'), 'import sys, json\nprint(json.dumps(sys.argv[1:]))\n')
    const r = await runOrchestrator(
      { script: 'chats', args: ['--instance', 'pap3r rotate'], timeoutMs: 15_000 },
      { dir },
    )
    expect('stdout' in r && JSON.parse(r.stdout)).toEqual(['chats', '--instance', 'pap3r rotate'])
    expect('ok' in r && r.ok).toBe(true)
  },
  20_000,
)
