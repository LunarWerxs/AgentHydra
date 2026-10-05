import { expect, test } from 'bun:test'
import { mapSwarmJobs, RECENT_FINISHED_JOBS } from '../../src/bridge/swarm'

// HSwarm's jobs list as AgentHydra proxies it (hswarm/console.py _jobs), made up.
const job = (n: number, o: Record<string, unknown> = {}) => ({
  job_id: `20261005-0000${String(n).padStart(2, '0')}-ab${n}`,
  label: `Job ${n}`,
  state: 'done',
  tasks: 4,
  counts: { ok: 3, failed: 1 },
  caller: 'default / 0a1b2c3d / project',
  created: new Date(Date.UTC(2026, 9, 5, 10, n)).toISOString(),
  finished: new Date(Date.UTC(2026, 9, 5, 10, n, 30)).toISOString(),
  ...o
})

test('the job list keeps every running job and the 20 newest finished ones, with the caller read from the stamp', () => {
  const finished = Array.from({ length: 25 }, (_, i) => job(i + 1))
  const running = job(0, { state: 'running', finished: null, label: '', counts: { ok: 1, pending: 3 } })
  const whole = job(30, { caller: { session_id: '11111111-2222-4333-8444-555555555555', chat_id: '66666666-7777-4888-8999-000000000000' } })
  const mapped = mapSwarmJobs({ jobs: [...finished, running, whole] })

  expect(mapped.filter((j) => j.active).map((j) => j.id)).toEqual([running.job_id])
  const done = mapped.filter((j) => !j.active)
  expect(done).toHaveLength(RECENT_FINISHED_JOBS)
  expect(done[0]!.id).toBe(whole.job_id) // newest first
  expect(done.some((j) => j.id === finished[0]!.job_id)).toBe(false) // the oldest five are cut

  expect(mapped[0]).toMatchObject({ title: running.job_id, status: 'running', endedAt: null, tasks: { total: 4, done: 1, failed: 0 }, callerSessionId: '0a1b2c3d', callerHostSessionId: null })
  expect(done[1]!).toMatchObject({ tasks: { total: 4, done: 3, failed: 1 } })
  expect(done[0]).toMatchObject({ callerSessionId: '11111111-2222-4333-8444-555555555555', callerHostSessionId: '66666666-7777-4888-8999-000000000000' })
  expect(mapSwarmJobs(null)).toEqual([])
})
