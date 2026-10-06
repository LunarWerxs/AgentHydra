import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useDevServers } from '../../src/components/servers/store'

// The sidebar's list and the pane read one client: it asks once for both, starts the manager once, and polls only while one is on screen.
const calls = new Map<string, number>()
let state: 'stopped' | 'running' = 'stopped'
const realFetch = globalThis.fetch
const realDocument = (globalThis as { document?: unknown }).document
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.set(url, (calls.get(url) ?? 0) + 1)
    if (url === '/dw/status') return json({ state, url: 'http://127.0.0.1:4000' })
    if (url === '/dw/start') {
      state = 'running'
      return json({ state, url: 'http://127.0.0.1:4000' })
    }
    return json([{ id: 'p1', name: 'Example', path: 'C:/Users/me/Code/example/.devwebui', processes: [] }])
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { document?: unknown }).document = realDocument
})
const settle = () => new Promise((r) => setTimeout(r, 30))
const count = (url: string) => calls.get(url) ?? 0

describe('the shared DevWebUI client', () => {
  it('starts a stopped server manager once, however often it is asked', async () => {
    const servers = useDevServers()
    state = 'stopped'
    await servers.refresh()
    expect(count('/dw/start')).toBe(1)
    state = 'stopped'
    await servers.refresh()
    expect(servers.status.value?.state).toBe('stopped')
    expect(count('/dw/start')).toBe(1)
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
