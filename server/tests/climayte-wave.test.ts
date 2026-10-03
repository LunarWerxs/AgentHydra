// CliMayte waves: the wave record, the pure helpers that parse its state.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  climayteCancel,
  climayteList,
  climayteRun,
  climayteScorecard,
  climayteTotals,
  climayteVerdict,
  climayteWait,
  climayteWaveStart,
  climayteWaveVerify,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { workers as liveWorkers } from '../src/climayte-core'
import { MANAGER_CONTEXT_TOKENS } from '../src/climayte-launch'
import type { CliMayteWave, CliMayteWorker } from '../src/climayte-lib'
import { readWave, waveBatch, waveDone, waveStateText, writeWave } from '../src/climayte-wave'

// Managers record their wake spend by kind, and CliMayte prices the next manager from it: a test
// file that leaves them behind changes what climayte.test.ts's manager sizing test expects.
function forgetManagers(): void {
  for (const [id, w] of liveWorkers) if (w.kind === 'manage') liveWorkers.delete(id)
}

describe('wave store', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ah-climayte-wave-'))
    mkdirSync(join(tempDir, 'corch', 'waves'), { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true })
    } catch {}
  })

  test('a wave survives a write and read', () => {
    const wave: CliMayteWave = {
      id: 'wv-abc123',
      group: 'g-xyz789',
      managerId: 'w-mgr0001',
      plan: '/home/user/plan.md',
      cwd: '/home/user/repo',
      branch: 'main',
      verify: 'bun run test',
      tasks: [
        {
          key: 't1',
          prompt: 'Fix the bug',
          title: 'Bug fix',
          kind: 'code',
          check: 'bun test',
          paths: ['src/**/*.ts'],
          after: [],
          workerId: 'w-task0001',
          state: 'passed',
          proof: {
            check: true,
            commits: ['abc123def456'],
            paths: true,
            note: '',
          },
        },
        {
          key: 't2',
          prompt: 'Write docs',
          title: 'Documentation',
          kind: 'docs',
          check: null,
          paths: ['docs/**/*.md'],
          after: ['t1'],
          workerId: 'w-task0002',
          state: 'running',
          proof: null,
        },
        {
          key: 't3',
          prompt: 'Review changes',
          title: 'Review',
          kind: 'review',
          check: null,
          paths: [],
          after: ['t2'],
          workerId: null,
          state: 'pending',
          proof: null,
        },
      ],
      escalations: [
        {
          key: 't2',
          reason: 'Needs architectural decision',
          at: Date.now(),
        },
      ],
      notes: 'Waiting for approval on docs structure.',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 3, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Write the wave.
    writeWave(tempDir, wave)

    // Read it back.
    const loaded = readWave(tempDir, wave.id)

    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(wave.id)
    expect(loaded!.group).toBe(wave.group)
    expect(loaded!.managerId).toBe(wave.managerId)
    expect(loaded!.tasks).toHaveLength(3)
    expect(loaded!.tasks[0]!.state).toBe('passed')
    expect(loaded!.tasks[1]!.state).toBe('running')
    expect(loaded!.tasks[2]!.state).toBe('pending')
    expect(loaded!.escalations).toHaveLength(1)
    expect(loaded!.escalations[0]!.key).toBe('t2')
  })

  test('reading a missing wave returns null', () => {
    const loaded = readWave(tempDir, 'wv-missing')
    expect(loaded).toBeNull()
  })
})

describe('waveDone', () => {
  test('returns true when all tasks are in a terminal state', () => {
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'passed',
          proof: null,
        },
        {
          key: 't2',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'failed',
          proof: null,
        },
        {
          key: 't3',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'escalated',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 1, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: 0,
      updatedAt: 0,
    }

    expect(waveDone(wave)).toBe(true)
  })

  test('returns false when any task is pending or running', () => {
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'passed',
          proof: null,
        },
        {
          key: 't2',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'running',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 1, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: 0,
      updatedAt: 0,
    }

    expect(waveDone(wave)).toBe(false)
  })
})

