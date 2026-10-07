import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useDevServers } from '../../src/components/servers/store'

// The views read one client: it asks once for all of them, never starts the service by hand (Desk does, for the first
// list read, once), leaves a service stopped from Settings stopped (a poll's read never starts it), sends one action
// per server at a time, and polls only while one is on screen.
const calls = new Map<string, number>()
let state: 'stopped' | 'running' = 'stopped'
let startBody: unknown = null
/** A Stop from Settings that lands right after the next status answer. */
let stopAfterStatus = false
/** Holds a server action's answer until opened. */
let gate: Promise<void> | null = null
/** List reads still to miss while the service runs (a busy PC: Desk's 2 s wait for the service ran out). */
let missReads = 0
const realFetch = globalThis.fetch
const realDocument = (globalThis as { document?: unknown }).document
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.set(url, (calls.get(url) ?? 0) + 1)
    if (url === '/dw/status') {
      const s = state
      if (stopAfterStatus) {
        stopAfterStatus = false
        state = 'stopped'
      }
      return json({ state: s, pid: s === 'running' ? 4242 : null })
    }
    if (url === '/dw/service') {
      startBody = JSON.parse(String(init?.body))
      state = 'running'
      return json({ state, pid: 4242 })
    }
    if (url.startsWith('/dw/api/processes/')) {
      await gate
      return json({ ok: true, process: {}, reused: false, coStarted: [] })
    }
    // A read marked x-dw-no-start is answered only while the service runs; any other request makes Desk start it.
    if (new Headers(init?.headers).has('x-dw-no-start')) {
      if (state !== 'running') return new Response(JSON.stringify({ error: 'the dev-servers service is not running' }), { status: 503, headers: { 'content-type': 'application/json' } })
      if (url === '/dw/api/projects' && missReads > 0) {
        missReads--
        return new Response(JSON.stringify({ error: 'the dev-servers service is not running, or did not answer within 2 s' }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
    } else state = 'running'
    return json([{ id: 'p1', name: 'Example', path: 'C:/Users/me/Code/example/.devwebui', enabled: true, processes: [] }])
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { document?: unknown }).document = realDocument
})
const settle = () => new Promise((r) => setTimeout(r, 30))
const count = (url: string) => calls.get(url) ?? 0
/** Where the fake service stands now (a read the compiler does not narrow). */
const serviceState = (): typeof state => state

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

  it('a list read already on its way when the service is stopped does not start it again', async () => {
    const servers = useDevServers()
    state = 'running'
    const release = servers.use()
    await settle()
    stopAfterStatus = true
    await servers.refresh()
    expect(serviceState()).toBe('stopped')
    release()
  })

  it('a list on screen stays through two missed reads; a third in a row shows why, and the next answer clears it', async () => {
    const servers = useDevServers()
    state = 'running'
    const release = servers.use()
    await settle()
    expect(servers.projects.value?.map((p) => p.id)).toEqual(['p1'])
    missReads = 3
    await servers.refresh()
    await servers.refresh()
    expect(servers.projectsError.value).toBeNull()
    expect(servers.projects.value?.map((p) => p.id)).toEqual(['p1'])
    await servers.refresh()
    expect(servers.projectsError.value).toContain('did not answer within 2 s')
    await servers.refresh()
    expect(servers.projectsError.value).toBeNull()
    release()
  })

  it('a second click on a server while its first action runs sends nothing more', async () => {
    const servers = useDevServers()
    let open: () => void = () => {}
    gate = new Promise<void>((r) => {
      open = r
    })
    calls.clear()
    const first = servers.act({ id: 'p1.web' }, 'start')
    const second = servers.act({ id: 'p1.web' }, 'start')
    open()
    await Promise.all([first, second])
    expect(count('/dw/api/processes/p1.web/start')).toBe(1)
    gate = null
  })
})
