// plugins/10-bridge.ts through the real server: the REST rows and the poller's /ws broadcasts.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CliMayteWorker, ServerEvent } from '@shared/protocol'
import { createServer, type DeskServer } from '../../src/index'
import { createBridge } from '../../src/bridge'
import { RECENT_FINISHED } from '../../src/bridge/climayte'
import { deadUrl, type FakeHydra, REMOTE_SESSIONS, remoteAnswer, startFakeHydra } from './fake-hydra'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '10-bridge.ts')
const temps: string[] = []
const servers: DeskServer[] = []
const fakes: FakeHydra[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const f of fakes.splice(0)) await f.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A desk server whose only plugin is the bridge, pointed at hydraUrl (`deps` may hand it a bridge instead). */
async function boot(hydraUrl: string, deps: Record<string, unknown> = {}): Promise<DeskServer> {
  const home = mkdtempSync(join(tmpdir(), 'desk-bridge-home-'))
  const plugins = mkdtempSync(join(tmpdir(), 'desk-bridge-plugins-'))
  temps.push(home, plugins)
  writeFileSync(join(plugins, '10-bridge.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  process.env.HYDRA_DESK_HOME = home
  const desk = await createServer({ port: 0, home, pluginsDir: plugins, deps: { hydraUrl, bridgePollMs: 50, ...deps } })
  servers.push(desk)
  return desk
}

async function call(desk: DeskServer, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(desk.url + path, init)
  return { status: res.status, body: await res.json() }
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

test('the REST rows answer from AgentHydra', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)

  expect(await call(desk, '/api/bridge/status')).toEqual({ status: 200, body: { up: true, url: f.url } })
  const accounts = await call(desk, '/api/accounts')
  expect(accounts.body.map((a: any) => a.id)).toEqual(['default', 'cli-1', 'cli-2', 'cli-3', 'cli-4', 'cli-5'])
  expect((await call(desk, '/api/accounts/pick')).body).toHaveProperty('id')
  expect(Array.isArray((await call(desk, '/api/external/sessions')).body)).toBe(true)

  const items = await call(desk, '/api/external/sessions/00000000-0000-4000-8000-000000000001/items')
  expect(items.status).toBe(200)
  expect(items.body[0].kind).toBe('user')
  expect((await call(desk, '/api/external/sessions/nope/items')).status).toBe(404)

  expect((await call(desk, '/api/climayte/workers')).body.length).toBe(4)
  expect(f.gets).toContain('/api/corch/workers?limit=20')
  expect((await call(desk, '/api/climayte/workers?all=1')).body.length).toBe(4)
  expect(f.gets).toContain('/api/corch/workers')

  expect(await call(desk, '/api/climayte/workers/w-00000001/send', post({ text: 'hi' }))).toEqual({ status: 200, body: { ok: true } })
  expect((await call(desk, '/api/climayte/workers/w-00000001/send', post({}))).status).toBe(400)
  expect((await call(desk, '/api/climayte/workers/w-00000001/send', post())).status).toBe(400)
  expect(await call(desk, '/api/climayte/workers/w-00000001/cancel', post())).toEqual({ status: 200, body: { ok: true } })
  expect((await call(desk, '/api/climayte/workers/w-00000001/cancel', post())).status).toBe(409)
  expect(f.posts.map((p) => p.path).filter((p) => p !== '/api/corch/place-chat')).toEqual(['/api/corch/workers/w-00000001/send', '/api/corch/cancel', '/api/corch/cancel'])
})

test("the other PCs' CliMayte workers join the list under their PC's name, and never count as this PC's", async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  f.state.remote = remoteAnswer(RECENT_FINISHED + 3)
  // A PC gone quiet (off or asleep): its last snapshot still says its tasks run.
  const quiet = remoteAnswer().pcs[0]
  f.state.remote.pcs.push({ ...quiet, pc: '00000000-0000-4000-8000-0000000000bb', name: 'QUIET-PC', stale: true, workers: quiet.workers.map((w: any) => ({ ...w, id: `${w.id}-quiet` })) })
  const desk = await boot(f.url)
  const local = ['w-00000001', 'w-00000002', 'w-00000003', 'w-00000004']
  const ids = (list: CliMayteWorker[]) => list.map((w) => w.id).sort()

  const list = (await call(desk, '/api/climayte/workers')).body as CliMayteWorker[]
  expect(ids(list.filter((w) => !w.pc))).toEqual(local)
  const remote = list.filter((w) => w.pc)
  // The quiet PC's tasks are not shown as running for as long as it stays away.
  expect(remote.some((w) => w.pc === 'QUIET-PC')).toBe(false)
  // Every active one, and only the newest finished ones, as this PC's list keeps.
  expect(ids(remote.filter((w) => w.active))).toEqual(['w-00000001', 'w-remote-q'])
  expect(remote.filter((w) => !w.active)).toHaveLength(RECENT_FINISHED)
  expect(remote.some((w) => w.id === 'w-remote-done-0')).toBe(true)
  expect(remote.some((w) => w.id === `w-remote-done-${RECENT_FINISHED + 2}`)).toBe(false)
  // Its id repeats one of this PC's; it stays its own row, tied to the chat that spawned it on its own PC
  // (owner, 2026-10-04: CliMayte's chats sit under the chat that spawned them).
  expect(remote.find((w) => w.id === 'w-00000001')).toMatchObject({
    pc: 'OTHER-PC',
    account: '#7',
    status: 'running',
    active: true,
    cwd: null,
    sessionId: REMOTE_SESSIONS.manager,
    originSessionId: REMOTE_SESSIONS.chat,
    originWorkerId: null,
    endedAt: null,
  })
  // Its wave's task, shared with no origin, answers to that PC's manager of the wave, as this PC's do.
  expect(remote.find((w) => w.id === 'w-remote-q')).toMatchObject({ account: null, originWorkerId: 'w-00000001', originSessionId: REMOTE_SESSIONS.manager })
  // One an older AgentHydra shared carries no session or origin, and still reads.
  expect(remote.find((w) => w.id === 'w-remote-done-0')).toMatchObject({ sessionId: null, originSessionId: null, originWorkerId: null })
  // The login's name (an email here) never leaves the server.
  expect(JSON.stringify(list)).not.toContain('someone@example.com')

  // The engine matches chats to lastWorkers() and counts them: this PC's alone.
  const b = createBridge({ url: f.url })
  await b.workers()
  expect(ids(b.lastWorkers())).toEqual(local)
  expect(b.lastWorkers().some((w) => w.pc)).toBe(false)

  // An AgentHydra without the route (404), or one whose route fails, leaves this PC's list whole.
  for (const answer of [null, 'the shared store is unreachable']) {
    f.state.remote = answer
    expect(ids((await call(desk, '/api/climayte/workers')).body)).toEqual(local)
  }
})