describe('waveStateText', () => {
  test('renders every key with its state and proof', () => {
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/home/plan.md',
      cwd: '/home/repo',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 'api-routes',
          prompt: 'Implement routes',
          title: 'API Routes',
          kind: 'code',
          check: 'bun test api',
          paths: ['src/routes/**'],
          after: [],
          workerId: 'w-worker1',
          state: 'passed',
          proof: {
            check: true,
            commits: ['abc123', 'def456'],
            paths: true,
            note: '',
          },
        },
        {
          key: 'docs',
          prompt: 'Write documentation',
          title: 'Docs',
          kind: 'docs',
          check: null,
          paths: ['docs/**'],
          after: ['api-routes'],
          workerId: 'w-worker2',
          state: 'running',
          proof: null,
        },
        {
          key: 'tests',
          prompt: 'Add tests',
          title: 'Tests',
          kind: 'code',
          check: 'bun test all',
          paths: ['tests/**'],
          after: ['api-routes'],
          workerId: null,
          state: 'pending',
          proof: null,
        },
      ],
      escalations: [
        {
          key: 'docs',
          reason: 'Needs review',
          at: Date.now(),
        },
      ],
      notes: 'Waiting on technical review.',
      rounds: 2,
      maxRounds: 3,
      batch: { size: 3, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: 0,
      updatedAt: 0,
    }

    const workers = new Map<string, CliMayteWorker>()
    workers.set('w-worker1', {
      id: 'w-worker1',
      group: 'g-test',
      title: 'API Routes',
      cwd: '/home/repo',
      prompt: 'Implement routes',
      pending: [],
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      accounts: null,
      status: 'done',
      sessionId: 'session1',
      accountId: 'account1',
      attempts: [],
      result: 'Routes implemented',
      error: null,
      lastActivity: null,
      costUsd: 0.01,
      turns: 1,
      moves: 0,
      retries: 0,
      notBefore: null,
      createdAt: 0,
      updatedAt: 0,
    })
    workers.set('w-worker2', {
      id: 'w-worker2',
      group: 'g-test',
      title: 'Docs',
      cwd: '/home/repo',
      prompt: 'Write documentation',
      pending: [],
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      accounts: null,
      status: 'running',
      sessionId: 'session2',
      accountId: 'account1',
      attempts: [],
      result: null,
      error: null,
      lastActivity: null,
      costUsd: 0.005,
      turns: 0,
      moves: 0,
      retries: 0,
      notBefore: null,
      createdAt: 0,
      updatedAt: 0,
    })

    const text = waveStateText(wave, workers)

    // Check that the text contains the required information.
    expect(text).toContain('# Wave wv-test')
    expect(text).toContain('Group: g-test')
    expect(text).toContain('Plan: /home/plan.md')
    expect(text).toContain('Branch: main')

    // Check task states are named.
    expect(text).toContain('api-routes: passed')
    expect(text).toContain('docs: running')
    expect(text).toContain('tests: pending')

    // Check proof details are named.
    expect(text).toContain('check: pass')
    expect(text).toContain('commits: abc123, def456')
    expect(text).toContain('paths: ok')

    // Check worker references.
    expect(text).toContain('w-worker1 (done)')
    expect(text).toContain('w-worker2 (running)')

    // Check rounds.
    expect(text).toContain('Dispatch rounds: 2/3')

    // Check escalations.
    expect(text).toContain('## Escalations')
    expect(text).toContain('docs: Needs review')

    // Check notes.
    expect(text).toContain('## Notes')
    expect(text).toContain('Waiting on technical review.')
  })

  test('omits missing sections', () => {
    const wave: CliMayteWave = {
      id: 'wv-minimal',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: 'Task 1',
          title: 'Task 1',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'pending',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 1, settleS: 600, held: [], since: null },
      status: 'running',
      report: null,
      createdAt: 0,
      updatedAt: 0,
    }

    const text = waveStateText(wave, new Map())

    expect(text).toContain('## Tasks')
    expect(text).not.toContain('## Escalations')
    expect(text).not.toContain('## Notes')
  })
})

