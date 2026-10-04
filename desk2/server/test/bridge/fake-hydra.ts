// A fake AgentHydra daemon for the bridge tests: serves the recorded samples in
// test/fixtures/agenthydra-*.json, records every POST, and can go down and come back on the same port.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `agenthydra-${name}.json`), 'utf8')) as T
}

/** The clock every fixture was recorded around (the samples date from 2026-10-03 ~23:20 UTC). */
export const NOW = Date.parse('2026-10-03T23:24:00Z')

export interface FakeState {
  agentStatus: any[]
  live: { count: number; sessions: any[] }
  chats: { rows: any[] }
  sessions: any[]
  instances: any[]
  workers: any[]
  detail: any
  tail: any
  /** What GET /api/sessions/search answers (its results, when an array, cut to `limit`); a string answers that error with a 500. */
  search: any
}

/** A SessionSearchResponse in AgentHydra's shape (types.ts): two recorded sessions and one the index has no row for. */
export function searchAnswer(): any {
  const long = `${'x'.repeat(200)} the flaky websocket test ${'y'.repeat(200)}`
  return {
    results: [
      { session_id: '00000000-0000-4000-8000-000000000002', source: 'claude', cwd: 'C:\\Users\\me\\Desktop\\Project\\alpha', project: 'alpha', match_count: 7, truncated: true, snippets: ['…we fixed the flaky WebSocket test by…', 'other'] },
      { session_id: '00000000-0000-4000-8000-000000000001', source: 'codex', cwd: '', project: 'gamma', match_count: 1, truncated: false, snippets: [long] },
      { session_id: '00000000-0000-4000-8000-0000000000ff', source: 'claude', cwd: 'C:\\Users\\me\\old', project: 'old', match_count: 2, truncated: false, snippets: ['no hit here', 'a websocket line'] },
    ],
    searched: 'index',
    conversationOnly: true,
    budgetExhausted: false,
    limitReached: false,
    filesSearched: 0,
    filesTotal: 0,
    budgetMs: 7000,
  }
}

export function freshState(): FakeState {
  return {
    agentStatus: fixture('agent-status'),
    live: fixture('sessions-live'),
    chats: fixture('chats'),
    sessions: fixture('sessions'),
    instances: fixture('cli-instances'),
    workers: fixture('corch-workers'),
    detail: fixture('corch-worker-detail'),
    tail: fixture('tail'),
    search: searchAnswer(),
  }
}

const ACTIVE = new Set(['queued', 'running', 'waiting', 'checking'])

export interface FakeHydra {
  url: string
  state: FakeState
  posts: { path: string; body: any }[]
  gets: string[]
  stop(): Promise<void>
  start(): Promise<void>
}

export async function startFakeHydra(state: FakeState = freshState()): Promise<FakeHydra> {
  const posts: { path: string; body: any }[] = []
  const gets: string[] = []
  const json = (data: unknown, status = 200) => Response.json(data, { status })

  async function handle(req: Request): Promise<Response> {
    const u = new URL(req.url)
    const p = u.pathname
    if (req.method === 'POST') {
      const body: any = await req.json().catch(() => null)
      posts.push({ path: p, body })
      if (p === '/api/corch/cancel') {
        const w = state.workers.find((x) => x.id === body?.id && ACTIVE.has(x.status))
        if (w) w.status = 'cancelled'
        return json({ cancelled: w ? [w.id] : [], keptMessages: {} })
      }
      const send = /^\/api\/corch\/workers\/([^/]+)\/send$/.exec(p)
      if (send) {
        const w = state.workers.find((x) => x.id === decodeURIComponent(send[1]))
        if (!w) return json({ ok: false, message: `no such worker ${send[1]}` })
        if (!ACTIVE.has(w.status)) return json({ ok: false, message: `worker ${w.id} is ${w.status}` })
        return json({ ok: true, message: 'queued' })
      }
      return json({ error: 'not found' }, 404)
    }
    gets.push(p + u.search)
    if (p === '/api/health') return json({ ok: true, version: '9.9.9' })
    if (p === '/api/agent-status') return json(state.agentStatus)
    if (p === '/api/sessions/live') return json(state.live)
    if (p === '/api/chats') return json(state.chats)
    if (p === '/api/sessions') return json(state.sessions)
    if (p === '/api/sessions/search') {
      if (typeof state.search === 'string') return json({ error: state.search }, 500)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      // An answer of another shape (no results array) goes out as it is.
      return json({ ...state.search, results: state.search.results?.slice(0, limit) })
    }
    const row = /^\/api\/sessions\/([^/]+)$/.exec(p)
    if (row) {
      const s = state.sessions.find((x) => x.session_id === decodeURIComponent(row[1]))
      return s ? json(s) : json({ error: 'session not found' }, 404)
    }
    if (p === '/api/cli-instances') return json(state.instances)
    if (p === '/api/corch/workers') {
      const limit = u.searchParams.get('limit')
      if (limit === null) return json(state.workers)
      const n = Number(limit)
      const active = state.workers.filter((w) => ACTIVE.has(w.status))
      const done = state.workers.filter((w) => !ACTIVE.has(w.status)).slice(0, n)
      return json([...active, ...done])
    }
    const detail = /^\/api\/corch\/workers\/([^/]+)$/.exec(p)
    if (detail) {
      const id = decodeURIComponent(detail[1])
      if (state.detail?.id === id) return json(state.detail)
      return json({ error: `no worker ${id}` }, 404)
    }
    const tail = /^\/api\/sessions\/([^/]+)\/tail$/.exec(p)
    if (tail) {
      const id = decodeURIComponent(tail[1])
      if (state.tail?.session_id === id) return json(state.tail)
      return json({ session_id: id, source: '', title: '', cwd: '', events: [], error: 'transcript not found' })
    }
    return json({ error: 'not found' }, 404)
  }

  let server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  const port = server.port as number
  let running = true
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    posts,
    gets,
    async stop() {
      if (!running) return
      running = false
      await server.stop(true)
    },
    async start() {
      if (running) return
      server = Bun.serve({ port, hostname: '127.0.0.1', fetch: handle })
      running = true
    },
  }
}

/** A url nothing listens on (a port the OS just handed out and took back). */
export function deadUrl(): string {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = s.port
  s.stop(true)
  return `http://127.0.0.1:${port}`
}
