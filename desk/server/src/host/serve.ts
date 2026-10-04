// A chat host's websocket (SPEC "Chat hosts"): one port on 127.0.0.1 that only a client naming the host's token
// and sending no Origin (a browser page always sends one) may open. Each connection is a server attached to the
// host's core; a newer one replaces an older.

import type { HostCore, ServerLink } from './core'
import type { ServerMessage } from './protocol'

/** Frames carry whole SDK messages and pasted images: far past Bun's 16 MB default. */
const MAX_FRAME = 512 * 1024 * 1024

export function serveHost(core: HostCore, token: string) {
  const links = new WeakMap<object, ServerLink>()
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const given = new URL(req.url).searchParams.get('token')
      if (req.headers.get('origin') || given !== token) return new Response('forbidden', { status: 403 })
      if (srv.upgrade(req, { data: undefined })) return undefined
      return new Response('expected a websocket upgrade', { status: 426 })
    },
    websocket: {
      maxPayloadLength: MAX_FRAME,
      // An idle chat sends nothing for hours: the connection must not time out under it.
      idleTimeout: 0,
      open(ws) {
        const link: ServerLink = {
          send: (msg) => {
            ws.send(JSON.stringify(msg))
          },
          close: () => ws.close(),
        }
        links.set(ws, link)
        core.attach(link)
      },
      message(ws, data) {
        const link = links.get(ws)
        if (!link) return
        let msg: ServerMessage
        try {
          msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as ServerMessage
        } catch {
          return
        }
        core.receive(msg, link)
      },
      close(ws) {
        const link = links.get(ws)
        if (link) core.detach(link)
      },
    },
  })
}