test('AgentHydra down: lists stay answerable, writes say 503', async () => {
  const url = deadUrl()
  const desk = await boot(url)
  expect((await call(desk, '/api/bridge/status')).body).toEqual({ up: false, url })
  expect((await call(desk, '/api/accounts')).body.map((a: any) => a.id)).toEqual(['default'])
  expect((await call(desk, '/api/accounts/pick')).body.id).toBe('default')
  expect((await call(desk, '/api/external/sessions')).body).toEqual([])
  expect((await call(desk, '/api/climayte/workers')).body).toEqual([])
  expect(await call(desk, '/api/external/sessions/00000000-0000-4000-8000-000000000004')).toEqual({ status: 503, body: { error: `AgentHydra is not running at ${url}` } })
  const cancel = await call(desk, '/api/climayte/workers/w-1/cancel', post())
  expect(cancel.status).toBe(503)
  expect(cancel.body.error).toBe(`AgentHydra is not running at ${url}`)
})

test('GET /api/search answers from AgentHydra search, bounded, its failures as 502', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)

  const found = await call(desk, '/api/search?q=websocket%20test')
  expect(found.status).toBe(200)
  expect(found.body.map((h: any) => h.title)).toEqual(['Session 1', 'Session 3', '00000000'])
  expect(f.gets).toContain('/api/sessions/search?q=websocket%20test&limit=25')
  expect(f.gets).toContain('/api/sessions/00000000-0000-4000-8000-000000000002?source=claude')

  expect((await call(desk, '/api/search?q=websocket&limit=1')).body).toHaveLength(1)
  await call(desk, '/api/search?q=websocket&limit=500')
  expect(f.gets).toContain('/api/sessions/search?q=websocket&limit=50')

  expect((await call(desk, '/api/search?q=%20a%20')).status).toBe(400)
  expect((await call(desk, '/api/search')).status).toBe(400)

  f.state.search = 'the index is rebuilding'
  const broken = await call(desk, '/api/search?q=websocket')
  expect(broken.status).toBe(502)
  expect(broken.body.error).toContain('the index is rebuilding')
})

