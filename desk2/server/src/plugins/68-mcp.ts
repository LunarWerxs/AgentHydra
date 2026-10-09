// POST /mcp/devservers?cwd=<chat folder> and POST /mcp/redesign: the chats' devservers and redesign MCP servers, served
// from Desk's process over Streamable HTTP (connectors/mcp-http.ts) instead of a bun child per chat. connectors/defs/
// devwebui.ts and redesign.ts hand a chat these URLs. localOnly (index.ts) runs first; mcp-http refuses browser pages.

import { join } from 'node:path'
import type { Hono } from 'hono'
import type { ServerContext } from '../context'
import { type McpHandler, serveMcpHttp } from '../connectors/mcp-http'
import { runningRedesignUrl } from '../connectors/defs/redesign'
import { createRedesignMcp } from '../connectors/redesign-mcp'
import { createDevServersMcp } from '../devservers/mcp'

/** The address of Desk itself, which the devservers tools call at /dw/api. */
const deskUrl = () => `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`

export default function plugin(app: Hono, ctx: ServerContext): void {
  // One handler per chat folder (the tools' default cwd) and one per ReDesign address: each is a few closures.
  const dev = new Map<string, McpHandler>()
  const redesign = new Map<string, McpHandler>()
  const outDir = join(ctx.home, 'design-options')

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