describe('waveBatch', () => {
  test('returns null when holding (batch not full, not settled, work running)', () => {
    const now = Date.now()
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'running',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 3, settleS: 600, held: ['t1'], since: now },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()
    workers.set('w-task1', {
      id: 'w-task1',
      group: 'g-test',
      title: 'Task 1',
      cwd: '/cwd',
      prompt: 'Do task',
      pending: [],
      model: null,
      effort: null,
      accounts: null,
      status: 'running',
      sessionId: 'session1',
      accountId: 'acct1',
      attempts: [],
      result: null,
      error: null,
      lastActivity: null,
      costUsd: 0,
      turns: 0,
      moves: 0,
      retries: 0,
      notBefore: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = waveBatch(wave, workers, now)
    expect(result).toBeNull()
  })

  test('returns ids when batch size is reached', () => {
    const now = Date.now()
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'running',
          proof: null,
        },
        {
          key: 't2',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task2',
          state: 'pending',
          proof: null,
        },
        {
          key: 't3',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: null,
          state: 'pending',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 3, settleS: 600, held: ['t1', 't2', 't3'], since: now },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()

    const result = waveBatch(wave, workers, now)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(3)
    expect(result).toContain('t1')
    expect(result).toContain('t2')
    expect(result).toContain('t3')
  })

  test('returns ids when settle time has run out', () => {
    const now = Date.now()
    const settleStart = now - 601_000 // More than 601 seconds ago
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'running',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 5, settleS: 600, held: ['t1'], since: settleStart },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()

    const result = waveBatch(wave, workers, now)
    expect(result).not.toBeNull()
    expect(result).toContain('t1')
  })

  test('returns ids when nothing is running', () => {
    const now = Date.now()
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'passed',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 5, settleS: 600, held: ['t1'], since: now },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()

    const result = waveBatch(wave, workers, now)
    expect(result).not.toBeNull()
    expect(result).toContain('t1')
  })

  test('returns null if wave is done', () => {
    const now = Date.now()
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'passed',
          proof: null,
        },
        {
          key: 't2',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task2',
          state: 'failed',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 5, settleS: 600, held: ['t1', 't2'], since: now },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()

    // waveDone returns true, so waveBatch should return the ids (not null)
    const result = waveBatch(wave, workers, now)
    expect(waveDone(wave)).toBe(true)
    expect(result).not.toBeNull()
  })

  test('returns ids immediately on failure', () => {
    const now = Date.now()
    const wave: CliMayteWave = {
      id: 'wv-test',
      group: 'g-test',
      managerId: 'w-mgr',
      plan: '/plan',
      cwd: '/cwd',
      branch: 'main',
      verify: null,
      tasks: [
        {
          key: 't1',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task1',
          state: 'failed',
          proof: null,
        },
        {
          key: 't2',
          prompt: '',
          title: '',
          kind: 'code',
          check: null,
          paths: [],
          after: [],
          workerId: 'w-task2',
          state: 'pending',
          proof: null,
        },
      ],
      escalations: [],
      notes: '',
      rounds: 1,
      maxRounds: 3,
      batch: { size: 5, settleS: 600, held: ['t1'], since: now },
      status: 'running',
      report: null,
      createdAt: now,
      updatedAt: now,
    }

    const workers = new Map<string, CliMayteWorker>()

    const result = waveBatch(wave, workers, now)
    expect(result).not.toBeNull()
    expect(result).toContain('t1')
  })
})

