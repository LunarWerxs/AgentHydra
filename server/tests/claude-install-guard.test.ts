// server/tests/claude-install-guard.test.ts - a broken Claude Code install must hold CliMayte work, not
// burn retries. Incident 2026-10-06: an npm update stopped half way, bin/claude.exe was a 500-byte
// placeholder and then a truncated binary; every launch died within a second with no output, was
// called "interrupted", retried three times and failed the chat. The machine is faked here (files in a
// temp folder, `--version` and the install step answered by the test); nothing touches a real install.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkClaudeExe,
  claudeInstallState,
  INSTALL_BROKEN_HEAD,
  inspectClaudeExe,
  MIN_EXE_BYTES,
  repairRuns,
  setGuardDeps,
  settleRepair,
  UNHEALTHY_RECHECK_MS,
} from '../src/claude-install-guard'
import { installBroken, settleWorker } from '../src/climayte'
import { workers } from '../src/climayte-core'
import {
  type CliMayteAccount,
  type CliMayteAttempt,
  type CliMayteWorker,
  classifyAttempt,
  isInstantEmptyDeath,
} from '../src/climayte-lib'
import { scheduleDue, setInstallGuard, setLauncher, tickState } from '../src/climayte-schedule'
import { claudeExeFallback } from '../src/config'
import './no-chats'

const root = mkdtempSync(join(tmpdir(), 'ah-guard-'))
let pkg: string
let exe: string
let probes: string[]
let runs: string[][]
let raised: string[]
let cleared: number
let clock: number
/** What `--version` answers for a file, by its size. */
let answer: (size: number) => {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}
/** What the fake install step does to the files. */
let onRun: (argv: string[]) => { code: number; stderr?: string }
let seq = 0

const HEALTHY = MIN_EXE_BYTES + 1000
const write = (path: string, size: number): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(size, 1))
  // A distinct mtime per write: the cache key is path + size + mtime.
  const t = new Date(1_800_000_000_000 + ++seq * 1000)
  require('node:fs').utimesSync(path, t, t)
}
const okVersion = { code: 0, stdout: '2.1.292 (Claude Code)\n', stderr: '', timedOut: false }
const badExec = { code: null, stdout: '', stderr: 'Exec format error', timedOut: false }

const install = (): void =>
  setGuardDeps({
    now: () => clock,
    exe: () => exe,
    overridden: () => false,
    lkgDir: join(root, 'lkg'),
    probe: (p) => {
      probes.push(p)
      return answer(statSync(p).size)
    },
    run: async (argv) => {
      runs.push(argv)
      await new Promise((res) => setTimeout(res, 5)) // a real install takes time
      const r = onRun(argv)
      return { code: r.code, stdout: '', stderr: r.stderr ?? '', timedOut: false }
    },
    copyLkg: async (from, toDir) => {
      write(join(toDir, 'claude.exe'), statSync(from).size)
    },
    raise: async (m) => {
      raised.push(m)
    },
    clear: async () => {
      cleared++
    },
    log: () => {},
  })

beforeEach(() => {
  pkg = join(root, `case-${++seq}`, 'node_modules', '@anthropic-ai', 'claude-code')
  exe = join(pkg, 'bin', 'claude.exe')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.292' }),
  )
  probes = []
  runs = []
  raised = []
  cleared = 0
  clock = 1_800_000_000_000
  answer = (size) => (size >= HEALTHY ? okVersion : badExec)
  onRun = () => ({ code: 0 })
  install()
})
afterEach(() => {
  setGuardDeps(null)
  setInstallGuard(null)
  setLauncher(null)
})

describe('inspectClaudeExe', () => {
  test('a 500-byte placeholder is unhealthy and is never run', () => {
    write(exe, 500)
    const h = inspectClaudeExe(exe)
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('500 bytes')
    expect(probes).toEqual([])
  })

  test('a truncated binary that cannot execute is unhealthy', () => {
    write(exe, HEALTHY - 1)
    const h = inspectClaudeExe(exe)
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('Exec format error')
  })

  test('a missing file is unhealthy', () => {
    expect(inspectClaudeExe(join(root, 'nope', 'claude.exe')).reason).toContain('does not exist')
  })

  test('a healthy executable answers --version', () => {
    write(exe, HEALTHY)
    expect(inspectClaudeExe(exe)).toMatchObject({ ok: true, version: '2.1.292' })
  })

  test('a --version that hangs is unhealthy', () => {
    write(exe, HEALTHY)
    answer = () => ({ code: null, stdout: '', stderr: '', timedOut: true })
    expect(inspectClaudeExe(exe).reason).toContain('did not answer')
  })
})

