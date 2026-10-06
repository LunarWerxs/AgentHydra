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
  /** What GET /api/corch/remote answers; null answers 404 (an AgentHydra without the route), a string that error with a 500. */
  remote: any
  /** What the home stats reads answer (spend and activity reports, CliMayte's totals, HSwarm's stats); a string answers that error with a 500. */
  stats: { spend: any; activity: any; totals: any; hswarm: any }
  /** What /api/health says its version is (9.9.9 when unset). */
  version?: string
  /** false: an AgentHydra from before deliver-now (v1.10.0), whose route answers its own 404 page. */
  deliverNow?: boolean
}

/** Sessions on the other PC: the chat that started its wave, and that wave's manager. */
export const REMOTE_SESSIONS = { chat: '00000000-0000-4000-8000-000000000a01', manager: '00000000-0000-4000-8000-000000000a02' }

/**
 * The other PCs' queues in AgentHydra's shape (routes/climayte.ts GET /api/corch/remote), made up: one PC with a
 * running wave manager whose id repeats one of this PC's, a queued task of its wave (shared, as AgentHydra
 * dispatches a wave's tasks, with no origin), and `finished` done ones as an AgentHydra from before 2026-10-04
 * shared them (no session, origin or wave). The account name is email-shaped on purpose: it must never reach
 * the window.
 */
export function remoteAnswer(finished = 0): any {
  const account = { id: 'cli-remote-7', num: 7, name: 'someone@example.com' }
  const worker = (id: string, status: string, at: number, extra: Record<string, unknown> = {}) => ({
    id, title: `Remote ${id}`, group: 'g-remote', status, kind: null, model: 'opus', effort: 'xhigh', account,
    createdAt: at, updatedAt: at + 1000, activeS: 1, costUsd: null, lastActivity: null, error: null, verdict: null, ...extra,
  })
  return {
    enabled: true,
    pcs: [
      {
        pc: '00000000-0000-4000-8000-0000000000aa',
        name: 'OTHER-PC',
        at: NOW,
        stale: false,
        workers: [
          worker('w-00000001', 'running', NOW - 60_000, {
            kind: 'manage', wave: 'wv-remote', sessionId: REMOTE_SESSIONS.manager, originSessionId: REMOTE_SESSIONS.chat, originWorkerId: null,
          }),
          worker('w-remote-q', 'queued', NOW - 30_000, { account: null, wave: 'wv-remote', sessionId: null, originSessionId: null, originWorkerId: null }),
          ...Array.from({ length: finished }, (_, i) => worker(`w-remote-done-${i}`, 'done', NOW - 3_600_000 - i * 1000, { verdict: 'pass' })),
        ],
        build: null,
        behind: false,
        behindNote: null,
      },
    ],
  }
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

/** The local day `daysAgo` days before today, as AgentHydra keys its days (YYYY-MM-DD). */
export function localDay(daysAgo: number): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The home stats reads in AgentHydra's shapes (types.ts SpendReport and ActivityReport, climayteTotals, HSwarm's
 * /api/stats), made up and dated from today. The spend report carries a `rank:` pseudo model with more sessions
 * than any real one, a source the card does not know, a quiet day and a day older than the activity grid.
 */
