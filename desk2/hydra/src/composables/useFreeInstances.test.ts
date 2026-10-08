// Opening the Free tab used to check every account it found stale, a spinner on each row's 5-hour and week cells
// every time (owner, 2026-10-06). Desk now reads the accounts itself (server/src/free-instances/refresh.ts): the
// tab's refresh only reads the list, and Desk's own reads (FreeJob.auto) show no spinner.
import { expect, it } from 'bun:test'
import type { FreeInstance, FreeStatus } from '@desk/shared/free-instances'
import { useFreeInstances } from './useFreeInstances'

const account: FreeInstance = {
  id: '11111111-2222-4333-8444-555555555555', num: 1, provider: 'claude', name: 'Example account', autoName: false,
  loggedIn: true, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null,
}

it("opening the tab starts no operation and spins nothing, while Desk's own read runs", async () => {
  const status: FreeStatus = {
    ready: true,
    instances: [account],
    jobs: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', instanceId: account.id, provider: 'claude', command: 'auth', state: 'running', phase: 'working', startedAt: 1, auto: true }],
  }
  const posts: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') posts.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/threads') ? [] : status), { status: 200 })
  }) as typeof fetch
  try {
    const free = useFreeInstances()
    const read = free.refreshFree({ silent: true })
    expect(free.loading.value).toBe(false)
    await read
    expect([free.instances.value.length, posts, free.busy(account.id)]).toEqual([1, [], false])
  } finally {
    globalThis.fetch = realFetch
  }
})

it('a check that finished keeps its result when the list refresh after it fails', async () => {
  const done = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', instanceId: account.id, provider: 'claude', command: 'auth', state: 'done', phase: 'done', startedAt: 1, result: { ok: true, authenticated: true } }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) =>
    init?.method === 'POST' ? new Response(JSON.stringify(done), { status: 200 }) : new Response('{}', { status: 502 })) as typeof fetch
  try {
    const free = useFreeInstances()
    const result = await free.run(account, 'auth')
    expect([result?.ok, free.errors[account.id]]).toEqual([true, ''])
  } finally {
    globalThis.fetch = realFetch
  }
})

// 2026-10-08: on a pinned PC one read of a running check took over 15 s, and the check ended as "signal timed out",
// which the owner read as a dead login ("do I need to re-log in?") while the account was answering HSwarm all along.
it('a check outlives one read Desk was too slow to answer, and a timeout never reads as the login', async () => {
  const timedOut = () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'))
  const realFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'POST') {
      const { requestId } = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ id: requestId, instanceId: account.id, provider: 'claude', command: 'auth', state: 'running', phase: 'working', startedAt: 1 }), { status: 202 })
    }
    if (path.includes('/jobs/')) {
      if (++reads === 1) return timedOut()
      return new Response(JSON.stringify({ id: path.split('/jobs/')[1], instanceId: account.id, provider: 'claude', command: 'auth', state: 'done', phase: 'done', startedAt: 1, result: { ok: true, authenticated: true } }), { status: 200 })
    }
    return new Response('{}', { status: 502 })
  }) as typeof fetch
  try {
    const free = useFreeInstances()
    const result = await free.run(account, 'auth')
    expect([result?.ok, result?.authenticated, free.errors[account.id]]).toEqual([true, true, ''])
    // Desk never answers at all: the reason says it was Desk, not the account.
    globalThis.fetch = (() => timedOut()) as unknown as typeof fetch
    expect(await free.run(account, 'auth')).toBeNull()
    expect(free.errors[account.id]).not.toContain('signal timed out')
    expect(free.errors[account.id]).toContain('says nothing about the login')
  } finally {
    globalThis.fetch = realFetch
  }
})

// 2026-10-08: a working ChatGPT account wore a red "Last operation failed" for one of HSwarm's sends the site refused.
// Another caller's message counts in the account's hour (status.health); it is never an error on the row.
it("another caller's failed message leaves the row unmarked; the page's own failed message is reported", async () => {
  const other: FreeInstance = { ...account, id: '22222222-3333-4444-8555-666666666666', num: 2, provider: 'chatgpt' }
  const theirs = { id: 'cccccccc-dddd-4eee-8fff-000000000000', instanceId: other.id, provider: 'chatgpt', command: 'chat', state: 'running', phase: 'working', startedAt: 1 }
  const refused = { ok: false, error: { code: 'rate_limited', message: 'Synthetic refusal' } }
  const realFetch = globalThis.fetch
  let ended = false // their job, once read finished, is no longer in the status
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...theirs, id: JSON.parse(String(init.body)).requestId }), { status: 202 })
    if (path.includes('/jobs/')) { ended = true; return new Response(JSON.stringify({ ...theirs, id: path.split('/jobs/')[1], state: 'done', phase: 'done', result: refused }), { status: 200 }) }
    return new Response(path.endsWith('/threads') ? '[]' : JSON.stringify({ ready: true, instances: [other], jobs: ended ? [] : [theirs] }), { status: 200 })
  }) as typeof fetch
  try {
    const free = useFreeInstances()
    await free.refreshFree({ silent: true })
    while (free.busy(other.id)) await new Promise(resolve => setTimeout(resolve, 50))
    expect(free.errors[other.id] ?? '').toBe('')
    expect(await free.run(other, 'chat', { prompt: 'synthetic prompt' })).toEqual(refused)
    expect(free.errors[other.id]).toBe('Synthetic refusal')
  } finally {
    globalThis.fetch = realFetch
  }
})
