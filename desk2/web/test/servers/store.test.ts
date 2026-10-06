import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useDevServers } from '../../src/components/servers/store'

// The views read one client: it asks once for all of them, never starts the service by hand (Desk does, for the first
// list read, once), leaves a service stopped from Settings stopped, and polls only while one is on screen.
const calls = new Map<string, number>()
let state: 'stopped' | 'running' = 'stopped'
let startBody: unknown = null
const realFetch = globalThis.fetch
const realDocument = (globalThis as { document?: unknown }).document
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.set(url, (calls.get(url) ?? 0) + 1)
    if (url === '/dw/status') return json({ state, pid: state === 'running' ? 4242 : null })
    if (url === '/dw/service') {
      startBody = JSON.parse(String(init?.body))
      state = 'running'
      return json({ state, pid: 4242 })
    }
    // Desk starts the service for the first request that needs it.
    state = 'running'
    return json([{ id: 'p1', name: 'Example', path: 'C:/Users/me/Code/example/.devwebui', enabled: true, processes: [] }])
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { document?: unknown }).document = realDocument
})
const settle = () => new Promise((r) => setTimeout(r, 30))
const count = (url: string) => calls.get(url) ?? 0

describe('the shared dev-servers client', () => {
  it('a Settings-only view reads the status and asks for nothing, so it never starts the service', async () => {
    const servers = useDevServers()
    state = 'stopped'
    const release = servers.use({ quiet: true })
    await settle()
    expect(servers.status.value?.state).toBe('stopped')
    expect(count('/dw/api/projects')).toBe(0)
    expect(count('/dw/service')).toBe(0)
    release()
  })

  it('the first list read starts a stopped service (Desk does it) and shows starting meanwhile; no start call of its own', async () => {
    const servers = useDevServers()
    state = 'stopped'
    calls.clear()
    const release = servers.use()
    await settle()
    expect(count('/dw/api/projects')).toBe(1)
    expect(count('/dw/service')).toBe(0)
    expect(servers.status.value?.state).toBe('running')
    expect(servers.projects.value?.map((p) => p.id)).toEqual(['p1'])
    // Stopped from Settings afterwards: it stays stopped until someone starts it, however often it is polled.
    state = 'stopped'
    await servers.refresh()
    await servers.refresh()
    expect(servers.status.value?.state).toBe('stopped')
    expect(count('/dw/api/projects')).toBe(1)
    // Try again is POST /dw/service {action: 'start'}.
    await servers.tryAgain()
    expect(startBody).toEqual({ action: 'start' })
    expect(servers.status.value?.state).toBe('running')
    release()
  })

  it('asks once for the sidebar and the pane both on screen, and again for a view that returns', async () => {
    const servers = useDevServers()
    state = 'running'
    calls.clear()
    const sidebar = servers.use()
    const pane = servers.use()
    await settle()
    expect(count('/dw/status')).toBe(1)
    expect(count('/dw/api/projects')).toBe(1)
    expect(servers.projects.value?.map((p) => p.id)).toEqual(['p1'])
    sidebar()
    sidebar()
    pane()
    // Nothing on screen: a new view asks again by itself.
    const back = servers.use()
    await settle()
    expect(count('/dw/status')).toBe(2)
    back()
  })
})
