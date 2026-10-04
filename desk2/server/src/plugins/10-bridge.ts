// The bridge's REST routes (SPEC.md REST rows for bridge/status, accounts, external, climayte) and the
// poller that keeps open windows current. ctx.deps may carry `bridge` (a ready fake), `hydraUrl` (another
// AgentHydra, for tests) and `bridgePollMs` / `bridgeAccountsPollMs` (faster polls in tests).

import { hostname } from 'node:os'
import type { Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { CloudList } from '@shared/protocol'
import type { ServerContext } from '../context'
import { type Bridge, BridgeError, bridge, configureBridge } from '../bridge'
import { type AhCloudRow, CLOUD_TIMEOUT_MS, cloudQuery, toCloudInstance, toCloudSession } from '../bridge/cloud'
import { createPoller } from '../bridge/poller'
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_MIN_CHARS } from '../bridge/search'

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

export default function plugin(app: Hono, ctx: ServerContext): void {
  const b = pickBridge(ctx.deps)

  app.get('/api/bridge/status', async (c) => c.json(await b.status()))
  app.get('/api/accounts', async (c) => {
    try {
      return c.json(await b.listAccounts())
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.get('/api/accounts/pick', async (c) => c.json(await b.pickAccount()))
  app.get('/api/external/sessions', async (c) => c.json(await b.externalSessions()))
  // One session by id, however old (the list only holds the last day's): a search hit opens with it.
  app.get('/api/external/sessions/:id', async (c) => {
    try {
      return c.json(await b.externalSession(c.req.param('id')))
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.get('/api/external/sessions/:id/items', async (c) => {
    try {
      return c.json(await b.externalItems(c.req.param('id')))
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.get('/api/search', async (c) => {
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
  })
  app.get('/api/climayte/workers', async (c) => {
    const all = c.req.query('all')
    try {
      return c.json(await b.workers({ all: all === '1' || all === 'true' }))
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.post('/api/climayte/workers/:id/cancel', async (c) => {
    try {
      await b.cancelWorker(c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.post('/api/climayte/workers/:id/send', async (c) => {
    let text: unknown
    try {
      text = ((await c.req.json()) as { text?: unknown })?.text
    } catch {
      return c.json({ error: 'the body must be JSON: { "text": "..." }' }, 400)
    }
    if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text is required' }, 400)
    try {
      await b.sendToWorker(c.req.param('id'), text)
      return c.json({ ok: true })
    } catch (err) {
      return fail(c, b, err)
    }
  })

  // Desk 2's cloud list: AgentHydra's whole session list, both PCs' chats (bridge/cloud.ts).
  app.get('/api/cloud/sessions', async (c) => {
    try {
      const rows = await b.client.get<AhCloudRow[]>(`/api/sessions?${cloudQuery((k) => c.req.query(k))}`, CLOUD_TIMEOUT_MS)
      return c.json({ thisPc: hostname(), sessions: rows.map(toCloudSession) } satisfies CloudList)
    } catch (err) {
      return fail(c, b, err)
    }
  })
  app.get('/api/cloud/instances', async (c) => {
    try {
      return c.json((await b.client.desktopInstances()).map(toCloudInstance))
    } catch (err) {
      return fail(c, b, err)
    }
  })

  const poller = createPoller({
    bridge: b,
    broadcast: ctx.broadcast,
    wsClientCount: ctx.wsClientCount,
    fastMs: typeof ctx.deps.bridgePollMs === 'number' ? ctx.deps.bridgePollMs : undefined,
    accountsMs: typeof ctx.deps.bridgeAccountsPollMs === 'number' ? ctx.deps.bridgeAccountsPollMs : undefined,
  })
  poller.start()
  ctx.onStop(poller.stop)
}
