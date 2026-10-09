// Desk's own MCP servers (devservers, redesign) over HTTP, from Desk's process, instead of one stdio child per chat.
// Measured 2026-10-09 with 19 chats open: 19 bun processes of devservers/mcp.ts and 19 of redesign-mcp.ts, about 85 MB
// each (3.2 GB together), every one a thin proxy that called back into Desk or ReDesign over loopback anyway. A chat
// now gets `{ type: 'http', url }` and they all share Desk's handler: no process per chat at all.
//
// The transport is MCP's Streamable HTTP, the stateless subset: POST one JSON-RPC message (or a batch); a request is
// answered as JSON, or as an SSE stream when the client accepts one, so a long tools/call (design_options) can send
// its notifications/progress before the result. Notifications alone get 202. There is no server-to-client stream, so
// GET is 405. Only a local client that is not a browser page may call it: a page sends Origin or Sec-Fetch headers.

export interface RpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface McpHandler {
  handle(msg: RpcMessage, notify?: (m: unknown) => void): Promise<unknown | null>
}

/** Why a request may not reach an MCP route, or null: browser pages are refused, local tools are not. */
export function notLocalTool(headers: Headers): string | null {
  if (headers.get('origin')) return 'a browser page may not call Desk MCP servers'
  let page = false
  headers.forEach((_, h) => {
    if (h.startsWith('sec-fetch-')) page = true
  })
  return page ? 'a browser page may not call Desk MCP servers' : null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** One Streamable-HTTP request to `server`. */
export async function serveMcpHttp(req: Request, server: McpHandler): Promise<Response> {
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (req.method === 'DELETE') return new Response(null, { status: 200 })
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const why = notLocalTool(req.headers)
  if (why) return json({ error: why }, 403)
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400)
  }
  const batch = Array.isArray(body)
  const msgs = (batch ? body : [body]) as RpcMessage[]
  const requests = msgs.filter((m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null)
  if (!requests.length) {
    for (const m of msgs) if (m && typeof m === 'object' && typeof m.method === 'string') void server.handle(m).catch(() => undefined)
    return new Response(null, { status: 202 })
  }
  const streams = (req.headers.get('accept') ?? '').includes('text/event-stream')
  if (!streams) {
    const replies = (await Promise.all(requests.map((m) => server.handle(m)))).filter((r) => r !== null)
    return json(batch ? replies : replies[0])
  }
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (m: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`))
        } catch {
          // floor-ok: the client went away; the handler finishes on its own
        }
      }
      await Promise.all(
        requests.map((m) =>
          server
            .handle(m, send)
            .then((r) => r !== null && send(r))
            .catch((err) => send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }))
        )
      )
      controller.close()
    }
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}
