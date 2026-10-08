// The bridge's REST routes (SPEC.md REST rows for bridge/status, accounts, external, climayte) and the
// poller that keeps open windows current. ctx.deps may carry `bridge` (a ready fake), `hydraUrl` (another
// AgentHydra, for tests) and `bridgePollMs` / `bridgeAccountsPollMs` (faster polls in tests).

import { hostname } from 'node:os'
import type { Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { CloudList, DesktopMessageRequest, DesktopMessageResult, ExternalBranchRequest, ExternalBranchResult } from '@shared/protocol'
import type { ServerContext } from '../context'
import { type Bridge, BridgeError, bridge, configureBridge } from '../bridge'
import { type AhCloudRow, CLOUD_TIMEOUT_MS, cloudQuery, toCloudInstance, toCloudSession } from '../bridge/cloud'
import { createPoller } from '../bridge/poller'
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_MIN_CHARS } from '../bridge/search'
import { HOME_STATS_RANGES, isHomeStatsRange } from '../bridge/stats'

function pickBridge(deps: Record<string, unknown>): Bridge {
  if (deps.bridge) return deps.bridge as Bridge
  if (typeof deps.hydraUrl === 'string') return configureBridge({ url: deps.hydraUrl })
  return bridge()
}

/** A BridgeError as an answer: AgentHydra down = 503, its own refusal keeps its status, else 502. */
function fail(c: Context, b: Bridge, err: unknown): Response {
  if (!(err instanceof BridgeError)) throw err
  if (err.unreachable) return c.json({ error: `AgentHydra is not running at ${b.url}` }, 503)
  const status = err.kind === 'http' && err.status && err.status >= 400 && err.status < 500 ? err.status : 502
  return c.json({ error: err.message }, status as ContentfulStatusCode)
}

/** A route body whose BridgeError is answered by fail(). */
async function guarded(c: Context, b: Bridge, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (err) {
    return fail(c, b, err)
  }
}

// A message for a Claude Desktop chat that is working: AgentHydra queues it in the chat itself.
async function desktopMessage(c: Context, b: Bridge): Promise<Response> {
  let text: unknown
  try {
    text = ((await c.req.json()) as Partial<DesktopMessageRequest> | null)?.text
  } catch {
    return c.json({ error: 'the body must be JSON: { "text": "..." }' }, 400)
  }
  if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text is required' }, 400)
  try {
    const id = c.req.param('id') ?? ''
    const r = await b.client.sendToDesktopChat(id, text.trim())
    if (!r.ok || !r.delivered) return c.json({ error: r.detail || `AgentHydra did not deliver the message to ${id}` }, 422)
    return c.json({ ok: true, route: r.route ?? 'peer', delivered: true, detail: r.detail ?? '' } satisfies DesktopMessageResult)
  } catch (err) {
    return fail(c, b, err)
  }
}

// "Copy up to here into a new chat" on a Claude Code session's reply: AgentHydra writes the copy beside it.
async function branchSession(c: Context, b: Bridge): Promise<Response> {
  let req: Partial<ExternalBranchRequest> | null
  try {
    req = (await c.req.json()) as Partial<ExternalBranchRequest> | null
  } catch {
    return c.json({ error: 'the body must be JSON: { "uuid": "..." }' }, 400)
  }
  if (typeof req?.uuid !== 'string' || !req.uuid) return c.json({ error: 'uuid is required' }, 400)
  const title = typeof req.title === 'string' ? req.title : ''
  try {
    const made = await b.client.branchSession(c.req.param('id') ?? '', req.uuid, title)
    return c.json({ id: made.session_id } satisfies ExternalBranchResult)
  } catch (err) {
    return fail(c, b, err)
  }
}

async function search(c: Context, b: Bridge): Promise<Response> {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < SEARCH_MIN_CHARS) return c.json({ error: `q needs at least ${SEARCH_MIN_CHARS} characters` }, 400)
  const asked = Math.floor(Number(c.req.query('limit') ?? SEARCH_LIMIT_DEFAULT))
  const limit = Number.isFinite(asked) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, asked)) : SEARCH_LIMIT_DEFAULT
  // Aborts when the window drops the query (a newer one replaced it), which stops the lookups behind it.
  const signal = c.req.raw.signal
  try {
    return c.json(await b.search(q, limit, signal))
  } catch (err) {
    // Nobody reads this answer, and a dropped query is no error.
    if (signal.aborted) return new Response(null, { status: 499 })
    if (!(err instanceof BridgeError)) {
      // A fault here: its details go to the log, not to the window.
      console.error('[search]', err)
      return c.json({ error: 'the search failed' }, 500)
    }
    // Down stays 503 (the window says the search is offline); any other failure is AgentHydra's, 502.
    if (err.unreachable) return fail(c, b, err)
    return c.json({ error: err.message }, 502)
  }
}

