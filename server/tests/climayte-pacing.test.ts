// server/tests/climayte-pacing.test.ts — launches are paced machine-wide (climayte-pacing.ts): after a
// PC restart 17 interrupted workers relaunched in one second and the desktop lagged for minutes.
// The contract: at most LAUNCH_BURST launches per LAUNCH_WINDOW_MS across every path; a worker
// without a slot stays due and goes on a later tick (never dropped); a turn a person just sent goes
// first, background resumes after a restart last, each rank in dueOrder.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workers } from '../src/climayte-core'
import type { CliMayteAccount, CliMayteWorker } from '../src/climayte-lib'
import { LAUNCH_BURST, LAUNCH_WINDOW_MS, setLaunchPacing } from '../src/climayte-pacing'
import { scheduleDue, setLauncher, tickState } from '../src/climayte-schedule'
import './no-chats'

// 7 accounts, as in the measured restart: no per-account cap is what limits these tests.
const accounts: CliMayteAccount[] = Array.from({ length: 7 }, (_, i) => ({
  id: `acct-pace-${i}`,
  num: 100 + i,
  name: `pace${i}@example.com`,
  configDir: join(tmpdir(), `acct-pace-${i}`),
  sessionPct: 5,
  weekPct: 5,
}))

const t0 = 1_800_000_000_000
const ids: string[] = []
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
  ids.push(id)
  return w
}
const interrupted = { account: accounts[0], startedAt: t0 - 1, endedAt: t0, outcome: 'interrupted' }

let started: string[] = []
beforeEach(() => {
  setLaunchPacing(true)
  started = []
  setLauncher((w) => {
    w.status = 'running'
    started.push(w.id)
  })
})
afterEach(() => {
  setLaunchPacing(false)
  setLauncher(null)
  for (const id of ids.splice(0)) workers.delete(id)
})

/** What tick() does: the due ones, then the scheduling pass at `now`. */
const tickAt = (now: number): void => {
  const due = [...workers.values()].filter((w) => ids.includes(w.id) && w.status === 'queued')
  scheduleDue(tickState(accounts, now), due)
}

describe('launch pacing', () => {
  test('17 due workers launch at most LAUNCH_BURST in the first window and all within ceil(17/N) windows', () => {
    for (let i = 0; i < 17; i++) mk(`w-${i}`, { attempts: [interrupted] as any, createdAt: t0 + i })
    tickAt(t0)
    expect(started).toHaveLength(LAUNCH_BURST)
    // More ticks inside the same window start nothing more.
    tickAt(t0 + 1_000)
    tickAt(t0 + LAUNCH_WINDOW_MS - 1)
    expect(started).toHaveLength(LAUNCH_BURST)
    const windows = Math.ceil(17 / LAUNCH_BURST)
    for (let k = 1; k < windows; k++) tickAt(t0 + k * LAUNCH_WINDOW_MS)
    expect(started).toHaveLength(17)
    expect(new Set(started).size).toBe(17)
    // Nothing lost: each stays a queued-then-running worker, none failed.
    for (let i = 0; i < 17; i++) expect(workers.get(`w-${i}`)?.status).toBe('running')
  })

  test('a person’s chat follow-up queued behind 10 background resumes launches in the first window', () => {
    for (let i = 0; i < 10; i++)
      mk(`bg-${i}`, { attempts: [interrupted] as any, createdAt: t0 - 100 + i, priority: 9 })
    mk('person', {
      chat: true,
      createdAt: t0 + 50,
      attempts: [{ ...interrupted, outcome: 'done' }] as any,
    })
    tickAt(t0)
    expect(started).toHaveLength(LAUNCH_BURST)
    expect(started[0]).toBe('person')
    // The others held: still queued, due on the next window's tick.
    expect(workers.get('bg-9')?.status).toBe('queued')
  })

  test('other work goes before background resumes, each rank in dueOrder', () => {
    mk('resume-old', { attempts: [interrupted] as any, createdAt: t0 })
    mk('fresh-new', { createdAt: t0 + 10 })
    mk('fresh-old', { createdAt: t0 + 5 })
    mk('person', { chat: true, createdAt: t0 + 20 })
    mk('resume-new', { attempts: [interrupted] as any, createdAt: t0 + 30 })
    tickAt(t0)
    expect(started).toEqual(['person', 'fresh-old', 'fresh-new'])
    tickAt(t0 + LAUNCH_WINDOW_MS)
    expect(started.slice(3)).toEqual(['resume-old', 'resume-new'])
  })
})
