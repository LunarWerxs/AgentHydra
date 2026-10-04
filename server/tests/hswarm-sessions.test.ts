// server/tests/hswarm-sessions.test.ts - the HSwarm job reader (server/src/hswarm-sessions.ts).
//
// A real fixture store: real directories, real job.json files, written with the same layout
// `hswarm/job.py` writes (job.summary/tasks/results). Nothing is mocked -
// every bug this reader can have is a bug about the shape of job.json on disk.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hswarmRunsBySessionPrefix,
  listHSwarmSessions,
  listHSwarmSessionsAsync,
  readHSwarmSession,
} from '../src/hswarm-sessions'

const homes: string[] = []
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hswarm-home-'))
  homes.push(dir)
  return dir
}

function writeJob(home: string, jobId: string, job: unknown): string {
  const dir = join(home, 'jobs', jobId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'job.json')
  writeFileSync(path, JSON.stringify(job))
  return path
}

const JOB_TWO_TASKS = {
  summary: {
    job_id: '20240715-051622-08a3',
    label: 'mcp-smoke',
    state: 'done',
    // 2024-07-15T05:16:22Z (a Monday, 104 weeks back) so this fixture never drifts near "today".
    created: '2024-07-15T05:16:22+00:00',
    finished: '2024-07-15T05:16:25+00:00',
  },
  tasks: [
    { id: 'lines', prompt: 'How many lines are in a.txt?', cwd: 'C:\\Users\\blogi\\scratch' },
    { id: 'broken', prompt: 'This task fails on purpose.', cwd: 'C:\\Users\\blogi\\scratch' },
  ],
  results: {
    lines: {
      id: 'lines',
      status: 'ok',
      answer: '3',
      started: '2024-07-15T05:16:22+00:00',
      finished: '2024-07-15T05:16:24+00:00',
    },
    broken: {
      id: 'broken',
      status: 'error',
      error: 'sandbox timeout',
      started: '2024-07-15T05:16:24+00:00',
      finished: '2024-07-15T05:16:25+00:00',
    },
  },
}

describe('listHSwarmSessions', () => {
  test('lists a job by its own job.json summary', () => {
    const home = newHome()
    writeJob(home, JOB_TWO_TASKS.summary.job_id, JOB_TWO_TASKS)
    const rows = listHSwarmSessions(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.session_id).toBe('20240715-051622-08a3')
    expect(rows[0]?.title).toBe('mcp-smoke')
    expect(rows[0]?.cwd).toBe('C:\\Users\\blogi\\scratch')
    expect(rows[0]?.archived).toBe(false)
    expect(rows[0]?.size_bytes).toBeGreaterThan(0)
  })

  test('a job directory with no job.json yet contributes nothing', () => {
    const home = newHome()
    mkdirSync(join(home, 'jobs', 'still-running'), { recursive: true })
    expect(listHSwarmSessions(home)).toEqual([])
  })

  test('an HSwarm home that does not exist lists as empty, not an error', () => {
    expect(listHSwarmSessions(join(tmpdir(), 'no-such-hswarm-home-at-all'))).toEqual([])
  })

  // Regression (2026-09-27): every whole-store sweep re-read and re-parsed every job.json - 625 jobs,
  // 279 MB, 1.2 s on the daemon's one thread, several times a minute - and a daemon that blocks
  // that long misses the tray watchdog's health probes. Parses of this fixture are counted off the
  // global JSON.parse by a marker only its jobs carry.
  test('a relisting parses only the jobs that changed, and still reads those', async () => {
    const home = newHome()
    const MARK = 'hswarm-reread-'
    const job = (id: string, label: string) =>
      writeJob(home, id, { summary: { job_id: `${MARK}${id}`, label }, tasks: [], results: {} })
    job('a', 'alpha')
    job('b', 'beta')
    // Past the racily-clean window (core/stat-stamp.ts), so an unchanged job may be reused.
    await Bun.sleep(1_100)
    const parse = spyOn(JSON, 'parse')
    const parses = () =>
      parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(MARK)).length
    try {
      expect(
        listHSwarmSessions(home)
          .map((r) => r.title)
          .sort(),
      ).toEqual(['alpha', 'beta'])
      expect(parses()).toBe(2)

      parse.mockClear()
      expect(listHSwarmSessions(home)).toHaveLength(2)
      expect(parses()).toBe(0)

      // The async listing the sweep uses shares the cache, and re-reads the job that changed.
      job('b', 'beta, still running')
      parse.mockClear()
      const rows = await listHSwarmSessionsAsync(home)
      expect(rows.find((r) => r.session_id === `${MARK}b`)?.title).toBe('beta, still running')
      expect(parses()).toBe(1)
    } finally {
      parse.mockRestore()
    }
  })

  test('falls back to the job id when the job carries no label', () => {
    const home = newHome()
    writeJob(home, 'unlabeled-job', {
      summary: { job_id: 'unlabeled-job', created: '2024-07-15T00:00:00+00:00' },
      tasks: [],
      results: {},
    })
    const rows = listHSwarmSessions(home)
    expect(rows[0]?.title).toBe('unlabeled-job')
    expect(rows[0]?.project).toBe('unlabeled-job')
  })
})