async function sendToWorker(c: Context, b: Bridge): Promise<Response> {
  let text: unknown
  try {
    text = ((await c.req.json()) as { text?: unknown })?.text
  } catch {
    return c.json({ error: 'the body must be JSON: { "text": "..." }' }, 400)
  }
  if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text is required' }, 400)
  const sent = text
  return guarded(c, b, async () => {
    await b.sendToWorker(c.req.param('id') ?? '', sent)
    return c.json({ ok: true })
  })
}

// Desk 2's cloud list: AgentHydra's whole session list, both PCs' chats (bridge/cloud.ts).
function cloudSessions(c: Context, b: Bridge): Promise<Response> {
  return guarded(c, b, async () => {
    const rows = await b.client.get<AhCloudRow[]>(`/api/sessions?${cloudQuery((k) => c.req.query(k))}`, CLOUD_TIMEOUT_MS)
    return c.json({ thisPc: hostname(), sessions: rows.map(toCloudSession) } satisfies CloudList)
  })
}

// The home screen's stats card: every source AgentHydra counts, consolidated (bridge/stats.ts).
async function homeStats(c: Context, b: Bridge): Promise<Response> {
  const range = c.req.query('range') ?? 'all'
  if (!isHomeStatsRange(range)) return c.json({ error: `range must be one of ${HOME_STATS_RANGES.join(', ')}` }, 400)
  return guarded(c, b, async () => c.json(await b.homeStats(range)))
}

function startPoller(ctx: ServerContext, b: Bridge): void {
  const poller = createPoller({
    bridge: b,
    broadcast: ctx.broadcast,
    wsClientCount: ctx.wsClientCount,
    wsVisibleCount: ctx.wsVisibleCount,
    onWsVisibility: ctx.onWsVisibility,
    fastMs: typeof ctx.deps.bridgePollMs === 'number' ? ctx.deps.bridgePollMs : undefined,
    accountsMs: typeof ctx.deps.bridgeAccountsPollMs === 'number' ? ctx.deps.bridgeAccountsPollMs : undefined,
  })
  poller.start()
  ctx.onStop(poller.stop)
  ctx.onConnect(poller.welcome)
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const b = pickBridge(ctx.deps)

  app.get('/api/bridge/status', async (c) => c.json(await b.status()))
  app.get('/api/accounts', (c) => guarded(c, b, async () => c.json(await b.listAccounts())))
  app.get('/api/accounts/pick', async (c) => c.json(await b.pickAccount()))
  app.get('/api/external/sessions', async (c) => c.json(await b.externalSessions()))
  // One session by id, however old (the list only holds the last day's): a search hit opens with it.
  app.get('/api/external/sessions/:id', (c) => guarded(c, b, async () => c.json(await b.externalSession(c.req.param('id')))))
  app.get('/api/external/sessions/:id/items', (c) => guarded(c, b, async () => c.json(await b.externalItems(c.req.param('id')))))
  app.post('/api/external/sessions/:id/message', (c) => desktopMessage(c, b))
  app.post('/api/external/sessions/:id/branch', (c) => branchSession(c, b))
  app.get('/api/search', (c) => search(c, b))
  app.get('/api/climayte/workers', (c) => {
    const all = c.req.query('all')
    return guarded(c, b, async () => c.json(await b.workers({ all: all === '1' || all === 'true' })))
  })
  // HSwarm's running jobs and newest finished ones, for debugging: the window gets them in the poller's swarm.update event.
  app.get('/api/swarm/jobs', async (c) => c.json(await b.swarmJobs()))
  app.post('/api/climayte/workers/:id/cancel', (c) =>
    guarded(c, b, async () => {
      await b.cancelWorker(c.req.param('id'))
      return c.json({ ok: true })
    }),
  )
  app.post('/api/climayte/workers/:id/send', (c) => sendToWorker(c, b))
  app.get('/api/cloud/sessions', (c) => cloudSessions(c, b))
  app.get('/api/cloud/instances', (c) => guarded(c, b, async () => c.json((await b.client.desktopInstances()).map(toCloudInstance))))
  app.get('/api/stats/home', (c) => homeStats(c, b))

  startPoller(ctx, b)
}
