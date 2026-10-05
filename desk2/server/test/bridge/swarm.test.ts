import { expect, test } from 'bun:test'
import { createBridge } from '../../src/bridge'
import { RECENT_FINISHED } from '../../src/bridge/climayte'
import { mapRemoteJobs, mapSwarmJobs } from '../../src/bridge/swarm'
import { startFakeHydra } from './fake-hydra'

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

const CHAT = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SESSION = '11111111-2222-3333-4444-555555555555'
const chats = new Map([[CHAT, { sessionId: SESSION, title: 'Example chat' }]])

test('the job list keeps every running job and the 20 newest finished ones, with the caller read from the stamp', () => {
  const finished = Array.from({ length: 25 }, (_, i) => job(i + 1))
  const running = job(0, { state: 'running', finished: null, label: '', counts: { ok: 1, pending: 3 } })
  const whole = job(30, { caller_ids: { session_id: '11111111-2222-4333-8444-555555555555', chat_id: '', instance: 'default' } })
  const mapped = mapSwarmJobs({ jobs: [...finished, running, whole] })

  expect(mapped.filter((j) => j.active).map((j) => j.id)).toEqual([running.job_id])
  const done = mapped.filter((j) => !j.active)
  expect(done).toHaveLength(RECENT_FINISHED)
  expect(done[0]!.id).toBe(whole.job_id) // newest first
  expect(done.some((j) => j.id === finished[0]!.job_id)).toBe(false) // the oldest five are cut

  // Without caller_ids the old key's 8-character prefix is all there is.
  expect(mapped[0]).toMatchObject({ title: running.job_id, status: 'running', endedAt: null, tasks: { total: 4, done: 1, failed: 0, cancelled: 0 }, callerSessionId: '0a1b2c3d', callerHostSessionId: null, callerTitle: null, pc: null })
  expect(done[1]!).toMatchObject({ tasks: { total: 4, done: 3, failed: 1 } })
  expect(done[0]).toMatchObject({ callerSessionId: '11111111-2222-4333-8444-555555555555', callerHostSessionId: null })
  expect(mapSwarmJobs(null)).toEqual([])
})

test('a Desktop chat that has only a chat id is placed by its session id and named by its title', () => {
  const [j] = mapSwarmJobs({ jobs: [job(1, { caller_ids: { session_id: '', chat_id: CHAT, instance: 'default' }, counts: { ok: 1, cancelled: 3 } })] }, chats)
  expect(j).toMatchObject({ callerSessionId: SESSION, callerHostSessionId: CHAT, callerTitle: 'Example chat', tasks: { total: 4, done: 1, failed: 0, cancelled: 3 } })
  // An unknown chat keeps its id and has no session or title.
  const [u] = mapSwarmJobs({ jobs: [job(2, { caller_ids: { session_id: '', chat_id: 'local_unknown', instance: 'default' } })] }, chats)
  expect(u).toMatchObject({ callerSessionId: null, callerHostSessionId: 'local_unknown', callerTitle: null })
})

test("another PC's jobs keep that PC's name, resolve a chat known here and leave a stale PC out", () => {
  const remote = (id: string, o: Record<string, unknown> = {}) => ({ id, label: id, state: 'running', tasks: 2, counts: { cancelled: 1 }, created: '2026-10-05T10:00:00.000Z', finished: null, callerSessionId: null, callerChatId: null, ...o })
  const answer = {
    enabled: true,
    pcs: [
      { pc: 'p1', name: 'Other-PC', at: 1, stale: false, workers: [], jobs: [remote('r-1', { callerChatId: CHAT }), remote('r-2', { callerSessionId: '99999999-0000-4000-8000-000000000000', callerChatId: 'local_elsewhere' })] },
      { pc: 'p2', name: 'Old-PC', at: 1, stale: true, workers: [], jobs: [remote('r-3')] },
      { pc: 'p3', name: 'Plain-PC', at: 1, stale: false, workers: [] }
    ]
  }
  const mapped = mapRemoteJobs(answer, chats)
  expect(mapped.map((j) => j.id).sort()).toEqual(['r-1', 'r-2'])
  expect(mapped.every((j) => j.pc === 'Other-PC')).toBe(true)
  expect(mapped.find((j) => j.id === 'r-1')).toMatchObject({ callerSessionId: SESSION, callerHostSessionId: CHAT, callerTitle: 'Example chat', tasks: { total: 2, cancelled: 1 } })
  expect(mapped.find((j) => j.id === 'r-2')).toMatchObject({ callerSessionId: '99999999-0000-4000-8000-000000000000', callerHostSessionId: 'local_elsewhere', callerTitle: null })
  expect(mapRemoteJobs({ enabled: false, pcs: answer.pcs }, chats)).toEqual([])
})

test('the bridge resolves a job\'s chat through /api/chats, reading the chat list once a minute and keeping the last map on failure', async () => {
  const f = await startFakeHydra()
  try {
    let t = 1_000_000
    const body = (state: string) => ({ jobs: [job(1, { state, caller_ids: { session_id: '', chat_id: CHAT, instance: 'default' } })] })
    const hits: string[] = []
    const real = f.state
    f.state.chats = { rows: [{ instance: 'default', chatId: CHAT, sessionId: SESSION, title: 'Example chat', archived: false, lastActivityAt: null, cwd: null, live: false }] }
    const origFetch = globalThis.fetch
    const fetchStub = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input)
      if (url.includes('/api/hswarm/api/jobs')) return new Response(JSON.stringify(body('running')), { headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/chats')) hits.push('chats')
      return origFetch(input, init)
    }) as typeof fetch
    const b = createBridge({ url: f.url, now: () => t, fetch: fetchStub })
    expect((await b.swarmJobs())[0]).toMatchObject({ callerSessionId: SESSION, callerTitle: 'Example chat' })
    t += 10_000
    await b.swarmJobs()
    expect(hits).toHaveLength(1)
    t += 60_000
    // The jobs are asked again (10 s passed) and so is the chat list (60 s passed).
    real.chats = { rows: null as any } // the next read of the chat list fails
    expect((await b.swarmJobs())[0]).toMatchObject({ callerSessionId: SESSION })
  } finally {
    await f.stop()
  }
})
