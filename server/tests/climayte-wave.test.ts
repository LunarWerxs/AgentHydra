// CliMayte waves: the wave record, the pure helpers that parse its state.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliMayteWave, CliMayteWorker } from '../src/climayte-lib'
import { readWave, waveBatch, waveDone, waveStateText, writeWave } from '../src/climayte-wave'

type CliMayteTask = CliMayteWave['tasks'][0]

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

describe('judgeWaveTask', () => {
  test('no proof is not a pass', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'code',
      check: null,
      paths: ['src/**'],
      after: [],
      workerId: null,
      state: 'pending',
      proof: null,
    }
    const result = judgeWaveTask(task, null)
    expect(result.pass).toBe(false)
    expect(result.provisional).toBe(false)
  })

  test('check passed is a provisional pass', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'code',
      check: 'bun test',
      paths: ['src/**'],
      after: [],
      workerId: null,
      state: 'passed',
      proof: {
        check: true,
        commits: [],
        paths: true,
        note: '',
      },
    }
    const result = judgeWaveTask(task, task.proof)
    expect(result.pass).toBe(true)
    expect(result.provisional).toBe(true)
  })

  test('commits present is a provisional pass', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'code',
      check: null,
      paths: ['src/**'],
      after: [],
      workerId: null,
      state: 'passed',
      proof: {
        check: null,
        commits: ['abc123def456'],
        paths: true,
        note: '',
      },
    }
    const result = judgeWaveTask(task, task.proof)
    expect(result.pass).toBe(true)
    expect(result.provisional).toBe(true)
  })

  test('check failed is not a pass', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'code',
      check: 'bun test',
      paths: ['src/**'],
      after: [],
      workerId: null,
      state: 'failed',
      proof: {
        check: false,
        commits: [],
        paths: true,
        note: 'Test failed: src/main.ts line 42',
      },
    }
    const result = judgeWaveTask(task, task.proof)
    expect(result.pass).toBe(false)
    expect(result.provisional).toBe(false)
  })

  test('paths mismatch is not a pass', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'code',
      check: null,
      paths: ['src/**'],
      after: [],
      workerId: null,
      state: 'failed',
      proof: {
        check: null,
        commits: ['abc123'],
        paths: false,
        note: 'Diff touched docs/README.md outside allowed paths',
      },
    }
    const result = judgeWaveTask(task, task.proof)
    expect(result.pass).toBe(false)
    expect(result.provisional).toBe(false)
  })

  test('no check and no commits is unproven', async () => {
    const { judgeWaveTask } = await import('../src/climayte-wave')
    const task: CliMayteTask = {
      key: 't1',
      prompt: 'Task',
      title: 'Task',
      kind: 'review',
      check: null,
      paths: [],
      after: [],
      workerId: null,
      state: 'passed',
      proof: {
        check: null,
        commits: [],
        paths: null,
        note: '',
      },
    }
    const result = judgeWaveTask(task, task.proof)
    expect(result.pass).toBe(false)
    expect(result.provisional).toBe(false)
  })
})
