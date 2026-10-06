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
