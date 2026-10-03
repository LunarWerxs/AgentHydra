// Manager MCP endpoint: JSON-RPC tools/call POSTed to /api/corch/mcp/:managerId.
// The route is mounted on its own Hono app with the caller's pid injected (the OS socket lookup is
// the only part a test cannot supply); everything behind it is the real wave store and workers.
// docs/CLIMAYTE.md, "Scope and identity of the manager endpoint".

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteRun,
  climayteWaveStart,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import { DISPATCH_SUFFIX, registerManagerMcpRoute } from '../src/climayte-manager-mcp'
import { readWave, writeWave } from '../src/climayte-wave'

const CALLER = 4242

describe('manager MCP endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-mgr-'))
  const repo = join(root, 'repo')
  const acct = join(root, 'acct')
  const fake = [process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')]
  const groups: string[] = []
  let callerPid: number | null = CALLER
  const app = new Hono()
  registerManagerMcpRoute(app, async () => callerPid)

  beforeAll(() => {
    mkdirSync(repo, { recursive: true })
    mkdirSync(acct, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, windowsHide: true })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'README.md'), 'x')
    git('add', '--', 'README.md')
    git('commit', '-q', '-m', 'init')
    setCliMayteClaudeCommand(fake)
    setCliMayteAccountsProvider(() => [
      { id: 'mgr-1', num: 1, name: 'mgr', configDir: acct, sessionPct: 0, weekPct: 0 },
    ])
    startCliMayte()
  }, 30_000)

  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    for (const [id, w] of workers) if (w.kind === 'manage') workers.delete(id)
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    prompt: `do ${key}`,
    paths: [] as string[],
    ...extra,
  })

  /** A wave of three tasks (t1; t2 after t1; t3) and its manager, whose CLI "is" CALLER. */
  function newWave(extra: Record<string, unknown> = {}) {
    const started = climayteWaveStart({
      plan: join(repo, 'plan.md'),
      cwd: repo,
      tasks: [task('t1'), task('t2', { after: ['t1'] }), task('t3')],
      ...extra,
    })
    groups.push(`wave-${started.wave}`)
    // The manager must not run: its pid is the test's.
    climayteCancel({ id: started.managerId })
    const manager = workers.get(started.managerId) as CliMayteWorker
    manager.attempts = [
      {
        account: { id: 'mgr-1', num: 1, name: 'mgr' },
        pid: CALLER,
        log: '',
        errLog: '',
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: 'done',
        notice: null,
        resumed: false,
      },
    ]
    return started
  }

  const call = async (managerId: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request(`/api/corch/mcp/${managerId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const json = (await res.json()) as {
      error?: unknown
      result?: { isError?: boolean; content: Array<{ text: string }> }
    }
    return {
      status: res.status,
      error: json.error,
      isError: json.result?.isError,
      value: json.result ? JSON.parse(json.result.content[0]?.text ?? 'null') : undefined,
    }
  }

  test('a non-manager and a wrong pid are refused', async () => {
    const { wave, managerId } = newWave()
    const [plain] = climayteRun({ tasks: [{ prompt: 'x', cwd: repo }], group: 'plain-g' }).workers
    groups.push('plain-g')
    expect((await call(plain?.id as string, 'wave_state')).status).toBe(403)
    expect((await call('w-nonexistent', 'wave_state')).status).toBe(403)
    callerPid = CALLER + 1
    expect((await call(managerId, 'wave_state')).status).toBe(403)
    callerPid = null
    expect((await call(managerId, 'wave_state')).status).toBe(403)
    callerPid = CALLER
    const ok = await call(managerId, 'wave_state')
    expect(ok.status).toBe(200)
    expect(ok.value).toContain(`# Wave ${wave}`)
  })

  test('wave_dispatch starts a worker in the wave group, and refuses what the plan forbids', async () => {
    const { wave, managerId } = newWave({ maxRounds: 1 })
    const first = await call(managerId, 'wave_dispatch', { keys: ['t2', 't1', 'nope'] })
    const [t2, t1, nope] = first.value.results
    expect(t2.refused).toContain('after not met')
    expect(nope.refused).toContain('no such key')
    const worker = workers.get(t1.started) as CliMayteWorker
    expect(worker.group).toBe(`wave-${wave}`)
    expect(worker.wave).toBe(wave)
    expect(worker.prompt).toBe(`do t1\n\n${DISPATCH_SUFFIX}`)
    const rec = readWave(acct, wave)
    expect(rec?.tasks[0]).toMatchObject({ workerId: t1.started, state: 'running', dispatches: 1 })

    // Already running: nothing new starts.
    const again = await call(managerId, 'wave_dispatch', { keys: ['t1'] })
    expect(again.value.results[0].refused).toContain('already running')

    // A key past maxRounds (1 re-dispatch allowed, already used up) is refused.
    const w = readWave(acct, wave)
    if (!w) throw new Error('no wave')
    w.tasks[2] = { ...(w.tasks[2] as (typeof w.tasks)[number]), state: 'failed', dispatches: 2 }
    writeWave(acct, w)
    const past = await call(managerId, 'wave_dispatch', { keys: ['t3'] })
    expect(past.value.results[0].refused).toContain('past maxRounds')
    // One re-dispatch is still allowed.
    w.tasks[2] = { ...(w.tasks[2] as (typeof w.tasks)[number]), dispatches: 1 }
    writeWave(acct, w)
    const last = await call(managerId, 'wave_dispatch', { keys: ['t3'] })
    expect(workers.has(last.value.results[0].started)).toBe(true)
  })

  test('wave_dispatch refuses the manage kind', async () => {
    const { wave, managerId } = newWave()
    const w = readWave(acct, wave)
    if (!w) throw new Error('no wave')
    w.tasks[0] = { ...(w.tasks[0] as (typeof w.tasks)[number]), kind: 'manage' }
    writeWave(acct, w)
    const r = await call(managerId, 'wave_dispatch', { keys: ['t1'] })
    expect(r.value.results[0].refused).toContain('manage')
  })

  test('escalate, note and cancel change the wave record', async () => {
    const { wave, managerId } = newWave()
    const started = (await call(managerId, 'wave_dispatch', { keys: ['t1'] })).value.results[0]
    expect((await call(managerId, 'wave_note', { text: 'n'.repeat(3000) })).value.chars).toBe(2000)
    await call(managerId, 'wave_escalate', { key: 't3', reason: 'needs a decision' })
    const cancelled = await call(managerId, 'wave_cancel', { key: 't1' })
    expect(cancelled.value.state).toBe('failed')
    const rec = readWave(acct, wave)
    expect(rec?.notes.length).toBe(2000)
    expect(rec?.escalations[0]).toMatchObject({ key: 't3', reason: 'needs a decision' })
    expect(rec?.tasks[2]?.state).toBe('escalated')
    expect(rec?.tasks[0]?.state).toBe('failed')
    expect(workers.get(started.started)?.status).toBe('cancelled')
  })

  test('wave_report sets status reported with the table first', async () => {
    const { wave, managerId } = newWave()
    const r = await call(managerId, 'wave_report', { text: 'r'.repeat(3000) })
    expect(r.value).toEqual({ ok: true, status: 'reported' })
    const rec = readWave(acct, wave)
    expect(rec?.status).toBe('reported')
    const lines = (rec?.report ?? '').split('\n')
    expect(lines[0]).toBe('key | state | proof | commits')
    expect(lines.slice(1, 4).map((l) => l.split(' | ')[0])).toEqual(['t1', 't2', 't3'])
    expect(lines).toContain(
      `branch ${rec?.branch} head ${execFileSync('git', ['rev-parse', rec?.branch ?? ''], { cwd: repo, encoding: 'utf8' }).trim()}`,
    )
    expect(lines.at(-1)?.length).toBe(2000)
    // A second report is refused: the wave is no longer running.
    expect((await call(managerId, 'wave_report', { text: 'again' })).value.error).toContain(
      'already reported',
    )
  })
})
