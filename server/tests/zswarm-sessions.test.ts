// server/tests/zswarm-sessions.test.ts - the DeepSeek zswarm job reader (server/src/zswarm-sessions.ts).
//
// A real fixture store: real directories, real job.json files, written with the same layout
// `Lunarwerx/zswarm`'s `zswarm/jobstore.py` writes (job.summary/tasks/results). Nothing is mocked -
// every bug this reader can have is a bug about the shape of job.json on disk.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listZswarmSessions, readZswarmSession } from '../src/zswarm-sessions'

const homes: string[] = []
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zswarm-home-'))
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
    job_id: '20260915-051622-08a3',
    label: 'mcp-smoke',
    state: 'done',
    created: '2026-09-15T05:16:22+00:00',
    finished: '2026-09-15T05:16:25+00:00',
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
      started: '2026-09-15T05:16:22+00:00',
      finished: '2026-09-15T05:16:24+00:00',
    },
    broken: {
      id: 'broken',
      status: 'error',
      error: 'sandbox timeout',
      started: '2026-09-15T05:16:24+00:00',
      finished: '2026-09-15T05:16:25+00:00',
    },
  },
}

describe('listZswarmSessions', () => {
  test('lists a job by its own job.json summary', () => {
    const home = newHome()
    writeJob(home, JOB_TWO_TASKS.summary.job_id, JOB_TWO_TASKS)
    const rows = listZswarmSessions(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.session_id).toBe('20260915-051622-08a3')
    expect(rows[0]?.title).toBe('mcp-smoke')
    expect(rows[0]?.cwd).toBe('C:\\Users\\blogi\\scratch')
    expect(rows[0]?.archived).toBe(false)
    expect(rows[0]?.size_bytes).toBeGreaterThan(0)
  })

  test('a job directory with no job.json yet contributes nothing', () => {
    const home = newHome()
    mkdirSync(join(home, 'jobs', 'still-running'), { recursive: true })
    expect(listZswarmSessions(home)).toEqual([])
  })

  test('a zswarm home that does not exist lists as empty, not an error', () => {
    expect(listZswarmSessions(join(tmpdir(), 'no-such-zswarm-home-at-all'))).toEqual([])
  })

  test('falls back to the job id when the job carries no label', () => {
    const home = newHome()
    writeJob(home, 'unlabeled-job', {
      summary: { job_id: 'unlabeled-job', created: '2026-09-15T00:00:00+00:00' },
      tasks: [],
      results: {},
    })
    const rows = listZswarmSessions(home)
    expect(rows[0]?.title).toBe('unlabeled-job')
    expect(rows[0]?.project).toBe('unlabeled-job')
  })
})

describe('readZswarmSession', () => {
  test('turns each task into a prompt/answer pair, in task order', () => {
    const home = newHome()
    const path = writeJob(home, JOB_TWO_TASKS.summary.job_id, JOB_TWO_TASKS)
    const content = readZswarmSession(path)
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
    const events = readZswarmSession(path)?.events ?? []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ role: 'user', text: 'still going' })
  })

  test('an unreadable job.json returns null rather than throwing', () => {
    const home = newHome()
    const dir = join(home, 'jobs', 'corrupt')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'job.json'), '{not json')
    expect(readZswarmSession(join(dir, 'job.json'))).toBeNull()
  })
})
