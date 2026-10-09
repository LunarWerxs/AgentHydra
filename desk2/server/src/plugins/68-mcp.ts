// POST /mcp/devservers?cwd=<chat folder>, /mcp/redesign and /mcp/browser?chat=&worker=&cwd=: the chats' devservers,
// redesign and browser MCP servers, served
// from Desk's process over Streamable HTTP (connectors/mcp-http.ts) instead of a bun child per chat. connectors/defs/
// devwebui.ts and redesign.ts hand a chat these URLs. localOnly (index.ts) runs first; mcp-http refuses browser pages.

import { join } from 'node:path'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { type McpHandler, serveMcpHttp } from '../connectors/mcp-http'
import { runningRedesignUrl } from '../connectors/defs/redesign'
import { createRedesignMcp } from '../connectors/redesign-mcp'
import { createDevServersMcp } from '../devservers/mcp'
import { createBrowserAgentClient } from '../browser/agent/client'
import { createBrowserMcp } from '../browser/agent/mcp'
import type { ToolCaller } from '../browser/agent/contract'
import { callerSession } from '../browser/agent/caller-session'
import { type Bridge, bridge } from '../bridge'

/** The address of Desk itself, which the devservers tools call at /dw/api. */
const deskUrl = () => `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`

export default function plugin(app: Hono, ctx: ServerContext): void {
  // One handler per chat folder (the tools' default cwd) and one per ReDesign address: each is a few closures.
  const dev = new Map<string, McpHandler>()
  const redesign = new Map<string, McpHandler>()
  const outDir = join(ctx.home, 'design-options')
  const browserClient = createBrowserAgentClient({ home: ctx.home })
  const workersCache = { at: 0, list: [] as readonly { id: string; sessionId: string | null }[] }
  const cachedWorkers = async () => {
    if (Date.now() - workersCache.at > 5_000) {
      const b = (ctx.deps.bridge as Bridge | undefined) ?? bridge()
      workersCache.list = await b.workers({ all: true }).catch(() => [])
      workersCache.at = Date.now()
    }
    return workersCache.list
  }

  app.all('/mcp/browser', async (c) => {
    const chat = c.req.query('chat')?.trim() || undefined
    const worker = c.req.query('worker')?.trim() || undefined
    const session = await callerSession(
      { chat, worker },
      {
        chatSessions: (id) => (ctx.deps.chatSessions as ((id: string) => string[]) | undefined)?.(id) ?? [],
        workers: cachedWorkers,
      },
    )
    const caller: ToolCaller = { chat, worker, cwd: c.req.query('cwd')?.trim() || undefined, session }
    return serveMcpHttp(c.req.raw, createBrowserMcp({ client: browserClient, caller }))
  })

  app.all('/mcp/devservers', (c) => {
    const cwd = c.req.query('cwd')?.trim() || ''
    let server = dev.get(cwd)
    if (!server) {
      server = createDevServersMcp({ deskUrl: deskUrl(), defaultCwd: cwd || undefined })
      if (dev.size > 500) dev.clear()
      dev.set(cwd, server)
    }
    return serveMcpHttp(c.req.raw, server)
  })

  app.all('/mcp/redesign', async (c) => {
    // The chat's config carries the address ReDesign answered at when the chat started (only a loopback one is
    // taken); without it, one probe finds it.
    const given = c.req.query('url')?.trim() ?? ''
    const url = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(given)
      ? given
      : ((await runningRedesignUrl()) ?? `http://127.0.0.1:${process.env.PORT?.trim() || 5178}`)
    let server = redesign.get(url)
    if (!server) {
      server = createRedesignMcp({ baseUrl: url, outDir })
      redesign.set(url, server)
    }
    return serveMcpHttp(c.req.raw, server)
  })
}