describe('readHSwarmSession', () => {
  test('turns each task into a prompt/answer pair, in task order', () => {
    const home = newHome()
    const path = writeJob(home, JOB_TWO_TASKS.summary.job_id, JOB_TWO_TASKS)
    const content = readHSwarmSession(path)
    expect(content).not.toBeNull()
    const events = content?.events ?? []
    // task 1: user prompt, assistant answer
    expect(events[0]).toMatchObject({
      role: 'user',
      kind: 'text',
      text: 'How many lines are in a.txt?',
    })
    expect(events[1]).toMatchObject({ role: 'assistant', kind: 'text', text: '3' })
    // task 2 (errored): user prompt, assistant text carrying the error, not silently dropped
    expect(events[2]).toMatchObject({
      role: 'user',
      kind: 'text',
      text: 'This task fails on purpose.',
    })
    expect(events[3]).toMatchObject({ role: 'assistant', kind: 'text' })
    expect(events[3]?.text).toContain('sandbox timeout')
    expect(content?.messageCount).toBe(4)
  })

  test('a task with no result yet still shows its prompt', () => {
    const home = newHome()
    const path = writeJob(home, 'mid-run', {
      summary: { job_id: 'mid-run' },
      tasks: [{ id: 't1', prompt: 'still going' }],
      results: {},
    })
    const events = readHSwarmSession(path)?.events ?? []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ role: 'user', text: 'still going' })
  })

  test('an unreadable job.json returns null rather than throwing', () => {
    const home = newHome()
    const dir = join(home, 'jobs', 'corrupt')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'job.json'), '{not json')
    expect(readHSwarmSession(join(dir, 'job.json'))).toBeNull()
  })
})

describe('hswarmRunsBySessionPrefix', () => {
  test('counts every run HSwarm recorded for a chat, under the 8 characters of it HSwarm keeps', () => {
    const home = newHome()
    // HSwarm's own run table (hswarm/utilization.py), with the column the count reads.
    const con = new Database(join(home, 'hswarm.sqlite'))
    con.run('create table utilizations (id text primary key, caller_session text)')
    const add = con.prepare('insert into utilizations values (?, ?)')
    for (const [id, caller] of [
      ['r1', 'c0e447dd'],
      ['r2', 'c0e447dd'],
      ['r3', '5a1b2c3d'],
      ['r4', ''], // a run nothing called from a chat
    ])
      add.run(id, caller)
    add.finalize()
    con.close()
    const counts = hswarmRunsBySessionPrefix(home)
    expect(Object.fromEntries(counts)).toEqual({ c0e447dd: 2, '5a1b2c3d': 1 })
    expect(hswarmRunsBySessionPrefix(newHome()).size).toBe(0)
  })
})