export function statsAnswers(): FakeState['stats'] {
  const tokens = (total: number) => ({ input: total / 10, cacheRead: (total * 7) / 10, cacheWrite: total / 10, output: total / 10, total })
  const hours = new Array<number>(168).fill(0)
  hours[1 * 24 + 14] = 5 // Monday 2 PM
  hours[3 * 24 + 14] = 4 // Wednesday 2 PM
  hours[2 * 24 + 9] = 7 // Tuesday 9 AM: the busiest slot, but 2 PM is the busiest hour over the week
  return {
    spend: {
      from: null,
      to: null,
      totalCostUsd: 1234.5,
      totalWeighted: 0,
      tokens: { input: 1_000_000, cacheRead: 40_000_000, cacheWrite: 2_000_000, output: 500_000, total: 43_500_000 },
      sessions: 60,
      calls: 900,
      byProvider: [],
      byModel: [
        { key: 'claude-opus-5-5', weighted: 0, costUsd: 1100, sessions: 40, turns: 700, tokens: tokens(40_000_000) },
        { key: 'rank:claude-opus-5-5-low:direct', weighted: 0, costUsd: 0, sessions: 45, turns: 50, tokens: tokens(0) },
        { key: 'claude-sonnet-5-5', weighted: 0, costUsd: 120, sessions: 15, turns: 150, tokens: tokens(3_000_000) },
        { key: 'gpt-6-astra', weighted: 0, costUsd: 14.5, sessions: 5, turns: 50, tokens: tokens(500_000) },
      ],
      byProject: [],
      byDay: [
        { key: localDay(250), weighted: 0, costUsd: 100, sessions: 0, turns: 200, tokens: tokens(5_000_000) },
        { key: localDay(5), weighted: 0, costUsd: 0, sessions: 0, turns: 0, tokens: tokens(0) },
        { key: localDay(2), weighted: 0, costUsd: 300, sessions: 0, turns: 200, tokens: tokens(8_500_000) },
        { key: localDay(0), weighted: 0, costUsd: 834.5, sessions: 0, turns: 500, tokens: tokens(30_000_000) },
      ],
      byAccount: [],
      bySource: [
        { key: 'climayte', weighted: 0, costUsd: 400, sessions: 30, turns: 300, tokens: tokens(10_000_000) },
        { key: 'desktop', weighted: 0, costUsd: 800, sessions: 20, turns: 500, tokens: tokens(30_000_000) },
        { key: 'newtool', weighted: 0, costUsd: null, sessions: 10, turns: 100, tokens: tokens(3_500_000) },
      ],
      unpricedModels: [],
      pricesAsOf: '2026-10-01',
      priceSource: 'bundled',
      coverage: { sessions: 50, total: 60, refreshing: true, bytes: 0 },
      notes: [],
    },
    activity: { hours, tools: [], agentMinutes: 321, health: [], editSurvival: { sessions: 0, average: null, overdue: 0 } },
    totals: { tasks: 12, sessions: 20, cliSessions: 14, costUsd: 400, limitHits: 2, since: null },
    // `total` is lifetime whatever `days` asked; the days listed are the range's.
    hswarm: {
      source: 'hswarm',
      empty: false,
      total: { n: 90, tasks: 500, worker_usd: 15, saved_usd: 400 },
      days: [
        { day: '2026-10-03', tasks: 50, saved_usd: 40 },
        { day: '2026-10-04', tasks: 27, saved_usd: 15.5 },
      ],
      today: {},
    },
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
    remote: null,
    stats: statsAnswers(),
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
        if (body?.urgent === true && w.status === 'running') return json({ ok: true, urgent: true, message: 'Stopped its running work; the same session continues now with this message first.' })
        return json({ ok: true, message: 'queued' })
      }
      const branch = /^\/api\/sessions\/([^/]+)\/branch$/.exec(p)
      if (branch) {
        // AgentHydra's session-branch: a reply line that is not in the chat is a 404
        if (body?.uuid === 'not-in-this-chat') return json({ error: 'that reply is not in this chat' }, 404)
        return json({ session_id: `branch-of-${decodeURIComponent(branch[1])}`, source: 'claude' })
      }
      const now = /^\/api\/corch\/workers\/([^/]+)\/deliver-now$/.exec(p)
      if (now) {
        if (state.deliverNow === false) return new Response('404 Not Found', { status: 404 })
        const w = state.workers.find((x) => x.id === decodeURIComponent(now[1]))
        if (!w) return json({ ok: false, message: 'No such worker.' })
        return json({ ok: true, stopped: w.status === 'running', message: 'sent now' })
      }
      return json({ error: 'not found' }, 404)
    }
    gets.push(p + u.search)
    if (p === '/api/health') return json({ ok: true, version: state.version ?? '9.9.9' })
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
    if (p === '/api/corch/remote') {
      if (state.remote === null) return json({ error: 'not found' }, 404)
      if (typeof state.remote === 'string') return json({ error: state.remote }, 500)
      return json(state.remote)
    }
    if (p === '/api/corch/workers') {
      const ids = u.searchParams.get('ids')
      if (ids !== null) return json(state.workers.filter((w) => ids.split(',').includes(w.id)))
      const group = u.searchParams.get('group')
      if (group !== null) return json(state.workers.filter((w) => w.group === group))
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
    const stat = (answer: any) => (typeof answer === 'string' ? json({ error: answer }, 500) : json(answer))
    if (p === '/api/analytics/spend') return stat(state.stats.spend)
    if (p === '/api/analytics/activity') return stat(state.stats.activity)
    if (p === '/api/corch/totals') return stat(state.stats.totals)
    if (p === '/api/hswarm/api/stats') return stat(state.stats.hswarm)
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