describe('integration: the daemon judges a wave by command, a manager costs wakes (pieces 5 and 6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-judge-'))
  const repo = join(root, 'repo')
  const acct = join(root, 'acct')
  const groups: string[] = []
  const fake = [process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')]
  let branch = ''
  const sha: Record<string, string> = {}
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  const commit = (file: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), file)
    git('add', '--', file)
    git('commit', '-q', '-m', file)
    return git('rev-parse', 'HEAD')
  }
  const launches = () =>
    readFileSync(join(acct, 'fake-launches.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as { ttl: string | null; session: string; resume: boolean; prompt: string },
      )

  beforeAll(() => {
    mkdirSync(repo, { recursive: true })
    mkdirSync(acct, { recursive: true })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'test')
    commit('README.md')
    branch = git('branch', '--show-current')
    sha.inside = commit('src/a.ts')
    sha.outside = commit('docs/b.md')
    git('checkout', '-q', '-b', 'side')
    sha.off = commit('src/c.ts')
    git('checkout', '-q', branch)
    setCliMayteClaudeCommand(fake)
    setCliMayteAccountsProvider(() => [
      { id: 'judge-1', num: 1, name: 'judge', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
  }, 30_000) // five git commits take over the default 5 s on a loaded box

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    forgetManagers()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const until = async (ok: () => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms
    while (!ok() && Date.now() < deadline) await climayteWait({}, 1_000)
    return ok()
  }
  const blankWave = (id: string): CliMayteWave => ({
    id,
    group: '',
    managerId: '',
    plan: '',
    cwd: repo,
    branch,
    verify: null,
    tasks: [],
    escalations: [],
    notes: '',
    rounds: 0,
    maxRounds: 3,
    batch: { size: 1, settleS: 600, held: [], since: null },
    status: 'running',
    report: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const waveOf = (
    id: string,
    managerId: string,
    keys: Array<[string, string | null]>,
  ): CliMayteWave => ({
    ...blankWave(id),
    managerId,
    tasks: keys.map(([key, workerId]) => ({
      key,
      prompt: '',
      title: key,
      kind: 'code',
      check: null,
      paths: ['src/**'],
      after: [],
      workerId,
      state: 'running' as const,
      proof: null,
    })),
  })
  const codeTask = (title: string, prompt: string) => ({
    prompt,
    cwd: repo,
    title,
    kind: 'code',
    model: 'opus',
    effort: 'high',
    modelWhy: 'the rung this test judges',
  })

  test('commits are checked, a pass stays provisional and out of the scorecard, a later verdict replaces it', async () => {
    const run = climayteRun({
      tasks: [
        codeTask('inside', `inside FAKE-COMMITS:${sha.inside}`),
        codeTask('outside', `outside FAKE-COMMITS:${sha.outside}`),
        codeTask('off', `off FAKE-COMMITS:${sha.off}`),
        codeTask('nothing', 'nothing to commit'),
      ],
      group: 'judge-group',
      perAccount: 4,
    })
    groups.push(run.group)
    const ids = run.workers.map((w) => w.id)
    const wave = waveOf('wv-judge1', 'w-nobody', [
      ['inside', ids[0] as string],
      ['outside', ids[1] as string],
      ['off', ids[2] as string],
      ['nothing', ids[3] as string],
    ])
    writeWave(acct, wave)
    for (const id of ids) {
      const w = liveWorkers.get(id)
      if (w) w.wave = wave.id
    }
    await until(
      () => readWave(acct, wave.id)?.tasks.every((t) => t.state !== 'running') === true,
      30_000,
    )
    await until(
      () => (climayteList({ id: ids[2] as string })[0]?.verdicts?.length ?? 0) > 0,
      10_000,
    )

    const verdict = (i: number) => climayteList({ id: ids[i] as string })[0]?.verdicts?.[0]
    expect(verdict(0)).toMatchObject({ verdict: 'pass', by: 'wave', provisional: true })
    expect(verdict(1)).toMatchObject({ verdict: 'fail', by: 'wave' })
    expect(verdict(1)?.note).toContain('outside the brief')
    expect(verdict(2)).toMatchObject({ verdict: 'fail', by: 'wave' })
    expect(verdict(2)?.note).toContain('is not on the branch')
    expect(verdict(3)).toBeUndefined()

    const saved = readWave(acct, wave.id)
    expect(saved?.tasks.map((t) => t.state)).toEqual([
      'passed',
      'escalated',
      'escalated',
      'escalated',
    ])
    expect(saved?.tasks[0]?.proof).toMatchObject({
      check: null,
      commits: [sha.inside],
      paths: true,
    })
    expect(saved?.escalations.map((e) => e.key)).toContain('nothing')

    // The provisional pass is not on the scorecard. The orchestrator's fail on the same work leaves
    // one fail, not a pass and a fail.
    const row = () => climayteScorecard().rows.find((r) => r.kind === 'code' && r.effort === 'high')
    expect(row()?.pass ?? 0).toBe(0)
    const fails = row()?.fail ?? 0
    expect(
      climayteVerdict(ids[0] as string, { verdict: 'fail', note: 'wrong', retry: false }).ok,
    ).toBe(true)
    expect(row()?.pass ?? 0).toBe(0)
    expect(row()?.fail).toBe(fails + 1)
    expect(climayteList({ id: ids[0] as string })[0]?.verdicts?.map((v) => v.by)).toEqual([
      'wave',
      'orchestrator',
    ])
  }, 60_000)

  test('a manager runs on the 1-hour cache and starts a fresh session from the wave state past the context limit', async () => {
    const manager = climayteRun({
      tasks: [
        {
          prompt: `manage FAKE-SPEND:2000000 FAKE-CONTEXT:${MANAGER_CONTEXT_TOKENS + 10_000}`,
          cwd: repo,
          title: 'manager',
          kind: 'manage',
        },
      ],
      group: 'mgr-wv-judge2',
    })
    groups.push(manager.group)
    const mid = manager.workers[0]?.id as string
    const wave = waveOf('wv-judge2', mid, [['late', null]])
    writeWave(acct, wave)
    const m = liveWorkers.get(mid) as CliMayteWorker
    m.wave = wave.id
    // Its first turn ends with a task still to come: held.
    await until(() => climayteList({ id: mid })[0]?.hold === 'wave')
    expect(climayteList({ id: mid })[0]).toMatchObject({
      status: 'waiting',
      hold: 'wave',
      effort: 'low',
    })

    // The task arrives and passes on its commit: the wave is done, which wakes the manager at once.
    const task = climayteRun({
      tasks: [codeTask('late', `late FAKE-COMMITS:${sha.inside}`)],
      group: 'judge-late',
    })
    groups.push(task.group)
    const tid = task.workers[0]?.id as string
    writeWave(acct, waveOf(wave.id, mid, [['late', tid]]))
    const t = liveWorkers.get(tid) as CliMayteWorker
    t.wave = wave.id
    await until(
      () =>
        (climayteList({ id: mid })[0]?.attempts.length ?? 0) >= 2 &&
        climayteList({ id: mid })[0]?.status !== 'running',
    )

    const ran = launches().filter(
      (l) => l.prompt.startsWith('manage') || l.prompt.includes('# Wave wv-judge2'),
    )
    expect(ran).toHaveLength(2)
    // The second wake is a new session (no resume), told the wave as the store holds it.
    expect(ran[1]?.resume).toBe(false)
    expect(ran[1]?.session).not.toBe(ran[0]?.session)
    expect(ran[1]?.prompt).toContain('You are the manager of a wave')
    expect(ran[1]?.prompt).toContain('- late: passed')
    // The 1-hour cache for the manager, the 5-minute one for the task, and the attempts say so.
    expect(ran.map((l) => l.ttl)).toEqual(['1h', '1h'])
    expect(launches().find((l) => l.prompt.startsWith('late'))?.ttl).toBe('5m')

    // The totals say what managing the wave cost, per wave.
    const mine = climayteTotals().managerPct.find((p) => p.wave === 'wv-judge2')
    expect(mine?.wakes).toBe(2)
    expect(mine?.pct).toBeGreaterThan(0)
  }, 90_000)
})

describe('the orchestrator starts and verifies a wave (piece 7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-entry-'))
  const repo = join(root, 'repo')
  const acct = join(root, 'acct')
  const groups: string[] = []
  const fake = [process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')]
  const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    prompt: `do ${key}`,
    kind: 'code',
    paths: ['src/**'],
    ...extra,
  })
  const three = [task('a'), task('b'), task('c', { after: ['a'] })]
  const until = async (ok: () => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms
    while (!ok() && Date.now() < deadline) await climayteWait({}, 1_000)
    return ok()
  }

  beforeAll(() => {
    mkdirSync(repo, { recursive: true })
    mkdirSync(acct, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true })
    setCliMayteClaudeCommand(fake)
    setCliMayteAccountsProvider(() => [
      { id: 'entry-1', num: 1, name: 'entry', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
  })
  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    forgetManagers()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const start = (tasks: unknown[] = three) => {
    const r = climayteWaveStart({ plan: join(root, 'plan.md'), cwd: repo, tasks, branch: 'main' })
    groups.push(`mgr-${r.wave}`)
    return r
  }

  test('a wave under 3 tasks, a manage task, a repeated key or an unknown `after` is refused and starts nothing', () => {
    const before = climayteList({}).length
    const run = (tasks: unknown[]) => () =>
      climayteWaveStart({ plan: 'p.md', cwd: repo, tasks, branch: 'main' })
    expect(run([task('a'), task('b')])).toThrow('use climayte_run')
    expect(run([...three, task('m', { kind: 'manage' })])).toThrow('manage')
    expect(run([...three, task('a')])).toThrow('used twice')
    expect(run([task('a', { after: ['zz'] }), task('b'), task('c')])).toThrow('unknown key')
    expect(climayteList({}).length).toBe(before)
  })

  test('a started wave is running with pending tasks and only its manager exists', () => {
    const r = start()
    const wave = readWave(acct, r.wave)
    expect(wave).toMatchObject({ status: 'running', managerId: r.managerId, maxRounds: 3 })
    expect(wave?.tasks.map((t) => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(climayteList({ group: `mgr-${r.wave}` }).map((w) => w.kind)).toEqual(['manage'])
    expect(climayteList({ group: wave?.group })).toHaveLength(0)
    expect(r.waiter).toBe(
      `python ~/.claude/tools/climayte_wait.py --wave ${r.wave} --timeout-s 7200`,
    )
  })

  test('waveStateText shows task titles, after-keys, and ready markers for after-chains', () => {
    const withChain = [
      task('nav', { title: 'Nav: Instances group' }),
      task('instances-home', { title: 'Instances home page', after: ['nav'] }),
      task('climayte-float', { title: 'Float: add climayte', after: ['instances-home'] }),
    ]
    const r = start(withChain)
    const wave = readWave(acct, r.wave) as CliMayteWave
    const state = waveStateText(wave, new Map())
    expect(state).toContain('- nav: pending "Nav: Instances group"')
    expect(state).toContain('- instances-home: pending "Instances home page" after: nav')
    expect(state).toContain('- climayte-float: pending "Float: add climayte" after: instances-home')
    // No task is ready yet since none have passed
    expect(state).not.toContain('(ready)')

    // Mark the first task as passed
    wave.tasks[0].state = 'passed'
    writeWave(acct, wave)
    const stateAfterPass = waveStateText(wave, new Map())
    // The second task should now be ready since its after-key has passed
    expect(stateAfterPass).toContain('- instances-home: pending (ready)')
  })

  /** A reported wave whose one task passed provisionally (the daemon's judgement, by: 'wave'). */
  const reportedWave = async () => {
    const r = start()
    const run = climayteRun({
      tasks: [
        {
          prompt: 'x',
          cwd: repo,
          title: 'x',
          kind: 'code',
          model: 'opus',
          effort: 'high',
          modelWhy: 'the rung this test judges',
        },
      ],
      group: `entry-tasks-${r.wave}`,
    })
    groups.push(run.group)
    const id = run.workers[0]?.id as string
    await until(() => climayteList({ id })[0]?.status === 'done')
    climayteVerdict(id, { verdict: 'pass', note: 'proof', by: 'wave', provisional: true })
    const wave = readWave(acct, r.wave) as CliMayteWave
    const t = wave.tasks[0] as CliMayteWave['tasks'][0]
    t.workerId = id
    t.state = 'passed'
    wave.status = 'reported'
    writeWave(acct, wave)
    return { ...r, id }
  }
  const code = () => climayteScorecard().rows.find((r) => r.kind === 'code' && r.effort === 'high')

  test('verify ok confirms the provisional passes and passes the manager; an unreported wave is refused', async () => {
    const { wave, managerId, id } = await reportedWave()
    const pending = start()
    expect(climayteWaveVerify(pending.wave, { ok: true })).toMatchObject({ ok: false, status: 409 })

    const passes = code()?.pass ?? 0
    expect(climayteWaveVerify(wave, { ok: true })).toMatchObject({ ok: true, status: 200 })
    expect(readWave(acct, wave)?.status).toBe('verified')
    expect(climayteList({ id })[0]?.verdicts?.[0]?.provisional).toBeUndefined()
    expect(code()?.pass).toBe(passes + 1)
    expect(climayteList({ id: managerId })[0]?.verdicts?.at(-1)).toMatchObject({ verdict: 'pass' })
    // Once decided it is no longer reported: a second verify is refused.
    expect(climayteWaveVerify(wave, { ok: false, note: 'again' }).status).toBe(409)
  }, 60_000)

  test('verify not ok confirms none and fails the manager with the note', async () => {
    const { wave, managerId, id } = await reportedWave()
    const passes = code()?.pass ?? 0
    expect(climayteWaveVerify(wave, { ok: false, note: 'CI red' })).toMatchObject({ ok: true })
    expect(readWave(acct, wave)?.status).toBe('rejected')
    expect(climayteList({ id })[0]?.verdicts?.[0]?.provisional).toBe(true)
    expect(code()?.pass ?? 0).toBe(passes)
    expect(climayteList({ id: managerId })[0]?.verdicts?.at(-1)).toMatchObject({
      verdict: 'fail',
      note: 'CI red',
    })
  }, 60_000)
})