describe('checkClaudeExe cache', () => {
  test('a healthy verdict costs one probe while path, size and mtime are unchanged', () => {
    write(exe, HEALTHY)
    for (let i = 0; i < 20; i++) expect(checkClaudeExe(exe).ok).toBe(true)
    expect(probes).toHaveLength(1)
    write(exe, HEALTHY + 1) // an update: asked again
    expect(checkClaudeExe(exe).ok).toBe(true)
    expect(probes).toHaveLength(2)
  })

  test('an unhealthy verdict is re-probed only after UNHEALTHY_RECHECK_MS, or when asked fresh', () => {
    write(exe, 500)
    write(exe, HEALTHY - 1)
    checkClaudeExe(exe)
    checkClaudeExe(exe)
    expect(probes).toHaveLength(1)
    clock += UNHEALTHY_RECHECK_MS + 1
    checkClaudeExe(exe)
    expect(probes).toHaveLength(2)
    checkClaudeExe(exe, true)
    expect(probes).toHaveLength(3)
  })
})

describe('claudeInstallState and repair', () => {
  test('a broken install is repaired once however many launches ask; the work is released after', async () => {
    write(exe, 500)
    onRun = () => {
      write(exe, HEALTHY)
      return { code: 0 }
    }
    const asks = Array.from({ length: 6 }, () => claudeInstallState())
    expect(asks.every((s) => !s.ok)).toBe(true)
    expect(asks[0]?.reason).toContain('500 bytes')
    await settleRepair()
    expect(repairRuns()).toBe(1)
    expect(runs).toHaveLength(1)
    const after = claudeInstallState()
    expect(after.ok).toBe(true)
    expect(after.version).toBe('2.1.292')
    expect(repairRuns()).toBe(1)
    expect(cleared).toBe(1)
    expect(raised).toEqual([])
  })

  test('no native package: it reinstalls the version package.json names', async () => {
    write(exe, 500)
    claudeInstallState()
    await settleRepair()
    expect(runs[0]?.slice(0, 3)).toEqual(['npm', 'install', '-g'])
    expect(runs[0]?.[3]).toBe('@anthropic-ai/claude-code@2.1.292')
  })

  test('a complete native package: it re-runs the package install step, no network', async () => {
    write(exe, 500)
    write(
      join(
        pkg,
        'node_modules',
        '@anthropic-ai',
        `claude-code-${process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      ),
      HEALTHY,
    )
    onRun = () => {
      write(exe, HEALTHY)
      return { code: 0 }
    }
    claudeInstallState()
    await settleRepair()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.[0]).toBe('node')
    expect(runs[0]?.[1]).toBe(join(pkg, 'install.cjs'))
    expect(claudeInstallState().ok).toBe(true)
  })

  test('a repair that fails keeps holding, backs off, and raises one incident', async () => {
    write(exe, 500)
    onRun = () => ({ code: 1, stderr: 'EBUSY: resource busy' })
    expect(claudeInstallState().ok).toBe(false)
    await settleRepair()
    expect(repairRuns()).toBe(1)
    expect(raised).toHaveLength(1)
    expect(raised[0]).toContain('could not repair')
    // Inside the backoff: no second repair however often it is asked.
    clock += 30_000
    claudeInstallState()
    claudeInstallState()
    await settleRepair()
    expect(repairRuns()).toBe(1)
    // After it: one more try, then it works.
    onRun = () => {
      write(exe, HEALTHY)
      return { code: 0 }
    }
    clock += 120_000
    claudeInstallState()
    await settleRepair()
    expect(repairRuns()).toBe(2)
    expect(claudeInstallState().ok).toBe(true)
  })

  test('while the install is broken launches use a verified last-known-good copy, and wait for nothing', async () => {
    write(exe, HEALTHY)
    expect(claudeInstallState().ok).toBe(true)
    await settleRepair() // the background copy
    write(exe, 500) // the update that did not finish
    onRun = () => ({ code: 1 })
    const s = claudeInstallState()
    expect(s.ok).toBe(true)
    expect(s.usingLastKnownGood).toBe(true)
    expect(claudeExeFallback.primary).toBe(exe)
    expect(claudeExeFallback.path).toBe(join(root, 'lkg', 'claude.exe'))
    await settleRepair()
    write(exe, HEALTHY)
    expect(claudeInstallState().usingLastKnownGood).toBe(false)
    expect(claudeExeFallback.path).toBeNull()
  })
})

// --- the scheduler: held, not launched, not failed ---------------------------------------------------

const accounts: CliMayteAccount[] = [
  {
    id: 'acct-g1',
    num: 201,
    name: 'g1@example.com',
    configDir: join(tmpdir(), 'acct-g1'),
    sessionPct: 5,
    weekPct: 5,
  },
  {
    id: 'acct-g2',
    num: 202,
    name: 'g2@example.com',
    configDir: join(tmpdir(), 'acct-g2'),
    sessionPct: 5,
    weekPct: 5,
  },
]
const t0 = 1_800_000_000_000
const mk = (id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker => {
  const w = {
    id,
    group: `g-${id}`,
    title: id,
    cwd: 'C:/Users/me/repo',
    prompt: 'p',
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status: 'queued',
    accountId: null,
    attempts: [],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: t0,
    updatedAt: t0,
    ...over,
  } as unknown as CliMayteWorker
  workers.set(id, w)
  return w
}
const tick = (ids: string[]): void =>
  scheduleDue(
    tickState(accounts, t0),
    [...workers.values()].filter(
      (w) => ids.includes(w.id) && (w.status === 'queued' || w.status === 'waiting'),
    ),
  )

describe('scheduler', () => {
  test('a broken install holds queued work and a handoff with the reason: no launch, no retry, no account', () => {
    write(exe, 500)
    const launched: string[] = []
    setLauncher((w) => {
      launched.push(w.id)
      w.status = 'running'
    })
    // Real guard on the real launcher path is judged only for the real CLI; ask the guard directly.
    setInstallGuard(() => claudeInstallState())
    const queued = mk('guard-q')
    const handoff = mk('guard-h', {
      accountId: 'acct-g1',
      retries: 1,
      attempts: [
        { account: accounts[0], startedAt: t0 - 5, endedAt: t0, outcome: 'handoff' },
      ] as any,
    })
    tick(['guard-q', 'guard-h'])
    expect(launched).toEqual([])
    for (const w of [queued, handoff]) {
      expect(w.status).toBe('waiting')
      expect(w.error?.startsWith(INSTALL_BROKEN_HEAD)).toBe(true)
      expect(w.error).toContain('500 bytes')
    }
    expect(handoff.retries).toBe(1) // no retry burnt
    expect(handoff.accountId).toBe('acct-g1') // not moved
    expect(queued.accountId).toBeNull()
    for (const id of ['guard-q', 'guard-h']) workers.delete(id)
  })

  test('held work starts by itself the tick after the repair', async () => {
    write(exe, 500)
    onRun = () => {
      write(exe, HEALTHY)
      return { code: 0 }
    }
    const launched: string[] = []
    setLauncher((w) => {
      launched.push(w.id)
      w.status = 'running'
    })
    setInstallGuard(() => claudeInstallState())
    const w = mk('guard-r')
    tick(['guard-r'])
    expect(w.status).toBe('waiting')
    expect(launched).toEqual([])
    await settleRepair()
    tick(['guard-r'])
    expect(launched).toEqual(['guard-r'])
    expect(w.status).toBe('running')
    expect(w.error).toBeNull()
    workers.delete('guard-r')
  })
})

// --- classification ------------------------------------------------------------------------------------

describe('instant empty deaths', () => {
  const dead = { livedMs: 900, events: [] as unknown[], stderr: '', hadRunnerPid: false }
  const attempt = (): CliMayteAttempt => ({
    account: accounts[0],
    pid: null,
    log: '',
    errLog: '',
    startedAt: t0,
    endedAt: t0 + 900,
    outcome: 'running',
    notice: null,
    resumed: false,
  })

  test('the old verdict for such a death was interrupted (the bug)', () => {
    expect(classifyAttempt([], '').outcome).toBe('interrupted')
  })

  test('what counts as instant and empty', () => {
    expect(isInstantEmptyDeath(dead)).toBe(true)
    expect(isInstantEmptyDeath({ ...dead, livedMs: 60_000 })).toBe(false)
    expect(isInstantEmptyDeath({ ...dead, stderr: 'warn' })).toBe(false)
    expect(isInstantEmptyDeath({ ...dead, hadRunnerPid: true })).toBe(false)
    expect(isInstantEmptyDeath({ ...dead, events: [{ type: 'system' }] })).toBe(false)
  })

  test('with the install broken it is install-broken, and settling it burns no retry and moves nothing', () => {
    write(exe, HEALTHY - 1)
    const v = installBroken(attempt(), classifyAttempt([], ''), [], '', false)
    expect(v.outcome).toBe('install-broken')
    expect(v.notice).toContain('Exec format error')
    const w = mk('guard-c', { retries: 2, accountId: 'acct-g1' })
    settleWorker(w, attempt(), v, t0, '')
    expect(w.status).toBe('waiting')
    expect(w.retries).toBe(2)
    expect(w.accountId).toBe('acct-g1')
    expect(w.error?.startsWith(INSTALL_BROKEN_HEAD)).toBe(true)
    workers.delete('guard-c')
  })

  test('with a healthy install it stays interrupted (a restart kill), and a real death with output is untouched', () => {
    write(exe, HEALTHY)
    expect(installBroken(attempt(), classifyAttempt([], ''), [], '', false).outcome).toBe(
      'interrupted',
    )
    const loud = classifyAttempt([], 'error: unknown option --bogus')
    expect(installBroken(attempt(), loud, [], 'error: unknown option --bogus', false).outcome).toBe(
      'error',
    )
    expect(probes).toHaveLength(1)
  })

  test('a long-running death is never read as the install', () => {
    write(exe, 500)
    const at = { ...attempt(), endedAt: t0 + 120_000 }
    expect(installBroken(at, classifyAttempt([], ''), [], '', false).outcome).toBe('interrupted')
  })
})

afterEach(() => {
  rmSync(join(root, 'lkg'), { recursive: true, force: true })
})
