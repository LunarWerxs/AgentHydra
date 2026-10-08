// server/tests/mcp-free.test.ts - the Free account tools (server/src/mcp-free.ts) against a stand-in Desk 2
// on a free port (HYDRA_DESK_PORT), never the real one: which account a task goes to, one operation per
// account at a time, and a continuation on its own thread's account.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FREE_TOOLS, type FreeInstance, pickFreeAccount } from '../src/mcp-free'

const usage = (fiveHour: number | null, week: number | null, unlimited = false) => ({
  available: true,
  ...(unlimited ? { unlimited_text: true } : {}),
  windows: unlimited
    ? []
    : [
        { id: 'five_hour', used_percent: fiveHour },
        { id: 'seven_day', used_percent: week },
      ],
})
const INSTANCES: FreeInstance[] = [
  { id: 'a', num: 1, provider: 'claude', name: 'one', loggedIn: true, usage: usage(40, 10) },
  {
    id: 'b',
    num: 2,
    provider: 'chatgpt',
    name: 'two',
    loggedIn: true,
    usage: usage(null, null, true),
  },
  { id: 'c', num: 3, provider: 'claude', name: 'three', loggedIn: false, usage: null },
  { id: 'd', num: 4, provider: 'claude', name: 'four', loggedIn: true, usage: usage(5, 95) },
]
const THREAD = '11111111-1111-4111-8111-111111111111'

describe('pickFreeAccount', () => {
  test('an idle account with room, used longest ago first; never one signed out, and one at 90% of its week only by number', () => {
    // ChatGPT's unlimited text and a Claude window under half used are the same room: Claude first on a tie.
    expect(pickFreeAccount(INSTANCES, new Set(), {})?.num).toBe(1)
    const justUsed = INSTANCES.map((i) => (i.id === 'a' ? { ...i, lastActiveAt: Date.now() } : i))
    expect(pickFreeAccount(justUsed, new Set(), {})?.num).toBe(2)
    const halfUsed = INSTANCES.map((i) => (i.id === 'a' ? { ...i, usage: usage(60, 10) } : i))
    expect(pickFreeAccount(halfUsed, new Set(), {})?.num).toBe(2)
    expect(pickFreeAccount(INSTANCES, new Set(['b']), {})?.num).toBe(1)
    expect(pickFreeAccount(INSTANCES, new Set(['a', 'b']), {})).toBeNull()
    expect(pickFreeAccount(INSTANCES, new Set(), { provider: 'claude' })?.num).toBe(1)
    expect(pickFreeAccount(INSTANCES, new Set(), { account: 4 })?.num).toBe(4)
    expect(pickFreeAccount(INSTANCES, new Set(), { account: 3 })).toBeNull()
  })
})