test('GET /api/external/sessions/:id answers one session however old, mapped as the list maps it; 404 when unknown', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)
  const old = '00000000-0000-4000-8000-000000000004'

  // the list holds only what is live or was just written; this session is neither
  const list = (await call(desk, '/api/external/sessions')).body
  expect(list.map((s: any) => s.id)).not.toContain(old)
  const one = await call(desk, `/api/external/sessions/${old}`)
  expect(one.status).toBe(200)
  expect(one.body).toMatchObject({ id: old, title: 'Session 4', cwd: 'C:\\Users\\me\\Desktop\\Project\\alpha', source: 'cli', instance: 'Claude-4', pinned: false, archived: false, group: null })
  expect(f.gets).toContain(`/api/sessions/${old}`)

  // a listed session answers exactly as the list has it
  expect(list.length).toBeGreaterThan(0)
  expect((await call(desk, `/api/external/sessions/${encodeURIComponent(list[0].id)}`)).body).toEqual(list[0])

  const unknown = await call(desk, '/api/external/sessions/nope')
  expect(unknown.status).toBe(404)
  expect(unknown.body.error).toContain('nope')
})

test('GET /api/search: an answer of another shape is an empty list or bare hits; a fault here keeps its details in the log', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)

  f.state.search = { searched: 'index', conversationOnly: true }
  expect(await call(desk, '/api/search?q=websocket')).toEqual({ status: 200, body: [] })
  f.state.search = { results: [{ session_id: '00000000-0000-4000-8000-000000000002', source: 'claude', cwd: '', match_count: 1 }] }
  const bare = await call(desk, '/api/search?q=websocket')
  expect(bare.status).toBe(200)
  expect(bare.body).toEqual([expect.objectContaining({ sessionId: '00000000-0000-4000-8000-000000000002', title: 'Session 1', snippet: '' })])

  const real = createBridge({ url: f.url })
  const broken = await boot(f.url, {
    bridge: {
      ...real,
      search: async () => {
        throw new TypeError('cannot read properties of undefined (reading internals)')
      },
    },
  })
  expect(await call(broken, '/api/search?q=websocket')).toEqual({ status: 500, body: { error: 'the search failed' } })
})

test('GET /api/search with AgentHydra down says 503', async () => {
  const url = deadUrl()
  const desk = await boot(url)
  expect(await call(desk, '/api/search?q=websocket')).toEqual({ status: 503, body: { error: `AgentHydra is not running at ${url}` } })
})

test('a connected window gets the poller broadcasts', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)
  const seen = new Set<string>()
  const ws = new WebSocket(`${desk.url.replace('http', 'ws')}/ws`)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only saw ${[...seen].join(', ')}`)), 5000)
      ws.onmessage = (e) => {
        seen.add((JSON.parse(String(e.data)) as ServerEvent).type)
        if (['bridge.status', 'external.update', 'climayte.update', 'accounts.update'].every((t) => seen.has(t))) {
          clearTimeout(timer)
          resolve()
        }
      }
    })
  } finally {
    ws.close()
  }
  expect(seen.has('hello')).toBe(true)
})

/** A window on /ws, keeping each event it gets. */
function openWindow(desk: DeskServer): { ws: WebSocket; events: ServerEvent[]; until(ok: () => boolean, what: string): Promise<void> } {
  const ws = new WebSocket(`${desk.url.replace('http', 'ws')}/ws`)
  const events: ServerEvent[] = []
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)) as ServerEvent)
  const until = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 5000
    while (!ok()) {
      if (Date.now() > end) throw new Error(`${what}: only saw ${events.map((e) => e.type).join(', ')}`)
      await Bun.sleep(20)
    }
  }
  return { ws, events, until }
}

test('a window joining one already open gets the newest lists at once, not at their next change', async () => {
  const f = await startFakeHydra()
  fakes.push(f)
  const desk = await boot(f.url)
  const LISTS = ['accounts.update', 'bridge.status', 'climayte.update', 'external.update']
  const has = (w: { events: ServerEvent[] }, type: string) => w.events.some((e) => e.type === type)
  const a = openWindow(desk)
  const b: { w: ReturnType<typeof openWindow> | null } = { w: null }
  try {
    await a.until(() => LISTS.every((t) => has(a, t)), 'first window')
    // A change after the first send: the joining window must get this one, not the first.
    f.state.workers[1].status = 'running'
    const running = (w: { events: ServerEvent[] }) =>
      w.events.some((e) => e.type === 'climayte.update' && e.workers.some((x) => x.id === 'w-00000002' && x.status === 'running'))
    await a.until(() => running(a), 'the change')

    b.w = openWindow(desk)
    const w = b.w
    await w.until(() => LISTS.every((t) => has(w, t)), 'joining window')
    expect(has(w, 'hello')).toBe(true)
    expect(running(w)).toBe(true)
    // The outside sessions the open window has now, not an empty or first list.
    const lastOf = (x: { events: ServerEvent[] }) => x.events.filter((e) => e.type === 'external.update').at(-1)
    expect(lastOf(w)).toEqual(lastOf(a))
    expect((lastOf(w) as Extract<ServerEvent, { type: 'external.update' }>).sessions.length).toBeGreaterThan(0)
  } finally {
    a.ws.close()
    b.w?.ws.close()
  }
})