describe('free_chat through a stand-in Desk 2', () => {
  type Job = {
    id: string
    instanceId: string
    state: 'running' | 'done'
    command: string
    chatId?: string
    result?: unknown
  }
  const jobs = new Map<string, Job>()
  const ran: { instance: string; command: string; chatId?: string; prompt: string }[] = []
  let overlap = 0
  let server: ReturnType<typeof Bun.serve>
  let port: string | undefined

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname.replace('/api/free', '')
        if (path === '/status')
          return Response.json({ ready: true, instances: INSTANCES, jobs: [...jobs.values()] })
        if (path === '/threads')
          return Response.json([
            {
              instanceId: 'b',
              provider: 'chatgpt',
              chatId: THREAD,
              title: 'earlier',
              status: 'done',
              createdAt: 1,
              updatedAt: 2,
              error: null,
            },
          ])
        if (path === '/jobs' && req.method === 'POST') {
          const r = (await req.json()) as {
            requestId: string
            instanceId: string
            command: string
            chatId?: string
            prompt: string
            name?: string
          }
          if (
            [...jobs.values()].some((j) => j.instanceId === r.instanceId && j.state === 'running')
          ) {
            overlap++
            return Response.json(
              { error: 'This account already has an operation running.' },
              { status: 409 },
            )
          }
          const job: Job = {
            id: r.requestId,
            instanceId: r.instanceId,
            state: 'running',
            command: r.command,
            chatId: r.chatId,
          }
          jobs.set(job.id, job)
          // 'refused' is turned away by the first account it reaches, before any chat exists.
          const refuse = r.prompt === 'refused' && !ran.some((x) => x.prompt === 'refused')
          ran.push({
            instance: r.instanceId,
            command: r.command,
            chatId: r.chatId,
            prompt: r.prompt,
          })
          setTimeout(() => {
            job.state = 'done'
            job.result = refuse
              ? {
                  ok: false,
                  error: { code: 'http_rejected', message: 'ChatGPT rejected the HTTP request.' },
                }
              : {
                  ok: true,
                  chat_id: r.chatId ?? crypto.randomUUID(),
                  chat_name: r.name ?? null,
                  response: `re: ${r.prompt}`,
                  model: 'm',
                }
          }, 100)
          return Response.json(job, { status: 202 })
        }
        const job = jobs.get(path.replace('/jobs/', ''))
        return job ? Response.json(job) : Response.json({ error: 'gone' }, { status: 404 })
      },
    })
    port = process.env.HYDRA_DESK_PORT
    process.env.HYDRA_DESK_PORT = String(server.port)
  })
  afterAll(() => {
    if (port === undefined) delete process.env.HYDRA_DESK_PORT
    else process.env.HYDRA_DESK_PORT = port
    server.stop(true)
  })
  const run = (name: string, args: Record<string, unknown>) =>
    FREE_TOOLS.find((t) => t.name === name)!.run(args) as Promise<any>

  test('more tasks than idle accounts all finish, one operation per account at a time; a continuation goes to its thread', async () => {
    const out = await run('free_chat', {
      tasks: [
        { prompt: 'p1' },
        { prompt: 'p2' },
        { prompt: 'p3', name: 'named' },
        { prompt: 'again', chat_id: THREAD },
      ],
    })
    expect(out.finished).toBe(true)
    expect(out.tasks.map((t: { state: string }) => t.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ])
    expect(out.tasks[3]).toMatchObject({
      chat_id: THREAD,
      account: '#2 chatgpt (two)',
      response: 're: again',
    })
    expect(ran.find((r) => r.prompt === 'again')).toMatchObject({
      instance: 'b',
      command: 'resume',
      chatId: THREAD,
    })
    // Never the signed-out #3 or #4 at 95% of its week, and never a second operation on a busy account.
    expect(new Set(ran.map((r) => r.instance))).toEqual(new Set(['a', 'b']))
    expect(overlap).toBe(0)
    const batch = await run('free_results', { batch: out.batch, wait_s: 0 })
    expect(batch.done).toBe('4 of 4')
  }, 30_000)

  test('a new thread its account refuses is answered by another idle account, and the refusing one rests', async () => {
    // 2026-10-07: a failing ChatGPT account stayed first in line and took ~3,700 sends in a row.
    const out = await run('free_chat', { tasks: [{ prompt: 'refused' }] })
    expect(out.tasks[0]).toMatchObject({ state: 'done', response: 're: refused' })
    expect(out.tasks[0].retried).toContain('http_rejected')
    const [first, second] = ran.filter((r) => r.prompt === 'refused').map((r) => r.instance)
    expect(second).not.toBe(first)
    const status = await run('free_status', {})
    const refuser = INSTANCES.find((i) => i.id === first)!
    expect(status.accounts.find((a: { num: number }) => a.num === refuser.num).resting).toContain(
      'http_rejected',
    )
    // While it rests, new work goes to the account that answered.
    await run('free_chat', { tasks: [{ prompt: 'next' }] })
    expect(ran.find((r) => r.prompt === 'next')?.instance).toBe(second)
  }, 30_000)

  test('a task no signed-in account can take fails at once, naming why', async () => {
    const out = await run('free_chat', { tasks: [{ prompt: 'x', account: 3 }] })
    expect(out.tasks[0].state).toBe('failed')
    expect(out.tasks[0].error).toContain('account #3')
  }, 15_000)
})
